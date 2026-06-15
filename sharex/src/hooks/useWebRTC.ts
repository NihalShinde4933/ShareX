'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { db } from '../lib/db';
import { deriveKey } from '../utils/crypto';

interface UseWebRTCOptions {
    socketRef: React.MutableRefObject<WebSocket | null>;
    targetPeerIdRef: React.MutableRefObject<string>;
    setStatusMessage: (msg: string) => void;
}

export function useWebRTC({ socketRef, targetPeerIdRef, setStatusMessage }: UseWebRTCOptions) {
    // FIX: Separate RTCPeerConnection refs for sender and receiver.
    //
    // Root cause of "setRemoteDescription called in wrong state: stable":
    //   Previously a single peerConnectionRef was shared between both roles.
    //   When initializeReceiver ran it overwrote the ref. Then when the sender's
    //   'answer' arrived via handleIncomingSignal it read the ref and called
    //   setRemoteDescription on the RECEIVER's already-stable PC instead of the
    //   sender's PC, which correctly expected an answer in 'have-local-offer' state.
    //
    // Fix: senderPCRef only ever holds the sender's PC. receiverPCRef only ever
    // holds the receiver's PC. handleIncomingSignal routes by signal type and role.
    const senderPCRef = useRef<RTCPeerConnection | null>(null);
    const receiverPCRef = useRef<RTCPeerConnection | null>(null);
    const dataChannelRef = useRef<RTCDataChannel | null>(null);

    const [receivedChunks, setReceivedChunks] = useState<ArrayBuffer[]>([]);
    const currentFileHashRef = useRef<string>("");

    // Separate ICE candidate queues — candidates can arrive for either role
    // before the corresponding PC has a remote description set
    const senderICEQueueRef = useRef<RTCIceCandidateInit[]>([]);
    const receiverICEQueueRef = useRef<RTCIceCandidateInit[]>([]);

    const rtcConfig: RTCConfiguration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };

    const sendSignal = useCallback((signalData: any, customTargetId?: string) => {
        const target = customTargetId || targetPeerIdRef.current;
        if (socketRef.current?.readyState === WebSocket.OPEN && target) {
            socketRef.current.send(JSON.stringify({
                action: "RELAY_SIGNAL",
                targetId: target,
                signalData
            }));
        }
    }, [socketRef, targetPeerIdRef]);

    /**
     * Parses "CHUNK:<index>:<payload>" by scanning for colons at the byte level.
     * Avoids the previous fixed 30-byte slice which misread headers for large indices.
     */
    function parseChunkPacket(buf: ArrayBuffer): { chunkIndex: number; payload: ArrayBuffer } | null {
        const view = new Uint8Array(buf);
        const colons: number[] = [];
        for (let i = 0; i < Math.min(view.length, 64); i++) {
            if (view[i] === 58) { // ASCII ':'
                colons.push(i);
                if (colons.length === 2) break;
            }
        }
        if (colons.length < 2) return null;
        const idx = parseInt(new TextDecoder().decode(view.slice(colons[0] + 1, colons[1])), 10);
        if (isNaN(idx)) return null;
        return { chunkIndex: idx, payload: buf.slice(colons[1] + 1) };
    }

    /**
     * SENDER: Creates an offer, opens a data channel, and on open:
     *   1. Sends the uploadSalt (same one used to encrypt DB chunks) as the FIRST
     *      unencrypted binary message so the receiver can derive the matching key.
     *   2. Streams all CHUNK-framed packets from IndexedDB.
     *   3. Sends "__EOF__".
     *
     * The uploadSalt is passed in from page.tsx where it was generated at encrypt time.
     * This is the critical correctness requirement: both sides must derive from the
     * same salt. Previously a fresh random salt was generated here — that produced a
     * different key than the one used to encrypt, so decryption always failed.
     */
    const initializeSender = useCallback(async (
        fileHash: string,
        passphrase: string,
        uploadSalt: Uint8Array          // ← same salt used during encryption
    ) => {
        try {
            currentFileHashRef.current = fileHash;
            setStatusMessage("Initializing sender...");
            senderICEQueueRef.current = [];
            senderPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            senderPCRef.current = pc;

            const dc = pc.createDataChannel("sharex-file-pipe", { ordered: true });
            dataChannelRef.current = dc;

            dc.onopen = async () => {
                setStatusMessage("🔒 Channel open. Sending salt and chunks...");

                // Send the same salt that was used to encrypt so receiver can derive key
                dc.send(new Uint8Array(uploadSalt));

                const chunks = await db.fileChunks
                    .where("fileHash")
                    .equals(currentFileHashRef.current)
                    .sortBy("chunkIndex");

                if (chunks.length === 0) {
                    setStatusMessage("⚠️ No chunks found in IndexedDB. Did encryption finish?");
                    return;
                }

                for (let i = 0; i < chunks.length; i++) {
                    const header = new TextEncoder().encode(`CHUNK:${i}:`);
                    const data = new Uint8Array(chunks[i].data);
                    const packet = new Uint8Array(header.byteLength + data.byteLength);
                    packet.set(header, 0);
                    packet.set(data, header.byteLength);
                    // dc.send(packet.buffer);
                    dc.send(packet); 
                }

                dc.send("__EOF__");
                setStatusMessage("✅ All chunks transmitted!");
            };

            // Tag sender ICE candidates with role:'sender' so the receiver's
            // handleIncomingSignal can route them to the correct PC
            pc.onicecandidate = (e) => {
                if (e.candidate) sendSignal({ type: 'candidate', candidate: e.candidate, role: 'sender' });
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignal({ type: 'offer', sdp: offer.sdp });

        } catch (err) {
            console.error("Sender init error:", err);
            setStatusMessage("Failed to initialize sender.");
        }
    }, [sendSignal, setStatusMessage]);

    /**
     * RECEIVER: Accepts the SDP offer, creates an answer.
     * First binary message on the data channel is the 16-byte salt from the sender.
     * Uses it to derive the AES key, then decrypts all incoming CHUNK payloads on __EOF__.
     */
    const initializeReceiver = useCallback(async (
        remoteOfferSDP: string,
        passphrase: string,
        senderId?: string
    ) => {
        try {
            setStatusMessage("Assembling receiver...");
            receiverICEQueueRef.current = [];
            receiverPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            receiverPCRef.current = pc;

            // Tag receiver ICE candidates with role:'receiver' for routing
            pc.onicecandidate = (e) => {
                if (e.candidate) sendSignal({ type: 'candidate', candidate: e.candidate, role: 'receiver' }, senderId);
            };

            pc.ondatachannel = (event) => {
                dataChannelRef.current = event.channel;
                event.channel.binaryType = "arraybuffer";

                let saltReceived = false;
                let derivedKey: CryptoKey | null = null;
                const buffer: { index: number; binary: ArrayBuffer }[] = [];

                event.channel.onmessage = async (msg) => {
                    // First binary message = 16-byte salt
                    if (!saltReceived && msg.data instanceof ArrayBuffer) {
                        const salt = new Uint8Array(msg.data);
                        if (salt.byteLength === 16) {
                            derivedKey = await deriveKey(passphrase, salt);
                            saltReceived = true;
                            setStatusMessage("🔑 Key derived. Receiving chunks...");
                            return;
                        }
                    }

                    if (typeof msg.data === "string" && msg.data === "__EOF__") {
                        if (!derivedKey) {
                            setStatusMessage("❌ No decryption key — was salt received?");
                            return;
                        }
                        setStatusMessage("📦 Transfer complete. Decrypting...");
                        buffer.sort((a, b) => a.index - b.index);
                        try {
                            const decrypted = await Promise.all(
                                buffer.map(async ({ binary }) => {
                                    const view = new Uint8Array(binary);
                                    const iv = view.slice(0, 12);          // first 12 bytes = IV
                                    const payload = view.slice(12);        // rest = ciphertext
                                    return await window.crypto.subtle.decrypt(
                                        { name: 'AES-GCM', iv },
                                        derivedKey!,
                                        payload
                                    );
                                })
                            );
                            setReceivedChunks(decrypted);
                        } catch (err) {
                            console.error("Decryption error:", err);
                            setStatusMessage("❌ Decryption failed. Wrong passphrase?");
                        }
                        return;
                    }

                    if (msg.data instanceof ArrayBuffer) {
                        const parsed = parseChunkPacket(msg.data);
                        if (parsed) {
                            buffer.push({ index: parsed.chunkIndex, binary: parsed.payload });
                            setStatusMessage(`Receiving... ${buffer.length} chunks cached`);
                        }
                    }
                };
            };

            // 1. Apply remote offer
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: remoteOfferSDP }));

            // 2. Flush any ICE candidates that arrived before remote description was set
            console.log(`🧹 Flushing ${receiverICEQueueRef.current.length} queued receiver candidates`);
            for (const c of receiverICEQueueRef.current) {
                await pc.addIceCandidate(new RTCIceCandidate(c));
            }
            receiverICEQueueRef.current = [];

            // 3. Answer
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal({ type: 'answer', sdp: answer.sdp }, senderId);

        } catch (err) {
            console.error("Receiver init error:", err);
            setStatusMessage("Failed to initialize receiver.");
        }
    }, [sendSignal, setStatusMessage]);

    /**
     * Routes incoming 'answer' and 'candidate' signals to the correct PC.
     *
     * answer  → always goes to senderPCRef (it made the offer)
     * candidate → routed by signal.role:
     *     role:'receiver' means the RECEIVER sent this candidate → applies to senderPCRef
     *     role:'sender'   means the SENDER sent this candidate  → applies to receiverPCRef
     *
     * FIX: The signalingState guard on the answer path prevents the
     * "setRemoteDescription called in wrong state: stable" error that occurred
     * when the signal was received a second time or echoed back.
     */
    const handleIncomingSignal = useCallback(async (signal: any) => {
        try {
            if (signal.type === 'answer') {
                const pc = senderPCRef.current;
                if (!pc) {
                    console.warn("Received answer but senderPCRef is null — ignoring.");
                    return;
                }
                // Guard: only apply answer in the correct signaling state
                if (pc.signalingState !== 'have-local-offer') {
                    console.warn(`Ignoring answer — signalingState is '${pc.signalingState}', expected 'have-local-offer'`);
                    return;
                }
                await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));

            } else if (signal.type === 'candidate' && signal.candidate) {
                // role:'receiver' → candidate is FROM the receiver → applies to sender's PC
                // role:'sender'   → candidate is FROM the sender   → applies to receiver's PC
                const isFromReceiver = signal.role === 'receiver';
                const targetPC = isFromReceiver ? senderPCRef.current : receiverPCRef.current;
                const queue = isFromReceiver ? senderICEQueueRef : receiverICEQueueRef;

                if (!targetPC) return;

                if (!targetPC.remoteDescription) {
                    console.log(`⏳ Queuing ICE candidate (from ${signal.role ?? 'unknown'})`);
                    queue.current.push(signal.candidate);
                } else {
                    await targetPC.addIceCandidate(new RTCIceCandidate(signal.candidate));
                }
            }
        } catch (err) {
            console.error("Signal processing error:", err);
        }
    }, []);

    useEffect(() => {
        return () => {
            dataChannelRef.current?.close();
            senderPCRef.current?.close();
            receiverPCRef.current?.close();
        };
    }, []);

    return { initializeSender, initializeReceiver, handleIncomingSignal, receivedChunks, setReceivedChunks };
}

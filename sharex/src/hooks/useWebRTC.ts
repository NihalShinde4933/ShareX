'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { db } from '../lib/db';
import { deriveKey } from '../utils/crypto';
import { rtcConfig } from '../utils/webrtc';

interface UseWebRTCOptions {
    // sendSignal comes from useSignaling — one place owns the WebSocket
    sendSignal: (targetId: string, signalData: any) => void;
    setStatusMessage: (msg: string) => void;
}

export function useWebRTC({ sendSignal, setStatusMessage }: UseWebRTCOptions) {
    // Separate RTCPeerConnection refs for each role so signals are never
    // applied to the wrong connection (was the cause of "wrong state: stable").
    const senderPCRef   = useRef<RTCPeerConnection | null>(null);
    const receiverPCRef = useRef<RTCPeerConnection | null>(null);

    const [receivedChunks, setReceivedChunks] = useState<ArrayBuffer[]>([]);

    // ICE candidates can arrive before setRemoteDescription completes — queue them
    const senderICEQueue   = useRef<RTCIceCandidateInit[]>([]);
    const receiverICEQueue = useRef<RTCIceCandidateInit[]>([]);

    // Keep sendSignal stable inside callbacks via ref
    const sendSignalRef = useRef(sendSignal);
    useEffect(() => { sendSignalRef.current = sendSignal; }, [sendSignal]);

    /** Parse "CHUNK:<index>:<payload>" by scanning for colons at the byte level. */
    function parseChunkPacket(buf: ArrayBuffer): { chunkIndex: number; payload: ArrayBuffer } | null {
        const view = new Uint8Array(buf);
        const colons: number[] = [];
        for (let i = 0; i < Math.min(view.length, 64); i++) {
            if (view[i] === 58) { colons.push(i); if (colons.length === 2) break; }
        }
        if (colons.length < 2) return null;
        const idx = parseInt(new TextDecoder().decode(view.slice(colons[0] + 1, colons[1])), 10);
        return isNaN(idx) ? null : { chunkIndex: idx, payload: buf.slice(colons[1] + 1) };
    }

    // ── SENDER ────────────────────────────────────────────────────────────────

    /**
     * Called on the UPLOADER's machine when server sends DOWNLOADER_FOUND.
     *
     * Salt flow:
     *   uploadSalt was generated in page.tsx at encrypt time and stored in a ref.
     *   We send it here as the FIRST unencrypted binary message so the receiver
     *   can call deriveKey(passphrase, salt) and get the identical AES-GCM key.
     *   Never generate a new salt here — that would mismatch the stored chunks.
     */
    const initializeSender = useCallback(async (
        fileHash: string,
        passphrase: string,
        uploadSalt: Uint8Array,
        targetId: string          // downloaderSocketId from DOWNLOADER_FOUND
    ) => {
        try {
            console.log(`🚀 initializeSender → target=${targetId} hash=${fileHash}`);
            setStatusMessage("Initializing sender...");
            senderICEQueue.current = [];
            senderPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            senderPCRef.current = pc;

            const dc = pc.createDataChannel("sharex-file-pipe", { ordered: true });

            dc.onopen = async () => {
                setStatusMessage("🔒 Channel open. Streaming file...");

                // 1. Send salt first (unencrypted, exactly 16 bytes)
                dc.send(new Uint8Array(uploadSalt));

                // 2. Stream encrypted chunks from IndexedDB
                const chunks = await db.fileChunks
                    .where("fileHash").equals(fileHash)
                    .sortBy("chunkIndex");

                if (chunks.length === 0) {
                    setStatusMessage("⚠️ No chunks in DB. Did encryption finish?");
                    return;
                }

                for (let i = 0; i < chunks.length; i++) {
                    const header = new TextEncoder().encode(`CHUNK:${i}:`);
                    const body   = new Uint8Array(chunks[i].data);
                    const packet = new Uint8Array(header.byteLength + body.byteLength);
                    packet.set(header, 0);
                    packet.set(body, header.byteLength);
                    dc.send(packet);   // send Uint8Array directly — avoids ArrayBufferLike error
                }

                dc.send("__EOF__");
                setStatusMessage("✅ All chunks sent!");
            };

            dc.onerror = (e) => console.error("DataChannel error:", e);

            // Tag sender ICE candidates with role:'sender' so the receiver-side
            // handleIncomingSignal routes them to the right RTCPeerConnection
            pc.onicecandidate = (e) => {
                if (e.candidate) {
                    sendSignalRef.current(targetId, {
                        type: 'candidate',
                        candidate: e.candidate,
                        role: 'sender'
                    });
                }
            };

            pc.onconnectionstatechange = () => {
                console.log("Sender state:", pc.connectionState);
                if (pc.connectionState === 'failed') setStatusMessage("❌ Connection failed.");
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignalRef.current(targetId, { type: 'offer', sdp: offer.sdp });
            setStatusMessage("📡 Offer sent. Waiting for answer...");

        } catch (err) {
            console.error("initializeSender error:", err);
            setStatusMessage("Failed to start sender.");
        }
    }, [setStatusMessage]);

    // ── RECEIVER ──────────────────────────────────────────────────────────────

    /**
     * Called on the DOWNLOADER's machine when a SIGNAL{type:'offer'} arrives.
     *
     * First binary message = 16-byte salt → derive AES key.
     * All subsequent binary messages = CHUNK packets.
     * "__EOF__" string → sort, decrypt, set receivedChunks.
     */
    const initializeReceiver = useCallback(async (
        remoteOfferSDP: string,
        passphrase: string,
        senderId: string          // uploaderSocketId — reply signals go here
    ) => {
        try {
            console.log(`📥 initializeReceiver ← offer from ${senderId}`);
            setStatusMessage("Connecting to sender...");
            receiverICEQueue.current = [];
            receiverPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            receiverPCRef.current = pc;

            pc.onicecandidate = (e) => {
                if (e.candidate) {
                    sendSignalRef.current(senderId, {
                        type: 'candidate',
                        candidate: e.candidate,
                        role: 'receiver'
                    });
                }
            };

            pc.onconnectionstatechange = () => {
                console.log("Receiver state:", pc.connectionState);
                if (pc.connectionState === 'connected') setStatusMessage("🔗 Connected! Receiving data...");
                if (pc.connectionState === 'failed')    setStatusMessage("❌ Connection failed.");
            };

            pc.ondatachannel = (event) => {
                const ch = event.channel;
                ch.binaryType = "arraybuffer";

                let saltReceived = false;
                let derivedKey: CryptoKey | null = null;
                const buffer: { index: number; binary: ArrayBuffer }[] = [];

                ch.onmessage = async (msg) => {

                    // First binary message = 16-byte salt
                    if (!saltReceived && msg.data instanceof ArrayBuffer) {
                        const bytes = new Uint8Array(msg.data);
                        if (bytes.byteLength === 16) {
                            derivedKey = await deriveKey(passphrase, bytes);
                            saltReceived = true;
                            setStatusMessage("🔑 Key ready. Receiving chunks...");
                            return;
                        }
                    }

                    // EOF → decrypt all buffered chunks
                    if (typeof msg.data === "string" && msg.data === "__EOF__") {
                        if (!derivedKey) {
                            setStatusMessage("❌ Missing decryption key.");
                            return;
                        }
                        setStatusMessage(`📦 ${buffer.length} chunks received. Decrypting...`);
                        buffer.sort((a, b) => a.index - b.index);
                        try {
                            const decrypted = await Promise.all(
                                buffer.map(({ binary }) => {
                                    const v  = new Uint8Array(binary);
                                    const iv = v.slice(0, 12);
                                    const ct = v.slice(12);
                                    return window.crypto.subtle.decrypt(
                                        { name: 'AES-GCM', iv },
                                        derivedKey!,
                                        ct
                                    );
                                })
                            );
                            setReceivedChunks(decrypted);
                        } catch (err) {
                            console.error("Decryption failed:", err);
                            setStatusMessage("❌ Decryption failed — wrong passphrase?");
                        }
                        return;
                    }

                    // CHUNK packet
                    if (msg.data instanceof ArrayBuffer) {
                        const parsed = parseChunkPacket(msg.data);
                        if (parsed) {
                            buffer.push({ index: parsed.chunkIndex, binary: parsed.payload });
                            setStatusMessage(`Receiving... ${buffer.length} chunks`);
                        }
                    }
                };
            };

            // Apply offer
            await pc.setRemoteDescription(
                new RTCSessionDescription({ type: 'offer', sdp: remoteOfferSDP })
            );

            // Flush any ICE candidates that arrived before setRemoteDescription
            console.log(`🧹 Flushing ${receiverICEQueue.current.length} queued receiver candidates`);
            for (const c of receiverICEQueue.current) {
                await pc.addIceCandidate(new RTCIceCandidate(c));
            }
            receiverICEQueue.current = [];

            // Send answer
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignalRef.current(senderId, { type: 'answer', sdp: answer.sdp });
            setStatusMessage("📡 Answer sent. Establishing connection...");

        } catch (err) {
            console.error("initializeReceiver error:", err);
            setStatusMessage("Failed to connect to sender.");
        }
    }, [setStatusMessage]);

    // ── Signal router ─────────────────────────────────────────────────────────

    /**
     * Routes answer/candidate signals to the correct RTCPeerConnection.
     *
     * answer            → senderPCRef  (sender created the offer, expects answer)
     * candidate role:'receiver' → FROM downloader → add to senderPC
     * candidate role:'sender'   → FROM uploader   → add to receiverPC
     *
     * The signalingState guard prevents "wrong state: stable" if a signal arrives
     * late or is duplicated by the signaling layer.
     */
    const handleIncomingSignal = useCallback(async (signal: any) => {
        try {
            if (signal.type === 'answer') {
                const pc = senderPCRef.current;
                if (!pc) { console.warn("answer arrived but no senderPC"); return; }
                if (pc.signalingState !== 'have-local-offer') {
                    console.warn(`Ignoring answer — signalingState='${pc.signalingState}'`);
                    return;
                }
                await pc.setRemoteDescription(
                    new RTCSessionDescription({ type: 'answer', sdp: signal.sdp })
                );
                console.log("✅ Answer applied to senderPC");

            } else if (signal.type === 'candidate' && signal.candidate) {
                const fromReceiver = signal.role === 'receiver';
                const pc    = fromReceiver ? senderPCRef.current   : receiverPCRef.current;
                const queue = fromReceiver ? senderICEQueue         : receiverICEQueue;

                if (!pc) { console.warn(`No PC for candidate role=${signal.role}`); return; }

                if (!pc.remoteDescription) {
                    console.log(`⏳ Queuing ICE candidate (role=${signal.role})`);
                    queue.current.push(signal.candidate);
                } else {
                    await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                }
            }
        } catch (err) {
            console.error("handleIncomingSignal error:", err);
        }
    }, []);

    useEffect(() => () => {
        senderPCRef.current?.close();
        receiverPCRef.current?.close();
    }, []);

    return { initializeSender, initializeReceiver, handleIncomingSignal, receivedChunks };
}
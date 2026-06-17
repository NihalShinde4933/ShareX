'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { db } from '../lib/db';
import { deriveKey } from '../utils/crypto';
import { rtcConfig } from '../utils/webrtc';

interface UseWebRTCOptions {
    sendSignal: (targetId: string, signalData: any) => void;
    setStatusMessage: (msg: string) => void;
}

// ── Typed packet protocol ─────────────────────────────────────────────────────
//
//  0x01 COUNT  [1][4 bytes uint32 total chunks]
//  0x02 SALT   [1][16 bytes salt]
//  0x03 CHUNK  [1][4 bytes uint32 index][12 bytes IV][ciphertext]
//  0x04 EOF    [1]
//  0x05 READY  [1]   receiver → sender: "file is open, key is ready, send chunks"
//
// The READY handshake is what prevents "chunk arrived before key was ready":
//   Sender  →  COUNT, SALT, then STOPS and waits
//   Receiver→  derives key, opens save picker, sends READY
//   Sender  →  only now starts streaming CHUNK packets
//
const TYPE_COUNT = 0x01;
const TYPE_SALT  = 0x02;
const TYPE_CHUNK = 0x03;
const TYPE_EOF   = 0x04;
const TYPE_READY = 0x05;

// ── Packet builders ───────────────────────────────────────────────────────────
// new Uint8Array(n) always allocates a plain ArrayBuffer, never SharedArrayBuffer,
// so "as Uint8Array<ArrayBuffer>" is a safe cast that satisfies dc.send() and
// crypto.subtle strict TypeScript overloads.

function makeCountPacket(total: number): Uint8Array<ArrayBuffer> {
    const p = new Uint8Array(5) as Uint8Array<ArrayBuffer>;
    p[0] = TYPE_COUNT;
    p[1] = (total >> 24) & 0xFF; p[2] = (total >> 16) & 0xFF;
    p[3] = (total >>  8) & 0xFF; p[4] =  total        & 0xFF;
    return p;
}

function makeSaltPacket(salt: Uint8Array): Uint8Array<ArrayBuffer> {
    const p = new Uint8Array(1 + salt.byteLength) as Uint8Array<ArrayBuffer>;
    p[0] = TYPE_SALT;
    p.set(new Uint8Array(salt), 1);
    return p;
}

function makeChunkPacket(idx: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
    const p = new Uint8Array(5 + body.byteLength) as Uint8Array<ArrayBuffer>;
    p[0] = TYPE_CHUNK;
    p[1] = (idx >> 24) & 0xFF; p[2] = (idx >> 16) & 0xFF;
    p[3] = (idx >>  8) & 0xFF; p[4] =  idx        & 0xFF;
    p.set(new Uint8Array(body), 5);
    return p;
}

function makeEOFPacket():   Uint8Array<ArrayBuffer> {
    return new Uint8Array([TYPE_EOF])   as Uint8Array<ArrayBuffer>;
}
function makeReadyPacket(): Uint8Array<ArrayBuffer> {
    return new Uint8Array([TYPE_READY]) as Uint8Array<ArrayBuffer>;
}

// buffer.slice() always returns a plain ArrayBuffer (never SharedArrayBuffer).
// Use this instead of Uint8Array.slice()/subarray() when the result must satisfy
// crypto.subtle or dc.send strict TypeScript overloads.
function copyBuf(u8: Uint8Array, start: number, end?: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(
        u8.buffer.slice(u8.byteOffset + start, end !== undefined ? u8.byteOffset + end : undefined)
    ) as Uint8Array<ArrayBuffer>;
}

// ── Backpressure thresholds ───────────────────────────────────────────────────
const BUFFER_HIGH = 8 * 1024 * 1024;   // 8 MB — pause above this
const BUFFER_LOW  = 2 * 1024 * 1024;   // 2 MB — resume below this

export function useWebRTC({ sendSignal, setStatusMessage }: UseWebRTCOptions) {
    const senderPCRef   = useRef<RTCPeerConnection | null>(null);
    const receiverPCRef = useRef<RTCPeerConnection | null>(null);

    const [sendProgress,    setSendProgress]    = useState(0);
    const [receiveProgress, setReceiveProgress] = useState(0);
    // Only set when browser doesn't support showSaveFilePicker (fallback Blob URL)
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

    const senderICEQueue   = useRef<RTCIceCandidateInit[]>([]);
    const receiverICEQueue = useRef<RTCIceCandidateInit[]>([]);

    const sendSignalRef = useRef(sendSignal);
    useEffect(() => { sendSignalRef.current = sendSignal; }, [sendSignal]);

    function waitForDrain(dc: RTCDataChannel): Promise<void> {
        return new Promise(resolve => {
            if (dc.bufferedAmount <= BUFFER_LOW) { resolve(); return; }
            const cb = () => { dc.removeEventListener('bufferedamountlow', cb); resolve(); };
            dc.addEventListener('bufferedamountlow', cb);
        });
    }

    // ── SENDER ────────────────────────────────────────────────────────────────

    const initializeSender = useCallback(async (
        fileHash: string,
        passphrase: string,
        uploadSalt: Uint8Array,
        targetId: string
    ) => {
        try {
            console.log(`🚀 initializeSender → target=${targetId}`);
            setStatusMessage("Initializing sender...");
            setSendProgress(0);
            senderICEQueue.current = [];
            senderPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            senderPCRef.current = pc;

            const dc = pc.createDataChannel("sharex-file-pipe", { ordered: true });
            dc.bufferedAmountLowThreshold = BUFFER_LOW;

            dc.onopen = async () => {
                setStatusMessage("🔒 Channel open. Handshaking with receiver...");
                try {
                    const totalChunks = await db.fileChunks
                        .where("fileHash").equals(fileHash).count();

                    if (totalChunks === 0) {
                        setStatusMessage("⚠️ No chunks in DB — did encryption finish?");
                        return;
                    }

                    // ── Phase 1: send COUNT + SALT, then stop and wait ────────
                    // Receiver needs COUNT to show progress and SALT to derive the
                    // AES key. After deriving the key it opens the save-file picker,
                    // then sends READY back. Only then do we start streaming chunks.
                    dc.send(makeCountPacket(totalChunks));
                    dc.send(makeSaltPacket(uploadSalt));
                    setStatusMessage("⏳ Waiting for receiver to open save location...");

                    // ── Phase 2: wait for READY (60 s timeout) ───────────────
                    await new Promise<void>((resolve, reject) => {
                        const tid = setTimeout(
                            () => reject(new Error("Timed out waiting for READY (60s)")),
                            60_000
                        );
                        dc.onmessage = (msg: MessageEvent) => {
                            if (msg.data instanceof ArrayBuffer) {
                                const v = new Uint8Array(msg.data);
                                if (v[0] === TYPE_READY) {
                                    clearTimeout(tid);
                                    dc.onmessage = null; // no further messages from receiver
                                    resolve();
                                }
                            }
                        };
                    });

                    // ── Phase 3: stream chunks with backpressure ──────────────
                    setStatusMessage("📤 Streaming chunks...");
                    const chunks = await db.fileChunks
                        .where("fileHash").equals(fileHash)
                        .sortBy("chunkIndex");

                    for (let i = 0; i < chunks.length; i++) {
                        if (dc.readyState !== 'open') {
                            setStatusMessage("❌ Channel closed mid-transfer.");
                            return;
                        }
                        if (dc.bufferedAmount > BUFFER_HIGH) {
                            setStatusMessage("⏳ Buffer full — throttling...");
                            await waitForDrain(dc);
                        }

                        dc.send(makeChunkPacket(
                            chunks[i].chunkIndex,
                            new Uint8Array(chunks[i].data)
                        ));

                        const pct = Math.round(((i + 1) / totalChunks) * 100);
                        setSendProgress(pct);
                        if (i % 100 === 0 || i === chunks.length - 1) {
                            setStatusMessage(`📤 Sending ${pct}% (${i + 1}/${totalChunks})`);
                        }
                    }

                    // ── Phase 4: EOF ──────────────────────────────────────────
                    dc.send(makeEOFPacket());
                    setSendProgress(100);
                    setStatusMessage("✅ All chunks sent!");

                } catch (err) {
                    console.error("Sender error:", err);
                    setStatusMessage(`❌ Transfer failed: ${(err as Error).message}`);
                }
            };

            dc.onerror = (e) => console.error("DataChannel error:", e);
            pc.onicecandidate = (e) => {
                if (e.candidate) sendSignalRef.current(targetId, {
                    type: 'candidate', candidate: e.candidate, role: 'sender'
                });
            };
            pc.onconnectionstatechange = () => {
                console.log("Sender:", pc.connectionState);
                if (pc.connectionState === 'failed') setStatusMessage("❌ P2P connection failed.");
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignalRef.current(targetId, { type: 'offer', sdp: offer.sdp });
            setStatusMessage("📡 Offer sent. Waiting for peer...");

        } catch (err) {
            console.error("initializeSender error:", err);
            setStatusMessage("Failed to start sender.");
        }
    }, [setStatusMessage]);

    // ── RECEIVER ──────────────────────────────────────────────────────────────

    const initializeReceiver = useCallback(async (
        remoteOfferSDP: string,
        passphrase: string,
        senderId: string
    ) => {
        try {
            console.log(`📥 initializeReceiver ← offer from ${senderId}`);
            setStatusMessage("Connecting to sender...");
            setReceiveProgress(0);
            setDownloadUrl(null);
            receiverICEQueue.current = [];
            receiverPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            receiverPCRef.current = pc;

            pc.onicecandidate = (e) => {
                if (e.candidate) sendSignalRef.current(senderId, {
                    type: 'candidate', candidate: e.candidate, role: 'receiver'
                });
            };
            pc.onconnectionstatechange = () => {
                console.log("Receiver:", pc.connectionState);
                if (pc.connectionState === 'connected') setStatusMessage("🔗 Connected! Handshaking...");
                if (pc.connectionState === 'failed')    setStatusMessage("❌ P2P connection failed.");
            };

            pc.ondatachannel = (event) => {
                const ch = event.channel;
                ch.binaryType = "arraybuffer";

                // ── Receiver state ────────────────────────────────────────────
                let totalChunks   = 0;
                let chunksWritten = 0;
                let derivedKey: CryptoKey | null = null;
                let writableStream: FileSystemWritableFileStream | null = null;
                const fallbackBuffer: ArrayBuffer[] = []; // used when no FilePicker

                // Queue for ALL messages that arrive before we are fully ready.
                // "Fully ready" = key derived AND (save file open OR fallback mode).
                // Queuing everything and processing in order is simpler and safer
                // than trying to partially process with pickerOpen flags.
                const messageQueue: ArrayBuffer[] = [];
                let processingQueue = false;
                let receiverReady   = false; // true once key+stream are ready

                const PLAIN_CHUNK_SIZE = 16384; // must match sliceFileIntoChunks

                const supportsFilePicker =
                    typeof (window as any).showSaveFilePicker === 'function';

                // ── Decrypt one CHUNK body and write ──────────────────────────
                // body = bytes AFTER the type tag:
                //   [0-3]  chunk index uint32 big-endian
                //   [4-15] IV (12 bytes)
                //   [16+]  ciphertext (AES-GCM encrypted + 16-byte auth tag)
                async function processChunk(body: Uint8Array): Promise<void> {
                    const idx = (body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3];
                    const iv  = copyBuf(body,  4, 16);
                    const ct  = copyBuf(body, 16);

                    if (ct.byteLength === 0) {
                        console.error(`Chunk ${idx}: empty ciphertext — skipping`);
                        return;
                    }

                    let dec: ArrayBuffer;
                    try {
                        dec = await window.crypto.subtle.decrypt(
                            { name: 'AES-GCM', iv },
                            derivedKey!,
                            ct
                        );
                    } catch (e) {
                        console.error(`Decrypt failed chunk ${idx}:`, e);
                        setStatusMessage(`❌ Decryption failed — wrong passphrase?`);
                        return;
                    }

                    if (writableStream) {
                        await writableStream.write({
                            type: 'write',
                            position: idx * PLAIN_CHUNK_SIZE,
                            data: dec
                        });
                    } else {
                        fallbackBuffer[idx] = dec;
                    }

                    chunksWritten++;
                    const pct = totalChunks > 0
                        ? Math.round((chunksWritten / totalChunks) * 100) : 0;
                    setReceiveProgress(pct);
                    if (chunksWritten % 100 === 0 || chunksWritten === totalChunks) {
                        setStatusMessage(`📥 Receiving ${pct}% (${chunksWritten}/${totalChunks})`);
                    }
                }

                // ── Drain the queued messages in order ────────────────────────
                // Called after receiverReady = true. Processes everything that
                // arrived while we were deriving the key and opening the picker.
                async function drainQueue(): Promise<void> {
                    if (processingQueue) return;
                    processingQueue = true;
                    while (messageQueue.length > 0) {
                        const buf  = messageQueue.shift()!;
                        const raw  = new Uint8Array(buf);
                        const type = raw[0];
                        const body = copyBuf(raw, 1);

                        if (type === TYPE_CHUNK) {
                            await processChunk(body);
                        } else if (type === TYPE_EOF) {
                            await handleEOF();
                        }
                    }
                    processingQueue = false;
                }

                // ── EOF handler ───────────────────────────────────────────────
                async function handleEOF(): Promise<void> {
                    setStatusMessage("💾 Finalizing file...");
                    try {
                        if (writableStream) {
                            await writableStream.close();
                            setStatusMessage(`✅ Done! ${chunksWritten}/${totalChunks} chunks saved.`);
                        } else {
                            // Assemble fallback buffer as a Blob download link
                            const ordered = Array.from(
                                { length: fallbackBuffer.length },
                                (_, i) => new Uint8Array(fallbackBuffer[i] ?? new ArrayBuffer(0))
                            );
                            const blob = new Blob(ordered, { type: 'application/octet-stream' });
                            setDownloadUrl(URL.createObjectURL(blob));
                            setStatusMessage("✅ Done! Click the link below to save.");
                        }
                        setReceiveProgress(100);
                        setSendProgress(100);
                    } catch (e) {
                        console.error("Finalize error:", e);
                        setStatusMessage("❌ Failed to finalize file.");
                    }
                }

                // ── Main message handler ──────────────────────────────────────
                ch.onmessage = async (msg: MessageEvent) => {
                    if (!(msg.data instanceof ArrayBuffer)) return;

                    const raw  = new Uint8Array(msg.data);
                    const type = raw[0];
                    const body = copyBuf(raw, 1);

                    // ── COUNT: just record total, no readiness change ─────────
                    if (type === TYPE_COUNT) {
                        totalChunks = (body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3];
                        console.log(`📊 Expecting ${totalChunks} chunks`);
                        return;
                    }

                    // ── SALT: derive key → open picker → send READY ───────────
                    // Everything else (CHUNK, EOF) that arrives from here on is
                    // queued and drained AFTER receiverReady is set to true.
                    if (type === TYPE_SALT) {
                        try {
                            derivedKey = await deriveKey(passphrase, body);

                            if (supportsFilePicker) {
                                setStatusMessage("💾 Choose where to save the file...");
                                try {
                                    const handle = await (window as any).showSaveFilePicker({
                                        suggestedName: 'downloaded_file'
                                    });
                                    writableStream = await handle.createWritable();
                                } catch (e: any) {
                                    if (e.name === 'AbortError') {
                                        setStatusMessage("❌ Cancelled.");
                                        pc.close();
                                        return;
                                    }
                                    // Picker failed for another reason — fall back to RAM
                                    console.warn("Picker failed, using RAM fallback:", e);
                                }
                            } else {
                                setStatusMessage("⚠️ RAM mode (browser lacks direct-to-disk support).");
                            }

                            // Mark ready and unblock the sender
                            receiverReady = true;
                            ch.send(makeReadyPacket());
                            setStatusMessage("🔑 Ready. Receiving chunks...");

                            // Drain anything that arrived while we were setting up
                            await drainQueue();

                        } catch (e) {
                            console.error("Key derivation or picker error:", e);
                            setStatusMessage("❌ Failed to initialize receiver.");
                        }
                        return;
                    }

                    // ── CHUNK / EOF: queue if not ready, process if ready ─────
                    if (type === TYPE_CHUNK || type === TYPE_EOF) {
                        if (!receiverReady) {
                            // Store the full raw buffer (including type byte) for drainQueue
                            messageQueue.push(msg.data);
                            return;
                        }
                        // Already ready — process immediately
                        if (type === TYPE_CHUNK) {
                            await processChunk(body);
                        } else {
                            await handleEOF();
                        }
                        return;
                    }

                    console.warn(`Unknown packet type: 0x${type.toString(16)}`);
                };
            };

            await pc.setRemoteDescription(
                new RTCSessionDescription({ type: 'offer', sdp: remoteOfferSDP })
            );
            for (const c of receiverICEQueue.current) {
                await pc.addIceCandidate(new RTCIceCandidate(c));
            }
            receiverICEQueue.current = [];

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

    const handleIncomingSignal = useCallback(async (signal: any) => {
        try {
            if (signal.type === 'answer') {
                const pc = senderPCRef.current;
                if (!pc) { console.warn("answer: no senderPC"); return; }
                if (pc.signalingState !== 'have-local-offer') {
                    console.warn(`Ignoring answer — state='${pc.signalingState}'`);
                    return;
                }
                await pc.setRemoteDescription(
                    new RTCSessionDescription({ type: 'answer', sdp: signal.sdp })
                );
                console.log("✅ Answer applied");

            } else if (signal.type === 'candidate' && signal.candidate) {
                const fromReceiver = signal.role === 'receiver';
                const pc    = fromReceiver ? senderPCRef.current   : receiverPCRef.current;
                const queue = fromReceiver ? senderICEQueue         : receiverICEQueue;
                if (!pc) return;
                if (!pc.remoteDescription) {
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

    return {
        initializeSender,
        initializeReceiver,
        handleIncomingSignal,
        sendProgress,
        receiveProgress,
        downloadUrl,
    };
}
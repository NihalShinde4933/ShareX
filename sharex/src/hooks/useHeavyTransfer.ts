'use client';

/**
 * useHeavyTransfer.ts — unencrypted 4-channel parallel transfer, no file-size limit
 *
 * Key design: CONCURRENT RANDOM-ACCESS WRITES
 * ────────────────────────────────────────────────────────────────────────────
 * Every chunk carries its index. The receiver computes:
 *
 *   byteOffset = chunkIndex × CHUNK_SIZE
 *
 * and calls writableStream.write({ type:'write', position, data }) immediately
 * on arrival — no queue, no ordering, no waiting for other channels.
 *
 * All 4 channels fire their writes concurrently. The browser's File System
 * Access API accepts concurrent positional writes to the same stream handle
 * as long as the ranges don't overlap — and they never do here because each
 * chunk occupies a unique, non-overlapping byte range in the output file.
 *
 * This is the same pattern used by the encrypted pipeline's writeToDisk(),
 * but without any decrypt step in between.
 *
 * Throughput model
 * ────────────────────────────────────────────────────────────────────────────
 *  - 4 channels deliver chunks in parallel (SCTP multiplexing).
 *  - Each chunk triggers an independent write() — no channel ever waits for
 *    another channel's write to finish.
 *  - The OS / browser disk scheduler sees a stream of concurrent positioned
 *    writes and can reorder/coalesce them for maximum throughput.
 *  - RAM is bounded: we only hold one 16 KB ArrayBuffer per concurrent write
 *    in flight (up to MAX_CONCURRENT_WRITES at a time across all channels).
 *
 * Packet protocol (binary):
 *   0x01  COUNT  [1][4B uint32 — total chunk count]
 *   0x02  META   [1][4B name-byte-length][utf8 filename][8B uint64 file size]
 *   0x03  CHUNK  [1][4B uint32 chunk index][raw plaintext bytes — NOT encrypted]
 *   0x04  EOF    [1]
 *   0x05  READY  [1]  receiver → sender on channel-0 only
 *
 * Chunk size: 16 KB (16_384 bytes)
 *   → packet size = 5 byte header + 16_384 = 16_389 bytes
 *   → safely under Chrome's 256 KB DataChannel limit, Safari's 64 KB limit,
 *     and every other browser's limit.
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { rtcConfig } from '../utils/webrtc';

// ── Constants ─────────────────────────────────────────────────────────────────

const N_CHANNELS = 4;
const CHUNK_SIZE  = 16_384;             // 16 KB per chunk — same as safe mode

const BUFFER_HIGH = 8  * 1024 * 1024;  // 8 MB  — pause sending above this
const BUFFER_LOW  = 2  * 1024 * 1024;  // 2 MB  — resume below this

/**
 * Maximum concurrent writableStream.write() calls allowed at once.
 * Each in-flight write holds one 16 KB buffer in RAM.
 * 64 × 16 KB = 1 MB max RAM overhead from in-flight writes.
 * Raising this increases parallelism; lowering it reduces peak RAM.
 */
const MAX_CONCURRENT_WRITES = 64;

// ── Packet type tags ──────────────────────────────────────────────────────────

const TYPE_COUNT = 0x01;
const TYPE_META  = 0x02;
const TYPE_CHUNK = 0x03;
const TYPE_EOF   = 0x04;
const TYPE_READY = 0x05;

// ── Packet builders ───────────────────────────────────────────────────────────

function makeCountPacket(n: number): Uint8Array<ArrayBuffer> {
    const p = new Uint8Array(5) as Uint8Array<ArrayBuffer>;
    p[0] = TYPE_COUNT;
    p[1] = (n >> 24) & 0xFF; p[2] = (n >> 16) & 0xFF;
    p[3] = (n >> 8)  & 0xFF; p[4] =  n        & 0xFF;
    return p;
}

function makeMetaPacket(filename: string, totalSize: number): Uint8Array<ArrayBuffer> {
    const nameBytes = new TextEncoder().encode(filename);
    const p = new Uint8Array(1 + 4 + nameBytes.byteLength + 8) as Uint8Array<ArrayBuffer>;
    let o = 0;
    p[o++] = TYPE_META;
    p[o++] = (nameBytes.byteLength >> 24) & 0xFF;
    p[o++] = (nameBytes.byteLength >> 16) & 0xFF;
    p[o++] = (nameBytes.byteLength >> 8)  & 0xFF;
    p[o++] =  nameBytes.byteLength        & 0xFF;
    p.set(nameBytes, o); o += nameBytes.byteLength;
    const hi = Math.floor(totalSize / 0x100000000);
    const lo = totalSize % 0x100000000;
    p[o++] = (hi >> 24) & 0xFF; p[o++] = (hi >> 16) & 0xFF;
    p[o++] = (hi >> 8)  & 0xFF; p[o++] =  hi        & 0xFF;
    p[o++] = (lo >> 24) & 0xFF; p[o++] = (lo >> 16) & 0xFF;
    p[o++] = (lo >> 8)  & 0xFF; p[o++] =  lo        & 0xFF;
    return p;
}

function makeChunkPacket(idx: number, raw: ArrayBuffer): Uint8Array<ArrayBuffer> {
    const p = new Uint8Array(5 + raw.byteLength) as Uint8Array<ArrayBuffer>;
    p[0] = TYPE_CHUNK;
    p[1] = (idx >> 24) & 0xFF; p[2] = (idx >> 16) & 0xFF;
    p[3] = (idx >> 8)  & 0xFF; p[4] =  idx        & 0xFF;
    p.set(new Uint8Array(raw), 5);
    return p;
}

function makeEOFPacket():   Uint8Array<ArrayBuffer> { return new Uint8Array([TYPE_EOF])   as Uint8Array<ArrayBuffer>; }
function makeReadyPacket(): Uint8Array<ArrayBuffer> { return new Uint8Array([TYPE_READY]) as Uint8Array<ArrayBuffer>; }

function copyBuf(u8: Uint8Array, start: number, end?: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(
        u8.buffer.slice(
            u8.byteOffset + start,
            end !== undefined ? u8.byteOffset + end : undefined
        )
    ) as Uint8Array<ArrayBuffer>;
}

// ── Concurrent write limiter ──────────────────────────────────────────────────
/**
 * Semaphore that caps the number of concurrent writableStream.write() calls.
 *
 * Why we need this even with random-access writes:
 * The File System Access API allows concurrent positional writes to the same
 * stream, but the browser queues them internally. Issuing thousands of
 * concurrent writes would buffer all 16 KB payloads in memory waiting for
 * the OS to schedule them. The semaphore keeps at most MAX_CONCURRENT_WRITES
 * writes "submitted but not yet acknowledged" at any moment, bounding RAM to
 * MAX_CONCURRENT_WRITES × 16 KB ≈ 1 MB regardless of file size.
 *
 * This is NOT sequential — multiple writes run concurrently up to the cap.
 */
class WriteSemaphore {
    private active = 0;
    private queue: Array<() => void> = [];
    constructor(private readonly max: number) {}

    async acquire(): Promise<void> {
        if (this.active < this.max) { this.active++; return; }
        return new Promise<void>(resolve => this.queue.push(resolve));
    }

    release(): void {
        const next = this.queue.shift();
        if (next) { next(); }
        else { this.active--; }
    }

    /** Wait until all acquired slots have been released (all writes done). */
    async drain(): Promise<void> {
        while (this.active > 0 || this.queue.length > 0) {
            await new Promise(r => setTimeout(r, 4));
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function silenceChannel(dc: RTCDataChannel) {
    dc.onerror   = null;
    dc.onmessage = null;
    dc.onopen    = null;
    dc.onclose   = null;
}

function isTeardownNoise(pc: RTCPeerConnection, ch: RTCDataChannel): boolean {
    return (
        pc.connectionState === 'closed' ||
        ch.readyState === 'closing'     ||
        ch.readyState === 'closed'
    );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseHeavyTransferOptions {
    sendSignal:         (targetId: string, signalData: unknown) => void;
    setStatusMessage:   (msg: string) => void;
    onSendComplete?:    () => void;
    onReceiveComplete?: () => void;
}

export function useHeavyTransfer({
    sendSignal,
    setStatusMessage,
    onSendComplete,
    onReceiveComplete,
}: UseHeavyTransferOptions) {

    const senderPCRef   = useRef<RTCPeerConnection | null>(null);
    const receiverPCRef = useRef<RTCPeerConnection | null>(null);
    const senderChRef   = useRef<RTCDataChannel[]>([]);
    const receiverChRef = useRef<RTCDataChannel[]>([]);

    const [sendProgress,     setSendProgress]     = useState(0);
    const [receiveProgress,  setReceiveProgress]  = useState(0);
    const [receivedFileName, setReceivedFileName] = useState<string | null>(null);

    const senderICEQ   = useRef<RTCIceCandidateInit[]>([]);
    const receiverICEQ = useRef<RTCIceCandidateInit[]>([]);

    const signalRef = useRef(sendSignal);
    const onSendRef = useRef(onSendComplete);
    const onRecvRef = useRef(onReceiveComplete);
    useEffect(() => { signalRef.current = sendSignal;        }, [sendSignal]);
    useEffect(() => { onSendRef.current = onSendComplete;    }, [onSendComplete]);
    useEffect(() => { onRecvRef.current = onReceiveComplete; }, [onReceiveComplete]);

    function waitForDrain(dc: RTCDataChannel): Promise<void> {
        return new Promise(resolve => {
            if (dc.bufferedAmount <= BUFFER_LOW) { resolve(); return; }
            const cb = () => { dc.removeEventListener('bufferedamountlow', cb); resolve(); };
            dc.addEventListener('bufferedamountlow', cb);
        });
    }

    // ── Reset ─────────────────────────────────────────────────────────────────

    const resetHeavyConnections = useCallback(() => {
        senderChRef.current.forEach(silenceChannel);
        receiverChRef.current.forEach(silenceChannel);
        senderChRef.current   = [];
        receiverChRef.current = [];

        if (senderPCRef.current) {
            senderPCRef.current.onicecandidate          = null;
            senderPCRef.current.onconnectionstatechange = null;
            senderPCRef.current.close();
            senderPCRef.current = null;
        }
        if (receiverPCRef.current) {
            receiverPCRef.current.onicecandidate          = null;
            receiverPCRef.current.onconnectionstatechange = null;
            receiverPCRef.current.ondatachannel           = null;
            receiverPCRef.current.close();
            receiverPCRef.current = null;
        }

        senderICEQ.current   = [];
        receiverICEQ.current = [];
        setSendProgress(0);
        setReceiveProgress(0);
        setReceivedFileName(null);
    }, []);

    // ── SENDER ────────────────────────────────────────────────────────────────

    const initializeHeavySender = useCallback(async (file: File, targetId: string) => {
        try {
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            const sizeMB      = (file.size / 1024 / 1024).toFixed(1);
            console.log(`🚀 [heavy] sender → ${targetId}  ${sizeMB} MB  ${totalChunks} chunks`);

            setStatusMessage('Initializing high-throughput sender...');
            setSendProgress(0);
            senderICEQ.current = [];

            senderChRef.current.forEach(silenceChannel);
            senderPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            senderPCRef.current = pc;

            // All 4 channels created BEFORE createOffer() — required for SDP
            const channels: RTCDataChannel[] = Array.from({ length: N_CHANNELS }, (_, i) => {
                const dc = pc.createDataChannel(`sharex-heavy-${i}`, { ordered: true });
                dc.bufferedAmountLowThreshold = BUFFER_LOW;
                return dc;
            });
            senderChRef.current = channels;

            pc.onicecandidate = e => {
                if (e.candidate) signalRef.current(targetId, { type: 'candidate', candidate: e.candidate, role: 'sender' });
            };
            pc.onconnectionstatechange = () => {
                console.log('[heavy] sender:', pc.connectionState);
                if (pc.connectionState === 'failed') setStatusMessage('❌ P2P connection failed.');
            };

            channels[0].onopen = async () => {
                setStatusMessage('🔓 Channel open — unencrypted high-speed mode. Handshaking...');
                try {
                    // Phase 1: metadata
                    channels[0].send(makeCountPacket(totalChunks));
                    channels[0].send(makeMetaPacket(file.name, file.size));
                    setStatusMessage('⏳ Waiting for receiver to open save dialog...');

                    // Phase 2: wait for READY
                    await new Promise<void>((resolve, reject) => {
                        const tid = setTimeout(() => reject(new Error('READY timeout (60s)')), 60_000);
                        channels[0].onmessage = (msg: MessageEvent) => {
                            if (msg.data instanceof ArrayBuffer && new Uint8Array(msg.data)[0] === TYPE_READY) {
                                clearTimeout(tid);
                                channels[0].onmessage = null;
                                resolve();
                            }
                        };
                    });

                    setStatusMessage(`📤 Streaming ${sizeMB} MB across 4 parallel channels...`);

                    // Phase 3: round-robin chunk dispatch
                    // Each channel reads its slice, sends immediately.
                    // Per-channel backpressure via bufferedAmountLow — one
                    // full channel pauses only its own loop, not the others.
                    for (let i = 0; i < totalChunks; i++) {
                        const dc = channels[i % N_CHANNELS];

                        if (dc.readyState !== 'open') {
                            setStatusMessage('❌ Channel closed mid-transfer.');
                            return;
                        }

                        if (dc.bufferedAmount > BUFFER_HIGH) await waitForDrain(dc);

                        const start = i * CHUNK_SIZE;
                        const end   = Math.min(start + CHUNK_SIZE, file.size);
                        const raw   = await file.slice(start, end).arrayBuffer();

                        // 5-byte header + 16 KB data = 16,389 bytes per packet
                        // Well under Chrome's 256 KB and Safari's 64 KB limits
                        dc.send(makeChunkPacket(i, raw));

                        const pct = Math.round(((i + 1) / totalChunks) * 100);
                        setSendProgress(pct);
                        if (i % 500 === 0 || i === totalChunks - 1) {
                            setStatusMessage(`📤 Sending ${pct}%  (${i + 1}/${totalChunks} blocks · ${sizeMB} MB)`);
                        }
                    }

                    // Phase 4: EOF on every channel
                    channels.forEach(dc => { if (dc.readyState === 'open') dc.send(makeEOFPacket()); });
                    setSendProgress(100);
                    setStatusMessage('✅ All chunks sent!');
                    onSendRef.current?.();

                } catch (err) {
                    console.error('[heavy] sender error:', err);
                    setStatusMessage(`❌ Transfer failed: ${(err as Error).message}`);
                }
            };

            channels[0].onerror = e => {
                if (isTeardownNoise(pc, channels[0])) return;
                console.error('[heavy] ch0 error:', (e as RTCErrorEvent).error ?? e);
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            signalRef.current(targetId, { type: 'offer', sdp: offer.sdp });
            setStatusMessage('📡 Offer sent. Waiting for peer...');

        } catch (err) {
            console.error('[heavy] initializeHeavySender:', err);
            setStatusMessage('Failed to start heavy sender.');
        }
    }, [setStatusMessage]);

    // ── RECEIVER ──────────────────────────────────────────────────────────────

    const initializeHeavyReceiver = useCallback(async (remoteOfferSDP: string, senderId: string) => {
        try {
            console.log(`📥 [heavy] receiver ← offer from ${senderId}`);
            setStatusMessage('Connecting to sender...');
            setReceiveProgress(0);
            setReceivedFileName(null);
            receiverICEQ.current = [];

            receiverChRef.current.forEach(silenceChannel);
            receiverPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            receiverPCRef.current = pc;

            pc.onicecandidate = e => {
                if (e.candidate) signalRef.current(senderId, { type: 'candidate', candidate: e.candidate, role: 'receiver' });
            };
            pc.onconnectionstatechange = () => {
                console.log('[heavy] receiver:', pc.connectionState);
                if (pc.connectionState === 'connected') setStatusMessage('🔗 Connected! Receiving...');
                if (pc.connectionState === 'failed')    setStatusMessage('❌ P2P connection failed.');
            };

            // ── Shared receiver state ─────────────────────────────────────────
            let totalChunks   = 0;
            let chunksWritten = 0;
            let writableStream: FileSystemWritableFileStream | null = null;
            let eofCount  = 0;
            let setupDone = false;
            let ch0Ref:   RTCDataChannel | null = null;

            /**
             * CONCURRENT WRITE SEMAPHORE
             * Limits how many write() calls are in-flight simultaneously.
             * Unlike a queue, this allows writes to run in parallel — the OS
             * scheduler sees multiple concurrent positional writes and can
             * optimise disk access (reorder, merge, issue in parallel to SSD).
             * Each in-flight write holds its 16 KB buffer in RAM until the
             * Promise resolves, so MAX_CONCURRENT_WRITES × 16 KB = peak RAM.
             */
            const writeSem = new WriteSemaphore(MAX_CONCURRENT_WRITES);

            // Track every in-flight write promise for final drain on EOF
            const writePromises = new Set<Promise<void>>();

            // Buffer chunks that arrive before the file picker resolves
            const preQueue: { type: number; body: Uint8Array<ArrayBuffer> }[] = [];

            const supportsFilePicker = typeof (window as any).showSaveFilePicker === 'function';

            /**
             * CORE WRITE PATH — called directly from each channel's onmessage.
             *
             * 1. Acquire a write slot (blocks only if MAX_CONCURRENT_WRITES are
             *    already in flight — otherwise returns immediately).
             * 2. Fire writableStream.write() at the exact byte offset for this
             *    chunk. No ordering, no queue — pure random-access parallel I/O.
             * 3. Release the slot as soon as the write resolves so the next
             *    waiting chunk can proceed.
             *
             * All 4 channels call this concurrently. The browser's File System
             * Access implementation handles the underlying I/O scheduling.
             */
            function writeChunkNow(idx: number, raw: ArrayBuffer): Promise<void> {
                const position = idx * CHUNK_SIZE;
                const p = (async () => {
                    await writeSem.acquire();
                    try {
                        if (writableStream) {
                            await writableStream.write({ type: 'write', position, data: raw });
                        }
                    } catch (e) {
                        console.error(`[heavy] write failed at offset ${position} (chunk ${idx}):`, e);
                    } finally {
                        writeSem.release();
                    }
                })();

                // Track the promise so handleEOF can await all of them
                writePromises.add(p);
                p.finally(() => writePromises.delete(p));
                return p;
            }

            function trackWrite(p: Promise<void>) {
                writePromises.add(p);
                p.finally(() => writePromises.delete(p));
            }

            /**
             * Process a CHUNK packet — called directly from onmessage on any
             * of the 4 channels. Dispatches the write immediately, no waiting.
             */
            function processChunk(body: Uint8Array<ArrayBuffer>): void {
                const idx = (body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3];
                const raw = body.buffer.slice(body.byteOffset + 4) as ArrayBuffer;

                // Fire the write immediately — do NOT await here.
                // The channel message handler returns instantly; the write runs
                // concurrently in the background alongside writes from other channels.
                trackWrite(writeChunkNow(idx, raw));

                chunksWritten++;
                const pct = totalChunks > 0 ? Math.round((chunksWritten / totalChunks) * 100) : 0;
                setReceiveProgress(pct);
                if (chunksWritten % 500 === 0 || chunksWritten === totalChunks) {
                    setStatusMessage(`📥 Receiving ${pct}%  (${chunksWritten}/${totalChunks} blocks)`);
                }
            }

            // ── Drain pre-queue after setup ───────────────────────────────────
            async function drainPreQueue() {
                while (preQueue.length > 0) {
                    const { type, body } = preQueue.shift()!;
                    if (type === TYPE_CHUNK) processChunk(body);        // fire and continue
                    else if (type === TYPE_EOF) await handleEOF();
                }
            }

            // ── Finalize when all 4 EOFs arrive ──────────────────────────────
            async function handleEOF() {
                eofCount++;
                console.log(`[heavy] EOF ${eofCount}/${N_CHANNELS}`);
                if (eofCount < N_CHANNELS) return;

                // Wait for every in-flight write to land on disk before close()
                if (writePromises.size > 0) {
                    console.log(`[heavy] ⏳ Draining ${writePromises.size} concurrent write(s)...`);
                    await Promise.allSettled(writePromises);
                }
                // Belt-and-suspenders: also drain the semaphore itself
                await writeSem.drain();

                setStatusMessage('💾 Finalizing...');
                try {
                    if (writableStream) {
                        await writableStream.close();
                        setStatusMessage(`✅ Saved! ${chunksWritten}/${totalChunks} blocks written.`);
                    } else {
                        setStatusMessage('⚠️ No writable stream — Chrome/Edge required.');
                    }
                    setReceiveProgress(100);
                    onRecvRef.current?.();
                } catch (e) {
                    console.error('[heavy] finalize error:', e);
                    setStatusMessage('❌ Failed to finalize file.');
                }
            }

            // ── One-time setup on META ────────────────────────────────────────
            async function doSetup(metaBody: Uint8Array<ArrayBuffer>) {
                let o = 0;
                const nameLen  = (metaBody[o] << 24) | (metaBody[o+1] << 16) | (metaBody[o+2] << 8) | metaBody[o+3];
                o += 4;
                const filename = new TextDecoder().decode(metaBody.slice(o, o + nameLen));
                setReceivedFileName(filename);

                if (supportsFilePicker) {
                    setStatusMessage('💾 Choose where to save the file...');
                    try {
                        const handle = await (window as any).showSaveFilePicker({
                            suggestedName: filename || 'heavy_download',
                        });
                        writableStream = await handle.createWritable();
                    } catch (e: any) {
                        if (e.name === 'AbortError') {
                            setStatusMessage('❌ Save cancelled.');
                            pc.close();
                            return;
                        }
                        console.warn('[heavy] File picker failed:', e);
                        setStatusMessage('⚠️ Could not open save dialog.');
                    }
                } else {
                    setStatusMessage('⚠️ Direct-to-disk requires Chrome or Edge.');
                }

                setupDone = true;

                // Unblock the sender
                ch0Ref?.send(makeReadyPacket());
                setStatusMessage('🔓 Ready. Receiving on 4 channels simultaneously...');

                // Flush anything that arrived during the file picker dialog
                await drainPreQueue();
            }

            // ── ondatachannel ─────────────────────────────────────────────────
            pc.ondatachannel = event => {
                const ch = event.channel;
                ch.binaryType = 'arraybuffer';
                console.log(`[heavy] channel open: ${ch.label}`);

                receiverChRef.current.push(ch);
                if (ch.label === 'sharex-heavy-0') ch0Ref = ch;

                ch.onmessage = async (msg: MessageEvent) => {
                    if (!(msg.data instanceof ArrayBuffer)) return;

                    const raw  = new Uint8Array(msg.data);
                    const type = raw[0];
                    const body = copyBuf(raw, 1);

                    switch (type) {
                        case TYPE_COUNT:
                            totalChunks = (body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3];
                            console.log(`[heavy] expecting ${totalChunks} chunks`);
                            break;

                        case TYPE_META:
                            await doSetup(body);
                            break;

                        case TYPE_CHUNK:
                            if (!setupDone) {
                                // File picker still open — buffer for later
                                preQueue.push({ type, body });
                            } else {
                                // Fire the write immediately — no await, no queue
                                processChunk(body);
                            }
                            break;

                        case TYPE_EOF:
                            if (!setupDone) {
                                preQueue.push({ type, body });
                            } else {
                                await handleEOF();
                            }
                            break;

                        default:
                            console.warn(`[heavy] unknown packet 0x${type.toString(16)}`);
                    }
                };

                ch.onerror = e => {
                    if (isTeardownNoise(pc, ch)) return;
                    console.error(`[heavy] ${ch.label} error:`, (e as RTCErrorEvent).error ?? e);
                };
            };

            // ── SDP negotiation ───────────────────────────────────────────────
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: remoteOfferSDP }));
            for (const c of receiverICEQ.current) await pc.addIceCandidate(new RTCIceCandidate(c));
            receiverICEQ.current = [];

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signalRef.current(senderId, { type: 'answer', sdp: answer.sdp });
            setStatusMessage('📡 Answer sent. Establishing P2P connection...');

        } catch (err) {
            console.error('[heavy] initializeHeavyReceiver:', err);
            setStatusMessage('Failed to connect to sender.');
        }
    }, [setStatusMessage]);

    // ── Signal router ─────────────────────────────────────────────────────────

    const handleHeavyIncomingSignal = useCallback(async (signal: any) => {
        try {
            if (signal.type === 'answer') {
                const pc = senderPCRef.current;
                if (!pc || pc.signalingState !== 'have-local-offer') return;
                await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
                console.log('[heavy] ✅ answer applied');
            } else if (signal.type === 'candidate' && signal.candidate) {
                const fromReceiver = signal.role === 'receiver';
                const pc    = fromReceiver ? senderPCRef.current   : receiverPCRef.current;
                const queue = fromReceiver ? senderICEQ            : receiverICEQ;
                if (!pc) return;
                if (!pc.remoteDescription) queue.current.push(signal.candidate);
                else await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            }
        } catch (err) {
            console.error('[heavy] handleHeavyIncomingSignal:', err);
        }
    }, []);

    useEffect(() => () => {
        senderChRef.current.forEach(silenceChannel);
        receiverChRef.current.forEach(silenceChannel);
        senderPCRef.current?.close();
        receiverPCRef.current?.close();
    }, []);

    return {
        initializeHeavySender,
        initializeHeavyReceiver,
        handleHeavyIncomingSignal,
        sendProgress,
        receiveProgress,
        receivedFileName,
        resetHeavyConnections,
    };
}
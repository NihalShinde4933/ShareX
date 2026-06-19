'use client';

/**
 * useWebRTC.ts — 4-channel parallel WebRTC file transfer
 *
 * FIX (Channel 0 error: {} on "Send another file"):
 * ───────────────────────────────────────────────────────────────────────────
 * resetConnections() called pc.close() on the OLD RTCPeerConnection, but the
 * data channels created for that session still had .onerror handlers
 * attached. Closing a PeerConnection fires error/close events on its
 * channels as part of teardown — these are EXPECTED and harmless, not real
 * failures. The empty `{}` in the log is an RTCErrorEvent whose properties
 * don't serialize via console.error by default.
 *
 * Fix: every onerror handler now checks `pc.connectionState` / channel
 * `.readyState` before logging. If the connection is already closed/closing,
 * the event is swallowed silently (expected teardown noise). Real errors
 * (channel errors while the connection is still 'connected') are still
 * logged loudly. resetConnections() also now explicitly clears onerror/
 * onmessage/onopen on every channel before closing the PC, so no stale
 * handler can fire after a new session has already started.
 *
 * FIX (slow receiving — single-threaded disk writes):
 * ───────────────────────────────────────────────────────────────────────────
 * Previously processChunk() awaited writeToDisk() before returning, and the
 * semaphore released only after BOTH decrypt AND write finished. This meant
 * decrypt work for chunk N+1 couldn't start until chunk N's disk write had
 * fully completed — serializing the receive pipeline on disk I/O latency
 * even though 4 workers were decrypting in parallel.
 *
 * Fix: decrypt and write are now decoupled into two independent pipelines
 * connected by a bounded queue:
 *   - decryptLimiter (semaphore) still bounds how many DECRYPTS run at once
 *     across the 4 workers — released as soon as decrypt finishes, not after
 *     the write completes.
 *   - A separate writeQueue + a single "write worker loop" pulls decrypted
 *     buffers off the queue and writes them to disk one at a time (disk
 *     writes to one file handle are inherently sequential — this is a
 *     correctness requirement of the File System Access API, not a choice).
 *   - Because decrypt is no longer blocked on write, all 4 decrypt workers
 *     stay saturated continuously, and writes happen as fast as the disk
 *     allows, back-to-back with zero idle gap between them.
 *   - writeQueueDepth is capped (WRITE_QUEUE_HIGH_WATERMARK) so decrypted-but
 *     -unwritten buffers don't pile up unbounded in RAM if disk I/O is slower
 *     than decrypt+network combined.
 *
 * Packet protocol (same on all channels):
 *   0x01 COUNT  [1][4B total chunk count]
 *   0x02 SALT   [1][16B salt]
 *   0x03 CHUNK  [1][4B index][12B IV][ciphertext]
 *   0x04 EOF    [1]
 *   0x05 READY  [1]  receiver→sender on channel-0 only
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { db } from '../lib/db';
import { deriveKey } from '../utils/crypto';
import { rtcConfig } from '../utils/webrtc';

// ── Constants ─────────────────────────────────────────────────────────────────
const N_CHANNELS        = 4;
const PLAIN_CHUNK_SIZE  = 16384;
const BUFFER_HIGH       = 8 * 1024 * 1024;
const BUFFER_LOW        = 2 * 1024 * 1024;
const N_DECRYPT_WORKERS = 4;
const MAX_INFLIGHT_DECRYPTS = N_DECRYPT_WORKERS * 6; // 24

/**
 * Maximum number of decrypted-but-not-yet-written buffers allowed to queue up.
 * Once exceeded, processChunk() awaits a slot before decrypting the NEXT
 * chunk — this is the only backpressure between decrypt and write speed,
 * preventing RAM blow-up if disk I/O briefly lags behind network+decrypt.
 */
const WRITE_QUEUE_HIGH_WATERMARK = 48;

// ── Packet type tags ──────────────────────────────────────────────────────────
const TYPE_COUNT = 0x01;
const TYPE_SALT  = 0x02;
const TYPE_CHUNK = 0x03;
const TYPE_EOF   = 0x04;
const TYPE_READY = 0x05;

function makeCountPacket(n: number): Uint8Array<ArrayBuffer> {
    const p = new Uint8Array(5) as Uint8Array<ArrayBuffer>;
    p[0]=TYPE_COUNT; p[1]=(n>>24)&0xFF; p[2]=(n>>16)&0xFF; p[3]=(n>>8)&0xFF; p[4]=n&0xFF;
    return p;
}
function makeSaltPacket(salt: Uint8Array): Uint8Array<ArrayBuffer> {
    const p = new Uint8Array(1+salt.byteLength) as Uint8Array<ArrayBuffer>;
    p[0]=TYPE_SALT; p.set(new Uint8Array(salt),1);
    return p;
}
function makeChunkPacket(idx: number, enc: Uint8Array): Uint8Array<ArrayBuffer> {
    const p = new Uint8Array(5+enc.byteLength) as Uint8Array<ArrayBuffer>;
    p[0]=TYPE_CHUNK;
    p[1]=(idx>>24)&0xFF; p[2]=(idx>>16)&0xFF; p[3]=(idx>>8)&0xFF; p[4]=idx&0xFF;
    p.set(new Uint8Array(enc),5);
    return p;
}
function makeEOFPacket():   Uint8Array<ArrayBuffer> { return new Uint8Array([TYPE_EOF])   as Uint8Array<ArrayBuffer>; }
function makeReadyPacket(): Uint8Array<ArrayBuffer> { return new Uint8Array([TYPE_READY]) as Uint8Array<ArrayBuffer>; }

function copyBuf(u8: Uint8Array, start: number, end?: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(
        u8.buffer.slice(u8.byteOffset+start, end!==undefined ? u8.byteOffset+end : undefined)
    ) as Uint8Array<ArrayBuffer>;
}

// ── Decrypt worker pool ───────────────────────────────────────────────────────
interface WPending { resolve:(b:ArrayBuffer)=>void; reject:(e:Error)=>void; }
interface WSlot    { w:Worker; pending:Map<number,WPending>; }

let _pool: WSlot[]|null = null;
function getPool(): WSlot[] {
    if (_pool) return _pool;
    _pool = Array.from({length:N_DECRYPT_WORKERS}, () => {
        const w = new Worker('/workers/cryptoWorker.js');
        const slot:WSlot = {w, pending:new Map()};
        w.onmessage = (e:MessageEvent) => {
            const {id,result,error} = e.data;
            const cb = slot.pending.get(id);
            if (!cb) return;
            slot.pending.delete(id);
            error ? cb.reject(new Error(error)) : cb.resolve(result as ArrayBuffer);
        };
        return slot;
    });
    return _pool;
}

function decryptOnWorker(encBuf: ArrayBuffer, keyJwk: JsonWebKey, idx: number): Promise<ArrayBuffer> {
    const pool = getPool();
    const slot = pool.reduce((b,s) => s.pending.size < b.pending.size ? s : b);
    return new Promise((resolve,reject) => {
        slot.pending.set(idx,{resolve,reject});
        slot.w.postMessage({op:'decrypt',id:idx,encryptedBuffer:encBuf,keyJwk},[encBuf]);
    });
}

/** Bounded-concurrency semaphore. */
class Semaphore {
    private active = 0;
    private queue: Array<() => void> = [];
    constructor(private readonly max: number) {}
    async acquire(): Promise<void> {
        if (this.active < this.max) { this.active++; return; }
        return new Promise<void>(resolve => this.queue.push(resolve));
    }
    release(): void {
        const next = this.queue.shift();
        if (next) next();
        else this.active--;
    }
}

/**
 * Sequential write pipeline.
 *
 * The File System Access API requires writes to a single handle to happen
 * one at a time (concurrent .write() calls on the same stream throw). This
 * class lets producers push {position, data} write jobs from anywhere
 * (any of the 4 decrypt workers, any order) and guarantees they're applied
 * to disk strictly one-at-a-time via an internal queue + a single running
 * "drain" loop — without ever blocking the PRODUCER (decrypt) side.
 */
class SequentialWriter {
    private queue: { position: number; data: ArrayBuffer }[] = [];
    private draining = false;
    private waiters: Array<() => void> = [];   // resolved when queue drops below watermark
    private finished = false;

    constructor(private readonly stream: FileSystemWritableFileStream | null) {}

    /** Enqueue a write job. Resolves once the job is queued (not necessarily written). */
    async push(position: number, data: ArrayBuffer): Promise<void> {
        this.queue.push({ position, data });
        this.kickDrain();

        // Backpressure: if too many writes are queued, wait until the queue
        // shrinks before letting the caller (decrypt pipeline) continue.
        if (this.queue.length > WRITE_QUEUE_HIGH_WATERMARK) {
            await new Promise<void>(resolve => this.waiters.push(resolve));
        }
    }

    private kickDrain() {
        if (this.draining) return;
        this.draining = true;
        void this.drainLoop();
    }

    private async drainLoop() {
        while (this.queue.length > 0) {
            const job = this.queue.shift()!;
            if (this.stream) {
                try {
                    await this.stream.write({ type: 'write', position: job.position, data: job.data });
                } catch (e) {
                    console.error(`Disk write failed at offset ${job.position}:`, e);
                }
            }
            // Wake any producers waiting on backpressure once we've drained
            // back under the watermark.
            if (this.queue.length <= WRITE_QUEUE_HIGH_WATERMARK) {
                const w = this.waiters.splice(0, this.waiters.length);
                w.forEach(resolve => resolve());
            }
        }
        this.draining = false;
    }

    /** Wait for every queued write to actually land on disk. */
    async flush(): Promise<void> {
        while (this.queue.length > 0 || this.draining) {
            await new Promise(r => setTimeout(r, 5));
        }
    }
}

// ── Hook interface ────────────────────────────────────────────────────────────
interface UseWebRTCOptions {
    sendSignal:       (targetId:string, signalData:any) => void;
    setStatusMessage: (msg:string) => void;
    onSendComplete?:  () => void;
    onReceiveComplete?: () => void;
}

export function useWebRTC({sendSignal, setStatusMessage, onSendComplete, onReceiveComplete}: UseWebRTCOptions) {
    const senderPCRef   = useRef<RTCPeerConnection|null>(null);
    const receiverPCRef = useRef<RTCPeerConnection|null>(null);
    // Track active channels so resetConnections() can detach handlers cleanly
    // before closing, preventing the stale "Channel 0 error: {}" teardown noise.
    const senderChannelsRef   = useRef<RTCDataChannel[]>([]);
    const receiverChannelsRef = useRef<RTCDataChannel[]>([]);

    const [sendProgress,    setSendProgress]    = useState(0);
    const [receiveProgress, setReceiveProgress] = useState(0);
    const [downloadUrl,     setDownloadUrl]     = useState<string|null>(null);

    const senderICEQueue   = useRef<RTCIceCandidateInit[]>([]);
    const receiverICEQueue = useRef<RTCIceCandidateInit[]>([]);

    const sendSignalRef = useRef(sendSignal);
    useEffect(() => { sendSignalRef.current = sendSignal; }, [sendSignal]);

    const onSendCompleteRef = useRef(onSendComplete);
    useEffect(() => { onSendCompleteRef.current = onSendComplete; }, [onSendComplete]);
    const onReceiveCompleteRef = useRef(onReceiveComplete);
    useEffect(() => { onReceiveCompleteRef.current = onReceiveComplete; }, [onReceiveComplete]);

    function waitForDrain(dc: RTCDataChannel): Promise<void> {
        return new Promise(resolve => {
            if (dc.bufferedAmount <= BUFFER_LOW) { resolve(); return; }
            const cb = () => { dc.removeEventListener('bufferedamountlow',cb); resolve(); };
            dc.addEventListener('bufferedamountlow',cb);
        });
    }

    /** Detach all handlers on a channel so teardown can't trigger stale logs. */
    function silenceChannel(dc: RTCDataChannel) {
        dc.onerror = null;
        dc.onmessage = null;
        dc.onopen = null;
        dc.onclose = null;
    }

    /**
     * Fully tear down both peer connections for "Send another file".
     * Detaches every channel handler FIRST so closing the PeerConnection
     * cannot trigger a stale onerror/onclose callback against UI state that
     * has already been reset.
     */
    const resetConnections = useCallback(() => {
        senderChannelsRef.current.forEach(silenceChannel);
        receiverChannelsRef.current.forEach(silenceChannel);
        senderChannelsRef.current = [];
        receiverChannelsRef.current = [];

        if (senderPCRef.current) {
            senderPCRef.current.onicecandidate = null;
            senderPCRef.current.onconnectionstatechange = null;
            senderPCRef.current.close();
            senderPCRef.current = null;
        }
        if (receiverPCRef.current) {
            receiverPCRef.current.onicecandidate = null;
            receiverPCRef.current.onconnectionstatechange = null;
            receiverPCRef.current.ondatachannel = null;
            receiverPCRef.current.close();
            receiverPCRef.current = null;
        }

        senderICEQueue.current = [];
        receiverICEQueue.current = [];
        setSendProgress(0);
        setReceiveProgress(0);
        setDownloadUrl(null);
    }, []);

    // ── SENDER ────────────────────────────────────────────────────────────────
    const initializeSender = useCallback(async (
        fileHash:   string,
        passphrase: string,
        uploadSalt: Uint8Array,
        targetId:   string
    ) => {
        try {
            console.log(`🚀 initializeSender → target=${targetId}`);
            setStatusMessage('Initializing sender...');
            setSendProgress(0);
            senderICEQueue.current = [];

            // Detach + close any previous sender session cleanly before starting a new one
            senderChannelsRef.current.forEach(silenceChannel);
            senderPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            senderPCRef.current = pc;

            const channels: RTCDataChannel[] = Array.from({length:N_CHANNELS}, (_,i) => {
                const dc = pc.createDataChannel(`sharex-pipe-${i}`, {ordered:true});
                dc.bufferedAmountLowThreshold = BUFFER_LOW;
                return dc;
            });
            senderChannelsRef.current = channels;

            pc.onicecandidate = e => {
                if (e.candidate) sendSignalRef.current(targetId,{
                    type:'candidate', candidate:e.candidate, role:'sender'
                });
            };
            pc.onconnectionstatechange = () => {
                console.log('Sender:', pc.connectionState);
                if (pc.connectionState==='failed') setStatusMessage('❌ P2P connection failed.');
            };

            channels[0].onopen = async () => {
                console.log('✅ Channel 0 open — starting handshake');
                setStatusMessage('🔒 Channel open. Handshaking with receiver...');

                try {
                    const totalChunks = await db.fileChunks
                        .where('fileHash').equals(fileHash).count();

                    if (totalChunks === 0) {
                        setStatusMessage('⚠️ No chunks in DB — did encryption finish?');
                        return;
                    }

                    channels[0].send(makeCountPacket(totalChunks));
                    channels[0].send(makeSaltPacket(uploadSalt));
                    setStatusMessage('⏳ Waiting for receiver to choose save location...');

                    await new Promise<void>((resolve, reject) => {
                        const tid = setTimeout(
                            () => reject(new Error('READY timeout — receiver took >60 s')),
                            60_000
                        );
                        channels[0].onmessage = (msg: MessageEvent) => {
                            if (msg.data instanceof ArrayBuffer) {
                                const v = new Uint8Array(msg.data);
                                if (v[0] === TYPE_READY) {
                                    clearTimeout(tid);
                                    channels[0].onmessage = null;
                                    resolve();
                                }
                            }
                        };
                    });

                    setStatusMessage('📤 Streaming across 4 parallel channels...');

                    const chunks = await db.fileChunks
                        .where('fileHash').equals(fileHash)
                        .sortBy('chunkIndex');

                    for (let i = 0; i < chunks.length; i++) {
                        const dc = channels[i % N_CHANNELS];

                        if (dc.readyState !== 'open') {
                            setStatusMessage('❌ Channel closed mid-transfer.');
                            return;
                        }

                        if (dc.bufferedAmount > BUFFER_HIGH) {
                            await waitForDrain(dc);
                        }

                        dc.send(makeChunkPacket(
                            chunks[i].chunkIndex,
                            new Uint8Array(chunks[i].data)
                        ));

                        const pct = Math.round(((i+1)/totalChunks)*100);
                        setSendProgress(pct);
                        if (i % 200 === 0 || i === chunks.length-1) {
                            setStatusMessage(`📤 Sending ${pct}% (${i+1}/${totalChunks})`);
                        }
                    }

                    channels.forEach(dc => { if (dc.readyState==='open') dc.send(makeEOFPacket()); });
                    setSendProgress(100);
                    setStatusMessage('✅ All chunks sent!');
                    onSendCompleteRef.current?.();

                } catch (err) {
                    console.error('Sender streaming error:', err);
                    setStatusMessage(`❌ Transfer failed: ${(err as Error).message}`);
                }
            };

            // FIX: only log real errors. RTCDataChannel fires onerror/onclose as
            // part of NORMAL teardown when the parent PeerConnection closes —
            // that produces an empty-looking RTCErrorEvent ({}) and is not a bug.
            // RTCPeerConnection.connectionState only has 'closed' (not 'closing')
            // as a terminal value, so we check just that.
            channels[0].onerror = (e) => {
                if (pc.connectionState === 'closed') {
                    return; // expected teardown noise, not a real error
                }
                console.error('Channel 0 error:', (e as RTCErrorEvent).error ?? e);
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignalRef.current(targetId, {type:'offer', sdp:offer.sdp});
            setStatusMessage('📡 Offer sent. Waiting for peer to connect...');

        } catch (err) {
            console.error('initializeSender error:', err);
            setStatusMessage('Failed to start sender.');
        }
    }, [setStatusMessage]);

    // ── RECEIVER ──────────────────────────────────────────────────────────────
    const initializeReceiver = useCallback(async (
        remoteOfferSDP: string,
        passphrase:     string,
        senderId:       string
    ) => {
        try {
            console.log(`📥 initializeReceiver ← offer from ${senderId}`);
            setStatusMessage('Connecting to sender...');
            setReceiveProgress(0);
            setDownloadUrl(null);
            receiverICEQueue.current = [];

            receiverChannelsRef.current.forEach(silenceChannel);
            receiverPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            receiverPCRef.current = pc;

            pc.onicecandidate = e => {
                if (e.candidate) sendSignalRef.current(senderId,{
                    type:'candidate', candidate:e.candidate, role:'receiver'
                });
            };
            pc.onconnectionstatechange = () => {
                console.log('Receiver:', pc.connectionState);
                if (pc.connectionState==='connected') setStatusMessage('🔗 Connected! Setting up...');
                if (pc.connectionState==='failed')    setStatusMessage('❌ P2P connection failed.');
            };

            let totalChunks    = 0;
            let chunksWritten  = 0;
            let derivedKey:    CryptoKey | null = null;
            let keyJwk:        JsonWebKey | null = null;
            let writableStream: FileSystemWritableFileStream | null = null;
            const fallbackBuffer: ArrayBuffer[] = [];
            let eofCount   = 0;
            let setupDone  = false;
            let ch0Ref:    RTCDataChannel | null = null;

            // FIX: writer is now a SequentialWriter — decrypt and disk-write are
            // decoupled pipelines. Decrypt releases its semaphore slot as soon as
            // the worker responds; the actual disk write happens asynchronously
            // via the writer's internal drain loop, never blocking the next
            // chunk's decrypt from starting.
            let writer: SequentialWriter | null = null;

            const chunkPromises = new Set<Promise<void>>();
            const decryptLimiter = new Semaphore(MAX_INFLIGHT_DECRYPTS);
            const msgQueue: {type:number; body:Uint8Array<ArrayBuffer>}[] = [];

            const supportsFilePicker = typeof (window as any).showSaveFilePicker === 'function';

            function reportProgress() {
                chunksWritten++;
                const pct = totalChunks > 0 ? Math.round((chunksWritten/totalChunks)*100) : 0;
                setReceiveProgress(pct);
                if (chunksWritten%200===0 || chunksWritten===totalChunks) {
                    setStatusMessage(`📥 Receiving ${pct}% (${chunksWritten}/${totalChunks})`);
                }
            }

            /**
             * Decrypt one chunk, then hand it to the SequentialWriter and return
             * immediately (don't wait for the disk write to finish). The
             * semaphore slot is released right after decrypt completes, so the
             * NEXT chunk's decrypt can start on a free worker while THIS chunk's
             * write is still queued/in-flight on disk.
             */
            async function processChunk(body: Uint8Array<ArrayBuffer>) {
                await decryptLimiter.acquire();
                let idx = -1;
                try {
                    idx = (body[0]<<24)|(body[1]<<16)|(body[2]<<8)|body[3];
                    const encBuf = body.buffer.slice(body.byteOffset+4) as ArrayBuffer;
                    const dec    = await decryptOnWorker(encBuf, keyJwk!, idx);

                    // Release the decrypt slot NOW — writing happens off to the side.
                    decryptLimiter.release();

                    if (writer) {
                        await writer.push(idx * PLAIN_CHUNK_SIZE, dec);
                    } else {
                        fallbackBuffer[idx] = dec;
                    }
                    reportProgress();
                } catch (e) {
                    console.error(`Decrypt/write failed for chunk ${idx}:`, e);
                    setStatusMessage('❌ Decryption failed — wrong passphrase?');
                    decryptLimiter.release();
                }
            }

            async function handleEOF() {
                eofCount++;
                console.log(`EOF ${eofCount}/${N_CHANNELS}`);
                if (eofCount < N_CHANNELS) return;

                if (chunkPromises.size > 0) {
                    console.log(`⏳ Waiting for ${chunkPromises.size} in-flight chunk(s)...`);
                    await Promise.allSettled(chunkPromises);
                }

                // Make sure every queued disk write has actually landed before close()
                if (writer) await writer.flush();

                setStatusMessage('💾 Finalizing...');
                try {
                    if (writableStream) {
                        await writableStream.close();
                        setStatusMessage(`✅ Saved! ${chunksWritten}/${totalChunks} chunks.`);
                    } else {
                        const blob = new Blob(
                            Array.from({length:fallbackBuffer.length},
                                (_,i) => new Uint8Array(fallbackBuffer[i]??new ArrayBuffer(0))),
                            {type:'application/octet-stream'}
                        );
                        setDownloadUrl(URL.createObjectURL(blob));
                        setStatusMessage('✅ Done! Click below to save.');
                    }
                    setReceiveProgress(100);
                    onReceiveCompleteRef.current?.();
                } catch(e) {
                    console.error('Finalize error:',e);
                    setStatusMessage('❌ Failed to finalize file.');
                }
            }

            function trackChunk(p: Promise<void>): Promise<void> {
                chunkPromises.add(p);
                p.finally(() => chunkPromises.delete(p));
                return p;
            }

            async function drainQueue() {
                while (msgQueue.length > 0) {
                    const {type,body} = msgQueue.shift()!;
                    if (type===TYPE_CHUNK) {
                        trackChunk(processChunk(body));
                    } else if (type===TYPE_EOF) {
                        await handleEOF();
                    }
                }
            }

            async function doSetup(saltBody: Uint8Array<ArrayBuffer>) {
                derivedKey = await deriveKey(passphrase, saltBody);
                keyJwk     = await crypto.subtle.exportKey('jwk', derivedKey);

                if (supportsFilePicker) {
                    setStatusMessage('💾 Choose where to save the file...');
                    try {
                        const handle = await (window as any).showSaveFilePicker({
                            suggestedName: 'downloaded_file'
                        });
                        writableStream = await handle.createWritable();
                    } catch (e:any) {
                        if (e.name==='AbortError') {
                            setStatusMessage('❌ Cancelled.'); pc.close(); return;
                        }
                        console.warn('Picker failed, RAM fallback:', e);
                    }
                } else {
                    setStatusMessage('⚠️ RAM mode (no File System Access API).');
                }

                writer = new SequentialWriter(writableStream);

                setupDone = true;
                ch0Ref?.send(makeReadyPacket());
                setStatusMessage('🔑 Ready. Receiving on 4 channels...');

                await drainQueue();
            }

            pc.ondatachannel = (event) => {
                const ch = event.channel;
                ch.binaryType = 'arraybuffer';
                console.log(`📡 DataChannel open: ${ch.label}`);

                receiverChannelsRef.current.push(ch);
                if (ch.label === 'sharex-pipe-0') ch0Ref = ch;

                ch.onmessage = async (msg: MessageEvent) => {
                    if (!(msg.data instanceof ArrayBuffer)) return;

                    const raw  = new Uint8Array(msg.data);
                    const type = raw[0];
                    const body = copyBuf(raw,1);

                    switch(type) {
                        case TYPE_COUNT:
                            totalChunks = (body[0]<<24)|(body[1]<<16)|(body[2]<<8)|body[3];
                            console.log(`📊 Expecting ${totalChunks} chunks`);
                            break;

                        case TYPE_SALT:
                            await doSetup(body);
                            break;

                        case TYPE_CHUNK:
                        case TYPE_EOF:
                            if (!setupDone) {
                                msgQueue.push({type, body});
                            } else if (type===TYPE_CHUNK) {
                                trackChunk(processChunk(body));
                            } else {
                                await handleEOF();
                            }
                            break;

                        default:
                            console.warn(`Unknown packet 0x${type.toString(16)}`);
                    }
                };

                // FIX: same teardown-noise guard as the sender side.
                // RTCPeerConnection.connectionState's terminal value is 'closed'
                // only — 'closing' is not part of its type, that belongs to
                // RTCDataChannel.readyState instead.
                ch.onerror = (e) => {
                    if (pc.connectionState === 'closed') {
                        return;
                    }
                    console.error(`Channel ${ch.label} error:`, (e as RTCErrorEvent).error ?? e);
                };
            };

            await pc.setRemoteDescription(
                new RTCSessionDescription({type:'offer', sdp:remoteOfferSDP})
            );
            for (const c of receiverICEQueue.current) {
                await pc.addIceCandidate(new RTCIceCandidate(c));
            }
            receiverICEQueue.current = [];

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignalRef.current(senderId,{type:'answer', sdp:answer.sdp});
            setStatusMessage('📡 Answer sent. Establishing connection...');

        } catch (err) {
            console.error('initializeReceiver error:', err);
            setStatusMessage('Failed to connect to sender.');
        }
    }, [setStatusMessage]);

    const handleIncomingSignal = useCallback(async (signal:any) => {
        try {
            if (signal.type==='answer') {
                const pc = senderPCRef.current;
                if (!pc) { console.warn('answer: no senderPC'); return; }
                if (pc.signalingState!=='have-local-offer') {
                    console.warn(`Ignoring answer — state='${pc.signalingState}'`); return;
                }
                await pc.setRemoteDescription(
                    new RTCSessionDescription({type:'answer', sdp:signal.sdp})
                );
                console.log('✅ Answer applied to senderPC');

            } else if (signal.type==='candidate' && signal.candidate) {
                const fromReceiver = signal.role==='receiver';
                const pc    = fromReceiver ? senderPCRef.current   : receiverPCRef.current;
                const queue = fromReceiver ? senderICEQueue         : receiverICEQueue;
                if (!pc) return;
                if (!pc.remoteDescription) queue.current.push(signal.candidate);
                else await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            }
        } catch(err) {
            console.error('handleIncomingSignal:', err);
        }
    }, []);

    useEffect(() => () => {
        senderChannelsRef.current.forEach(silenceChannel);
        receiverChannelsRef.current.forEach(silenceChannel);
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
        resetConnections,
    };
}
'use client';

/**
 * useWebRTC.ts — 4-channel parallel WebRTC file transfer
 *
 * ── FIX (90MB+ stall) ─────────────────────────────────────────────────────────
 * Root cause: the receiver dispatched a decryptOnWorker() call for EVERY
 * incoming chunk immediately, with no concurrency limit. With 4 DataChannels
 * delivering chunks simultaneously and no backpressure on the *receiving* side,
 * thousands of pending Promises piled up in each worker's `pending` Map faster
 * than the 4 workers could process them. For small files (<~20MB / ~1300 chunks)
 * this never became visible; for 90MB+ files (~5800+ chunks) the queue grew
 * until the tab's event loop or worker postMessage queue choked and the
 * transfer appeared to "stop midway" with no error.
 *
 * Fix: a receiver-side semaphore (MAX_INFLIGHT_DECRYPTS) caps how many chunks
 * are being decrypted at once, regardless of how fast they arrive across the
 * 4 channels. Extra incoming chunks wait in a FIFO queue and are processed as
 * slots free up — exactly mirroring the bounded concurrency already used on
 * the sender/encrypt side in chunker.ts.
 *
 * ── FIX (close-race) ──────────────────────────────────────────────────────────
 * handleEOF() now awaits all in-flight chunkPromises via Promise.allSettled
 * before calling writableStream.close(), preventing "Cannot write to a
 * closing writable stream".
 *
 * Packet protocol (same on all 4 channels):
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
const BUFFER_HIGH       = 8 * 1024 * 1024;   // pause sending above 8 MB buffered
const BUFFER_LOW        = 2 * 1024 * 1024;   // resume below 2 MB
const N_DECRYPT_WORKERS = 4;

/**
 * Maximum chunks being decrypted simultaneously on the receiver.
 * This is the fix for the 90MB+ stall: without this cap, chunks arriving
 * across 4 parallel DataChannels can outpace the 4 decrypt workers by a wide
 * margin, queuing thousands of pending postMessage calls and effectively
 * freezing progress with no visible error.
 *
 * Set to N_DECRYPT_WORKERS × 6 — enough to keep all workers saturated without
 * unbounded queue growth.
 */
const MAX_INFLIGHT_DECRYPTS = N_DECRYPT_WORKERS * 6; // 24

// ── Packet type tags ──────────────────────────────────────────────────────────
const TYPE_COUNT = 0x01;
const TYPE_SALT  = 0x02;
const TYPE_CHUNK = 0x03;
const TYPE_EOF   = 0x04;
const TYPE_READY = 0x05;

// ── Packet builders ───────────────────────────────────────────────────────────
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

/**
 * Bounded-concurrency semaphore.
 * acquire() resolves immediately if under the limit, otherwise queues the
 * caller and resolves it once a release() frees a slot.
 */
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
        if (next) { next(); }      // hand the slot directly to the next waiter
        else { this.active--; }    // no one waiting — free the slot
    }
}

// ── Hook interface ────────────────────────────────────────────────────────────
interface UseWebRTCOptions {
    sendSignal:       (targetId:string, signalData:any) => void;
    setStatusMessage: (msg:string) => void;
    onSendComplete?:  () => void;   // fired once on the sender after final EOF
    onReceiveComplete?: () => void; // fired once on the receiver after file is closed
}

export function useWebRTC({sendSignal, setStatusMessage, onSendComplete, onReceiveComplete}: UseWebRTCOptions) {
    const senderPCRef   = useRef<RTCPeerConnection|null>(null);
    const receiverPCRef = useRef<RTCPeerConnection|null>(null);

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

    /** Fully tear down both peer connections — used by "send another file" reset. */
    const resetConnections = useCallback(() => {
        senderPCRef.current?.close();
        senderPCRef.current = null;
        receiverPCRef.current?.close();
        receiverPCRef.current = null;
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
            senderPCRef.current?.close();

            const pc = new RTCPeerConnection(rtcConfig);
            senderPCRef.current = pc;

            // Create all 4 channels BEFORE creating the offer (order matters —
            // see header comment in the previous revision for the deadlock this avoids).
            const channels: RTCDataChannel[] = Array.from({length:N_CHANNELS}, (_,i) => {
                const dc = pc.createDataChannel(`sharex-pipe-${i}`, {ordered:true});
                dc.bufferedAmountLowThreshold = BUFFER_LOW;
                return dc;
            });

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

            channels[0].onerror = e => console.error('Channel 0 error:', e);

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

            // Tracks every in-flight decrypt+write promise so handleEOF() can
            // wait for all of them before closing the file stream.
            const chunkPromises = new Set<Promise<void>>();

            // FIX (90MB+ stall): bounded concurrency for decrypt dispatch.
            // Without this, all 4 channels could fire processChunk() simultaneously
            // for every arriving chunk, flooding the 4 workers' pending Maps faster
            // than they could resolve, eventually stalling the whole pipeline.
            const decryptLimiter = new Semaphore(MAX_INFLIGHT_DECRYPTS);

            const msgQueue: {type:number; body:Uint8Array<ArrayBuffer>}[] = [];

            const supportsFilePicker = typeof (window as any).showSaveFilePicker === 'function';

            async function writeToDisk(idx: number, decrypted: ArrayBuffer) {
                if (writableStream) {
                    await writableStream.write({
                        type:     'write',
                        position: idx * PLAIN_CHUNK_SIZE,
                        data:     decrypted,
                    });
                } else {
                    fallbackBuffer[idx] = decrypted;
                }
                chunksWritten++;
                const pct = totalChunks > 0
                    ? Math.round((chunksWritten/totalChunks)*100) : 0;
                setReceiveProgress(pct);
                if (chunksWritten%200===0 || chunksWritten===totalChunks) {
                    setStatusMessage(`📥 Receiving ${pct}% (${chunksWritten}/${totalChunks})`);
                }
            }

            /**
             * Decrypt one chunk off-thread then write to disk.
             * Acquires a semaphore slot BEFORE dispatching to a worker, and
             * releases it in a finally block so a failed decrypt still frees
             * the slot for the next queued chunk.
             */
            async function processChunk(body: Uint8Array<ArrayBuffer>) {
                await decryptLimiter.acquire();
                try {
                    const idx    = (body[0]<<24)|(body[1]<<16)|(body[2]<<8)|body[3];
                    const encBuf = body.buffer.slice(body.byteOffset+4) as ArrayBuffer;
                    const dec    = await decryptOnWorker(encBuf, keyJwk!, idx);
                    await writeToDisk(idx, dec);
                } catch (e) {
                    console.error('Decrypt/write failed:', e);
                    setStatusMessage('❌ Decryption failed — wrong passphrase?');
                } finally {
                    decryptLimiter.release();
                }
            }

            async function handleEOF() {
                eofCount++;
                console.log(`EOF ${eofCount}/${N_CHANNELS}`);
                if (eofCount < N_CHANNELS) return;

                if (chunkPromises.size > 0) {
                    console.log(`⏳ Waiting for ${chunkPromises.size} in-flight chunk(s) before close...`);
                    await Promise.allSettled(chunkPromises);
                }

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
                        // Fire-and-track, don't await sequentially — the semaphore
                        // inside processChunk already bounds concurrency, so we can
                        // let multiple queued chunks race for slots in parallel.
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

                setupDone = true;
                ch0Ref?.send(makeReadyPacket());
                setStatusMessage('🔑 Ready. Receiving on 4 channels...');

                await drainQueue();
            }

            pc.ondatachannel = (event) => {
                const ch = event.channel;
                ch.binaryType = 'arraybuffer';
                console.log(`📡 DataChannel open: ${ch.label}`);

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
                                // Don't await here — let the semaphore bound concurrency
                                // while allowing all 4 channels to keep delivering.
                                trackChunk(processChunk(body));
                            } else {
                                await handleEOF();
                            }
                            break;

                        default:
                            console.warn(`Unknown packet 0x${type.toString(16)}`);
                    }
                };

                ch.onerror = e => console.error(`Channel ${ch.label} error:`, e);
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
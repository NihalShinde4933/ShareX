/**
 * chunker.ts — parallel encryption using a pool of Web Workers
 *
 * FIX (AbortError / BulkError during bulkPut):
 * ──────────────────────────────────────────────────────────────────────────
 * The transaction abort was caused by db.ts creating a fresh Dexie instance
 * on every Fast Refresh (see db.ts fix). As a defense-in-depth measure, every
 * bulkPut here is now wrapped in a small retry helper: if the underlying IDB
 * connection was forcibly closed mid-write, we re-open (Dexie does this
 * automatically on next call) and retry once before giving up. This makes
 * the encryption pipeline resilient to a stray HMR reload without silently
 * losing chunks.
 *
 * FIX (slow encryption / worker overhead):
 * ──────────────────────────────────────────────────────────────────────────
 * Each encrypt job previously sent ONE 16 KB chunk per postMessage call.
 * postMessage has fixed per-call overhead (structured clone + thread hop)
 * that's significant relative to a 16 KB AES-GCM operation (~0.05ms of actual
 * crypto work vs ~0.3-0.5ms of message-passing overhead). For a 97 MB file
 * (~6225 chunks) that overhead alone could account for several seconds.
 *
 * Fix: chunks are now batched — each worker message carries BATCH_SIZE plain
 * buffers at once, encrypts all of them in a single loop inside the worker,
 * and returns a single response with BATCH_SIZE encrypted buffers. This cuts
 * postMessage call count by BATCH_SIZE×, with a proportional reduction in
 * cross-thread overhead while keeping core AES-GCM throughput unchanged.
 *
 * Requires the matching batch-aware cryptoWorker.js (op: 'encryptBatch').
 */

import { db } from '../lib/db';

const N_WORKERS     = 4;
const BATCH_SIZE    = 16;                 // chunks per worker message
const CONCURRENCY   = N_WORKERS * 4;      // batches in-flight at once (≈ 256 chunks)
const DB_BATCH_SIZE = 128;

type PendingResolve = (bufs: ArrayBuffer[]) => void;
type PendingReject  = (err: Error) => void;

interface WorkerSlot {
    worker:  Worker;
    pending: Map<number, { resolve: PendingResolve; reject: PendingReject }>;
}

let workerPool: WorkerSlot[] | null = null;
let batchIdCounter = 0;

function getPool(): WorkerSlot[] {
    if (workerPool) return workerPool;
    workerPool = Array.from({ length: N_WORKERS }, () => {
        const worker = new Worker('/workers/cryptoWorker.js');
        const slot: WorkerSlot = { worker, pending: new Map() };

        worker.onmessage = (e: MessageEvent) => {
            const { id, results, error } = e.data;
            const cb = slot.pending.get(id);
            if (!cb) return;
            slot.pending.delete(id);
            if (error) cb.reject(new Error(error));
            else       cb.resolve(results as ArrayBuffer[]);
        };

        worker.onerror = (e) => console.error('Crypto worker fatal error:', e);

        return slot;
    });
    return workerPool;
}

/**
 * Encrypt a batch of raw buffers in a single worker round-trip.
 * Returns results in the SAME ORDER as the input buffers.
 */
function encryptBatchOnWorker(raws: ArrayBuffer[], keyJwk: JsonWebKey): Promise<ArrayBuffer[]> {
    const pool = getPool();
    const slot = pool.reduce((best, s) => s.pending.size < best.pending.size ? s : best);
    const id   = batchIdCounter++;

    return new Promise((resolve, reject) => {
        slot.pending.set(id, { resolve, reject });
        slot.worker.postMessage(
            { op: 'encryptBatch', id, rawBuffers: raws, keyJwk },
            raws   // transfer every buffer in the batch, zero-copy
        );
    });
}

async function exportKeyJwk(key: CryptoKey): Promise<JsonWebKey> {
    return crypto.subtle.exportKey('jwk', key);
}

/** Retry a bulkPut once if the IDB connection was force-closed mid-write. */
async function bulkPutWithRetry(
    rows: { fileHash: string; chunkIndex: number; data: ArrayBuffer }[]
): Promise<void> {
    try {
        await db.fileChunks.bulkPut(rows);
    } catch (err) {
        console.warn('bulkPut failed, retrying once:', err);
        // Small delay lets Dexie's auto-reopen logic settle before retry.
        await new Promise(r => setTimeout(r, 50));
        await db.fileChunks.bulkPut(rows);
    }
}

export async function sliceFileIntoChunks(
    file: File,
    chunkSize: number = 16384,
    key: CryptoKey,
    fileHash: string,
    onProgress?: (done: number, total: number) => void
): Promise<void> {
    const totalChunks = Math.ceil(file.size / chunkSize);
    let keyJwk: JsonWebKey;

    try {
        keyJwk = await exportKeyJwk(key);
    } catch {
        console.warn('Key not extractable; falling back to sequential encryption');
        return sliceSequential(file, chunkSize, key, fileHash, onProgress);
    }

    const inFlight: Promise<void>[] = [];
    const dbBatch: { fileHash: string; chunkIndex: number; data: ArrayBuffer }[] = [];
    let completedCount = 0;

    async function flushBatch() {
        if (dbBatch.length === 0) return;
        const rows = [...dbBatch];
        dbBatch.length = 0;
        await bulkPutWithRetry(rows);
    }

    // ── Group chunks into BATCH_SIZE-sized worker jobs ─────────────────────────
    const totalBatches = Math.ceil(totalChunks / BATCH_SIZE);

    for (let b = 0; b < totalBatches; b++) {
        const batchStart = b * BATCH_SIZE;
        const batchEnd   = Math.min(batchStart + BATCH_SIZE, totalChunks);
        const indices    = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);

        // Bound concurrency at the BATCH level — each unit of work is now a
        // batch of BATCH_SIZE chunks rather than a single chunk.
        if (inFlight.length >= CONCURRENCY) {
            await inFlight[b - CONCURRENCY];
        }

        const job = (async (idxList: number[]) => {
            // Read all raw slices for this batch from disk (lazy via File.slice)
            const raws = await Promise.all(idxList.map(async idx => {
                const start = idx * chunkSize;
                const end   = Math.min(start + chunkSize, file.size);
                return file.slice(start, end).arrayBuffer();
            }));

            const encrypted = await encryptBatchOnWorker(raws, keyJwk);

            for (let k = 0; k < idxList.length; k++) {
                dbBatch.push({ fileHash, chunkIndex: idxList[k], data: encrypted[k] });
            }

            completedCount += idxList.length;
            onProgress?.(completedCount, totalChunks);

            if (dbBatch.length >= DB_BATCH_SIZE) {
                await flushBatch();
            }
        })(indices);

        inFlight.push(job);
    }

    await Promise.all(inFlight);
    await flushBatch();

    const storedCount = await db.fileChunks.where('fileHash').equals(fileHash).count();
    if (storedCount !== totalChunks) {
        throw new Error(
            `Encryption incomplete: expected ${totalChunks} chunks, only ${storedCount} stored.`
        );
    }

    console.log(`✅ Encrypted ${totalChunks} chunks in ${totalBatches} batches (${N_WORKERS} workers)`);
}

async function sliceSequential(
    file: File,
    chunkSize: number,
    key: CryptoKey,
    fileHash: string,
    onProgress?: (done: number, total: number) => void
): Promise<void> {
    const totalChunks = Math.ceil(file.size / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
        const start  = i * chunkSize;
        const end    = Math.min(start + chunkSize, file.size);
        const raw    = await file.slice(start, end).arrayBuffer();
        const iv     = crypto.getRandomValues(new Uint8Array(12));
        const ct     = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, raw);
        const out    = new Uint8Array(12 + ct.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(ct), 12);

        await bulkPutWithRetry([{ fileHash, chunkIndex: i, data: out.buffer }]);
        onProgress?.(i + 1, totalChunks);
    }
}

export async function clearChunks(fileHash: string): Promise<void> {
    await db.fileChunks.where('fileHash').equals(fileHash).delete();
}
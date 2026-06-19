/**
 * db.ts — Dexie (IndexedDB) wrapper for storing encrypted file chunks
 *
 * FIX (AbortError: "Force close delete origin" / transaction aborted):
 * ──────────────────────────────────────────────────────────────────────
 * This error means the IndexedDB connection itself was forcibly closed while
 * a bulkPut transaction was in flight. The most common causes:
 *   1. Next.js Fast Refresh re-evaluating this module during development,
 *      which previously created a BRAND NEW Dexie instance on every hot
 *      reload — orphaning the old `db` object (and its open connection)
 *      while encryption was still using it.
 *   2. DevTools > Application > Clear storage, or a privacy extension,
 *      issuing IDBFactory.deleteDatabase() concurrently.
 *   3. Multiple tabs/instances of the dev server racing on the same DB name.
 *
 * Fix: use `globalThis` to cache a SINGLE Dexie instance across module
 * re-evaluations. Fast Refresh re-runs this file's top-level code, but
 * because we stash the instance on globalThis (which survives module
 * re-execution within the same browser tab), we never create a second
 * connection that competes with the first.
 *
 * We also explicitly do NOT call db.close() anywhere in the app — the
 * connection should live for the lifetime of the tab.
 */

import { Dexie, type Table } from 'dexie';

export interface FileChunkRecord {
    fileHash:   string;
    chunkIndex: number;
    data:       ArrayBuffer;
}

class ShareXDB extends Dexie {
    fileChunks!: Table<FileChunkRecord, [string, number]>;

    constructor() {
        super('ShareXDB');
        this.version(1).stores({
            // Compound primary key prevents collisions between concurrent
            // uploads that happen to share a chunkIndex.
            fileChunks: '[fileHash+chunkIndex], fileHash',
        });
    }
}

// ── Singleton across Fast Refresh / HMR re-evaluations ────────────────────────
const g = globalThis as unknown as { __shareXDb?: ShareXDB };

export const db: ShareXDB = g.__shareXDb ?? (g.__shareXDb = new ShareXDB());
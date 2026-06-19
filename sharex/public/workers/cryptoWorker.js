/**
 * cryptoWorker.js — AES-GCM encrypt/decrypt Web Worker, batch-aware
 *
 * FIX (slow encryption on large files):
 * Previously every chunk was its own postMessage round-trip. For a 97 MB
 * file (~6225 × 16 KB chunks) that's 6225 separate structured-clone +
 * thread-hop operations, each costing roughly 10x more wall-clock time than
 * the actual AES-GCM operation itself. This worker now also supports
 * 'encryptBatch' / 'decryptBatch' ops that process N buffers per message,
 * amortizing the messaging overhead across the whole batch.
 *
 * Single-buffer 'encrypt'/'decrypt' ops are still supported for backward
 * compatibility with any caller that hasn't switched to batching.
 */

let cachedKey = null;
let cachedKeyId = null;

async function importKey(jwk) {
    // Cache the imported CryptoKey by its raw key material (`k` field) so
    // repeated batches against the same key skip the importKey cost.
    if (cachedKeyId === jwk.k && cachedKey) return cachedKey;
    cachedKey = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
    cachedKeyId = jwk.k;
    return cachedKey;
}

async function encryptOne(raw, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, raw);
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return out.buffer;
}

async function decryptOne(combined, key) {
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ct);
}

self.onmessage = async (event) => {
    const { op, id, keyJwk } = event.data;

    try {
        const key = await importKey(keyJwk);

        if (op === 'encrypt') {
            const result = await encryptOne(event.data.rawBuffer, key);
            self.postMessage({ op, id, result }, [result]);

        } else if (op === 'decrypt') {
            const result = await decryptOne(event.data.encryptedBuffer, key);
            self.postMessage({ op, id, result }, [result]);

        } else if (op === 'encryptBatch') {
            const { rawBuffers } = event.data;
            const results = [];
            for (const raw of rawBuffers) {
                results.push(await encryptOne(raw, key));
            }
            // Transfer every result buffer back, zero-copy
            self.postMessage({ op, id, results }, results);

        } else if (op === 'decryptBatch') {
            const { encryptedBuffers } = event.data;
            const results = [];
            for (const buf of encryptedBuffers) {
                results.push(await decryptOne(buf, key));
            }
            self.postMessage({ op, id, results }, results);

        } else {
            self.postMessage({ op, id, error: `Unknown op: ${op}` });
        }

    } catch (err) {
        self.postMessage({ op, id, error: err.message ?? String(err) });
    }
};
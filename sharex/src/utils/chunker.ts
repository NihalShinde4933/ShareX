import { db } from "../lib/db";
import { encryptChunk } from './crypto';

/**
 * Persists an encrypted chunk to IndexedDB.
 * Must be awaited — fire-and-forget here causes race conditions where
 * the sender starts streaming before all chunks are written.
 */
async function saveToDB(fileHash: string, chunkIndex: number, chunk: ArrayBuffer): Promise<void> {
    await db.fileChunks.put({
        fileHash,
        chunkIndex,
        data: chunk
    });
}

/** Converts a Blob slice into a raw ArrayBuffer. */
export async function processBlob(blob: Blob): Promise<ArrayBuffer> {
    return await blob.arrayBuffer();
}

/**
 * Slices a File into 16 KB chunks, encrypts each one, and saves them to IndexedDB.
 *
 * FIX: saveToDB is now awaited on every iteration — previously it was fire-and-forget,
 * meaning registerFile() could be called before any chunks actually landed in the DB,
 * causing the sender to stream zero bytes.
 *
 * Salt handling: the caller generates a random salt ONCE, derives the key from it,
 * and passes the key here. The salt itself must be sent to the receiver as the first
 * unencrypted message over the WebRTC data channel (handled in useWebRTC).
 */
export async function sliceFileIntoChunks(
    file: File,
    chunkSize: number = 16384,
    key: CryptoKey,
    fileHash: string
): Promise<void> {
    const totalSize = file.size;
    let currentByte = 0;
    let chunkIndex = 0;

    while (currentByte < totalSize) {
        const nextByteLimit = Math.min(currentByte + chunkSize, totalSize);
        const fileSlice = file.slice(currentByte, nextByteLimit);
        const rawBuffer = await processBlob(fileSlice);
        const encryptedChunk = await encryptChunk(rawBuffer, key);

        // FIX: await the DB write — do not fire-and-forget
        await saveToDB(fileHash, chunkIndex, encryptedChunk);

        currentByte = nextByteLimit;
        chunkIndex++;
    }

    console.log(`✅ All ${chunkIndex} chunks encrypted and saved to IndexedDB.`);
}

/** Reassembles an array of raw decrypted ArrayBuffers into a Blob download URL. */
export async function reassembleChunks(arrayBuffers: ArrayBuffer[], mimeType: string): Promise<string> {
    const blob = new Blob(arrayBuffers, { type: mimeType });
    const url = URL.createObjectURL(blob);
    console.log("Download URL created:", url);
    return url;
}
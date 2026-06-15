import { Dexie, type Table } from "dexie";

export interface FileChunk {
    fileHash: string;
    chunkIndex: number;
    data: ArrayBuffer;
}

class ShareXDatabase extends Dexie {
    fileChunks!: Table<FileChunk, [string, number]>;

    constructor() {
        super("ShareXDatabase_v4");
        this.version(1).stores({
            // FIX: Added secondary 'fileHash' index so .where("fileHash").equals(...) works correctly
            fileChunks: "[fileHash+chunkIndex], fileHash",
        });
    }
}

export const db = new ShareXDatabase();
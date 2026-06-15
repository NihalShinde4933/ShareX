import { createClient, RedisClientType } from "redis";
import dotenv from "dotenv";

dotenv.config();

export const redisClient: RedisClientType = createClient({
    url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.error(`❌ Redis error: ${err}`));
redisClient.on('connect', () => console.log('⚡ Connected to Redis'));

export const connectDatabase = async (): Promise<void> => {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }
    } catch (error) {
        console.error('❌ Database connection failure:', error);
        process.exit(1);
    }
};

export const registerSocketSession = async (socketId: string): Promise<void> => {
    try {
        await redisClient.set(`socket:id:${socketId}`, "ACTIVE", { EX: 7200 });
        console.log(`💾 Socket session registered: ${socketId}`);
    } catch (error) {
        console.error('❌ Failed to register socket session:', error);
    }
};

export const storeFileHash = async (fileHash: string, socketId: string): Promise<void> => {
    try {
        if (!fileHash || !socketId) throw new Error("fileHash and socketId are required");

        await redisClient.set(`file:${fileHash}`, socketId, { EX: 3600 });
        await redisClient.set(`socket:file:${socketId}`, fileHash, { EX: 3600 });

        console.log(`📝 Hash ${fileHash} mapped to socket ${socketId}`);
    } catch (error) {
        console.error('❌ Failed to store file hash:', error);
        throw error;
    }
};

export const getFileSession = async (
    fileHash: string
): Promise<{ fileHash: string; socketId: string | null } | null> => {
    try {
        if (!fileHash) throw new Error("fileHash is required");

        const socketId = await redisClient.get(`file:${fileHash}`);
        if (!socketId) {
            console.log(`⚠️ No session found for hash: ${fileHash}`);
            return null;
        }

        const isAlive = await redisClient.get(`socket:id:${socketId}`);
        if (!isAlive) {
            await redisClient.del(`file:${fileHash}`);
            return null;
        }

        return { fileHash, socketId };
    } catch (err) {
        console.error('❌ Failed to fetch file session:', err);
        return null;
    }
};

export const purgeSocketSession = async (socketId: string): Promise<void> => {
    try {
        const associatedFileHash = await redisClient.get(`socket:file:${socketId}`);
        const keysToDelete= [`socket:id:${socketId}`, `socket:file:${socketId}`];

        if (associatedFileHash) {
            keysToDelete.push(`file:${associatedFileHash}`);
            console.log(`🧹 Cleaning up file mapping for hash: ${associatedFileHash}`);
        }

        // FIX: node-redis v4 del() takes rest parameters, not an array.
        // Passing an array silently does nothing; spreading it correctly deletes all keys.
        await redisClient.del(keysToDelete);

        console.log(`🗑️ Session purged for socket: ${socketId}`);
    } catch (error) {
        console.error('❌ Failed to purge session:', error);
    }
};
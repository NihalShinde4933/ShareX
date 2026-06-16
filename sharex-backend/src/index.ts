// Websocket server and router manager
import express from "express";
import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer, WebSocket } from "ws";
import crypto from 'crypto';
import {
    connectDatabase,
    storeFileHash,
    getFileSession,
    registerSocketSession,
    purgeSocketSession
} from "../src/redisClient";

dotenv.config();

const app = express();
const server = http.createServer(app);
app.use(express.json());

const webSocketServer = new WebSocketServer({ server });

// In-memory map of live connections: socketId → WebSocket
const activeConnections = new Map<string, WebSocket>();

webSocketServer.on('connection', async (ws: WebSocket) => {
    const socketId = crypto.randomUUID();
    activeConnections.set(socketId, ws);
    console.log(`🔌 Connected: ${socketId}`);

    await registerSocketSession(socketId);

    // Tell the client their own socket ID immediately
    ws.send(JSON.stringify({ type: "INIT", socketId }));

    ws.on("message", async (messageBuffer: Buffer) => {
        try {
            const data = JSON.parse(messageBuffer.toString());
            console.log(`📥 WS Message from ${socketId}:`, data);

            // ── REGISTER_FILE ─────────────────────────────────────────────────
            // Uploader registers a file hash so downloaders can find them.
            if (data.action === "REGISTER_FILE") {
                const { fileHash } = data;
                if (!fileHash) {
                    ws.send(JSON.stringify({ type: "ERROR", message: "fileHash is required" }));
                    return;
                }
                await storeFileHash(fileHash, socketId);
                ws.send(JSON.stringify({ type: "SUCCESS", message: "File registered." }));
            }

            // ── LOOKUP_FILE ───────────────────────────────────────────────────
            // Downloader looks up a file hash to find the uploader.
            //
            // FIX: Previously the server only replied to the DOWNLOADER with the
            // uploader's socket ID, but never told the UPLOADER that a downloader
            // had found them. The uploader therefore never knew to start a WebRTC
            // offer. Now we:
            //   1. Reply to the DOWNLOADER with the uploader's socket ID (so the
            //      downloader knows who to expect a signal from).
            //   2. Notify the UPLOADER with the downloader's socket ID (so the
            //      uploader knows who to send the WebRTC offer to).
            if (data.action === "LOOKUP_FILE") {
                const { fileHash } = data;
                if (!fileHash) {
                    ws.send(JSON.stringify({ type: "ERROR", message: "fileHash is required" }));
                    return;
                }

                const session = await getFileSession(fileHash);
                if (!session?.socketId) {
                    ws.send(JSON.stringify({ type: "ERROR", message: "File session not found." }));
                    return;
                }

                const uploaderSocketId = session.socketId;

                // Prevent self-lookup (same socket trying to download its own file)
                if (uploaderSocketId === socketId) {
                    ws.send(JSON.stringify({
                        type: "ERROR",
                        message: "You cannot download a file you are hosting on the same connection."
                    }));
                    return;
                }

                // 1. Tell the DOWNLOADER who the uploader is
                ws.send(JSON.stringify({
                    type: "PEER_FOUND",
                    uploaderSocketId
                }));

                // 2. Tell the UPLOADER that this downloader wants their file
                const uploaderSocket = activeConnections.get(uploaderSocketId);
                if (uploaderSocket?.readyState === WebSocket.OPEN) {
                    uploaderSocket.send(JSON.stringify({
                        type: "DOWNLOADER_FOUND",
                        downloaderSocketId: socketId
                    }));
                    console.log(`🔗 Notified uploader ${uploaderSocketId} of downloader ${socketId}`);
                } else {
                    ws.send(JSON.stringify({ type: "ERROR", message: "Uploader is no longer online." }));
                }
            }

            // ── RELAY_SIGNAL ──────────────────────────────────────────────────
            // Passes a WebRTC signal (offer/answer/candidate) to a specific peer.
            if (data.action === "RELAY_SIGNAL") {
                const { targetId, signalData } = data;
                if (!targetId || !signalData) {
                    ws.send(JSON.stringify({ type: "ERROR", message: "targetId and signalData are required." }));
                    return;
                }

                // Prevent a socket from signaling itself
                if (targetId === socketId) {
                    console.warn(`⚠️  ${socketId} tried to signal itself — ignored.`);
                    ws.send(JSON.stringify({ type: "ERROR", message: "Cannot signal yourself." }));
                    return;
                }

                const targetSocket = activeConnections.get(targetId);
                if (targetSocket?.readyState === WebSocket.OPEN) {
                    targetSocket.send(JSON.stringify({
                        type: "SIGNAL",
                        senderId: socketId,
                        signalData
                    }));
                } else {
                    ws.send(JSON.stringify({ type: "ERROR", message: `Peer ${targetId} is not connected.` }));
                }
            }

        } catch (err) {
            console.error("❌ WS message error:", err);
            ws.send(JSON.stringify({ type: "ERROR", message: "Invalid JSON" }));
        }
    });

    ws.on("close", async () => {
        console.log(`❌ Disconnected: ${socketId}`);
        await purgeSocketSession(socketId);
        activeConnections.delete(socketId);
    });

    ws.on("error", (err) => {
        console.error(`⚠️  Socket error on ${socketId}:`, err);
    });
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await connectDatabase();
    server.listen(PORT, () => {
        console.log(`🚀 Server on http://localhost:${PORT}`);
        console.log(`⚡ WebSocket on ws://localhost:${PORT}`);
    });
};

startServer();
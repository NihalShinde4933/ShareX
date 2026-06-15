// Websocket server and router manager
import express, { Request, Response } from "express";
import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer, WebSocket } from "ws";
import crypto from 'crypto';
import { connectDatabase, storeFileHash, getFileSession, registerSocketSession, purgeSocketSession } from "../src/redisClient";


const app = express();
const server = http.createServer(app);

app.use(express.json());

const webSocketServer = new WebSocketServer({ server });


// Optional: For keeping the track of all active socket ids in memory
const activeConnections = new Map<string, WebSocket>();


webSocketServer.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
    // Generating unique identifier for the socket id connection
    const socketId = crypto.randomUUID();
    activeConnections.set(socketId, ws);

    console.log(`🔌 New WS Client connected. Assigned ID: ${socketId}`);

    await registerSocketSession(socketId);

    ws.send(JSON.stringify({
        type: "INIT",
        socketId
    }));

    // Handling the incoming message from the client
    ws.on("message", async (messageBuffer: Buffer) => {
        try {
            const data = JSON.parse(messageBuffer.toString());
            console.log(`📥 WS Message from ${socketId}:`, data);

            if (data.action == "REGISTER_FILE") {
                const { fileHash } = data;
                await storeFileHash(fileHash, socketId);
                ws.send(JSON.stringify({ type: "SUCCESS", message: "Hash stored in Upstash!" }));
            }

            if (data.action == "LOOKUP_FILE") {
                const { fileHash } = data;
                if (!fileHash) {
                    ws.send(JSON.stringify({ type: "ERROR", message: "Filehash is required" }));
                    return;
                }
                const content = await getFileSession(fileHash);
                if (!content || (content && !(content.socketId))) {
                    ws.send(JSON.stringify({ type: "ERROR", message: "Session not found!" }));
                    return;
                }

                ws.send(JSON.stringify({ type: "SUCCESS", message: "Hash stored in Upstash!", data: { "fileHash": content?.fileHash, "socketID": content?.socketId } }));
            }

            if (data.action === "RELAY_SIGNAL") {
                const { targetId, signalData } = data;

                if (!targetId || !signalData) {
                    ws.send(JSON.stringify({ type: "ERROR", message: "targetId and signalData are required for signaling" }));
                    return; // Prevents crashing downstream
                }

                // 1. Locate the live socket connection of the peer we want to reach
                const targetSocket = activeConnections.get(targetId);

                if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                    // 2. Pass the data through smoothly, identifying who sent it (senderId)
                    targetSocket.send(JSON.stringify({
                        type: "SIGNAL",
                        senderId: socketId, // The receiver needs to know who to reply to
                        signalData: signalData
                    }));
                } else {
                    ws.send(JSON.stringify({ type: "ERROR", message: `Peer connection ${targetId} is no longer active` }));
                }
            }
        } catch (error) {
            console.error("❌ Error parsing WS message:", error);
            ws.send(JSON.stringify({ type: "ERROR", message: "Invalid JSON format" }));
        }
    });


    ws.on("close", async () => {
        console.log(`❌ Client ${socketId} disconnected`);
        await purgeSocketSession(socketId);
        activeConnections.delete(socketId);
    });

    ws.on("error", (error) => {
        console.error(`⚠️ Socket Error on ${socketId}:`, error);
    });

});

// Connect Redis and Start the combined server
const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await connectDatabase();

    server.listen(PORT, () => {
        console.log(`🚀 Server listening on http://localhost:${PORT}`);
        console.log(`⚡ WebSocket Server active on ws://localhost:${PORT}`);
    });
};

startServer();







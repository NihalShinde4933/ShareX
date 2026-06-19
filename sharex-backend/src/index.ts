// Websocket server and router manager
// Extended with ROOM-CODE pairing for heavy (unencrypted) large-file transfers,
// alongside the existing hash-based pairing for the small/encrypted flow.

import express from 'express';
import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import {
    connectDatabase,
    storeFileHash,
    getFileSession,
    registerSocketSession,
    purgeSocketSession,
} from '../src/redisClient';

dotenv.config();

const app = express();
const server = http.createServer(app);
app.use(express.json());

const webSocketServer = new WebSocketServer({ server });
const activeConnections = new Map<string, WebSocket>();

// ── Room registry (in-memory; rooms are short-lived, no need for Redis) ──────
// code → { hostSocketId, createdAt }
// Rooms expire after ROOM_TTL_MS to avoid leaking memory if a host never
// completes a transfer and disconnects without cleanup firing correctly.
const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes
const rooms = new Map<string, { hostSocketId: string; createdAt: number }>();

function generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
    let code = '';
    do {
        code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(code)); // extremely unlikely collision, but be safe
    return code;
}

// Periodic sweep for expired rooms
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(code);
    }
}, 5 * 60 * 1000);

webSocketServer.on('connection', async (ws: WebSocket) => {
    const socketId = crypto.randomUUID();
    activeConnections.set(socketId, ws);
    console.log(`🔌 Connected: ${socketId}`);

    await registerSocketSession(socketId);
    ws.send(JSON.stringify({ type: 'INIT', socketId }));

    ws.on('message', async (messageBuffer: Buffer) => {
        try {
            const data = JSON.parse(messageBuffer.toString());
            console.log(`📥 WS Message from ${socketId}:`, data.action);

            // ── Existing hash-based flow (small/encrypted files) ───────────────
            if (data.action === 'REGISTER_FILE') {
                const { fileHash } = data;
                if (!fileHash) { ws.send(JSON.stringify({ type: 'ERROR', message: 'fileHash is required' })); return; }
                await storeFileHash(fileHash, socketId);
                ws.send(JSON.stringify({ type: 'SUCCESS', message: 'File registered.' }));
            }

            if (data.action === 'LOOKUP_FILE') {
                const { fileHash } = data;
                if (!fileHash) { ws.send(JSON.stringify({ type: 'ERROR', message: 'fileHash is required' })); return; }

                const session = await getFileSession(fileHash);
                if (!session?.socketId) { ws.send(JSON.stringify({ type: 'ERROR', message: 'File session not found.' })); return; }

                const uploaderSocketId = session.socketId;
                if (uploaderSocketId === socketId) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Cannot download your own hosted file on the same connection.' }));
                    return;
                }

                ws.send(JSON.stringify({ type: 'PEER_FOUND', uploaderSocketId }));

                const uploaderSocket = activeConnections.get(uploaderSocketId);
                if (uploaderSocket?.readyState === WebSocket.OPEN) {
                    uploaderSocket.send(JSON.stringify({ type: 'DOWNLOADER_FOUND', downloaderSocketId: socketId }));
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Uploader is no longer online.' }));
                }
            }

            // ── NEW: room-code flow (heavy/unencrypted files) ──────────────────
            //
            // CREATE_ROOM: host asks for a fresh code, server mints one and
            // remembers which socket owns it.
            if (data.action === 'CREATE_ROOM') {
                const code = generateRoomCode();
                rooms.set(code, { hostSocketId: socketId, createdAt: Date.now() });
                ws.send(JSON.stringify({ type: 'ROOM_CREATED', code }));
                console.log(`🏠 Room ${code} created by ${socketId}`);
            }

            // JOIN_ROOM: joiner provides a code, server looks up the host and
            // notifies BOTH sides — symmetric to the REGISTER/LOOKUP flow above,
            // but keyed by room code instead of file hash.
            if (data.action === 'JOIN_ROOM') {
                const { code } = data;
                if (!code) { ws.send(JSON.stringify({ type: 'ERROR', message: 'Room code is required.' })); return; }

                const room = rooms.get(String(code).toUpperCase());
                if (!room) { ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found or expired.' })); return; }

                if (room.hostSocketId === socketId) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Cannot join your own room.' }));
                    return;
                }

                const hostSocket = activeConnections.get(room.hostSocketId);
                if (!hostSocket || hostSocket.readyState !== WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Host is no longer online.' }));
                    rooms.delete(String(code).toUpperCase());
                    return;
                }

                // Tell the joiner who the host is
                ws.send(JSON.stringify({ type: 'ROOM_HOST_FOUND', hostSocketId: room.hostSocketId }));

                // Tell the host that a peer joined — this triggers initializeHeavySender
                hostSocket.send(JSON.stringify({ type: 'ROOM_PEER_FOUND', peerSocketId: socketId }));

                console.log(`🤝 ${socketId} joined room ${code} (host: ${room.hostSocketId})`);

                // Room is single-use — remove it once paired so the code can't be reused
                rooms.delete(String(code).toUpperCase());
            }

            // ── Shared signaling relay (used by both flows) ─────────────────────
            if (data.action === 'RELAY_SIGNAL') {
                const { targetId, signalData } = data;
                if (!targetId || !signalData) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'targetId and signalData are required.' }));
                    return;
                }
                if (targetId === socketId) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Cannot signal yourself.' }));
                    return;
                }
                const targetSocket = activeConnections.get(targetId);
                if (targetSocket?.readyState === WebSocket.OPEN) {
                    targetSocket.send(JSON.stringify({ type: 'SIGNAL', senderId: socketId, signalData }));
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: `Peer ${targetId} is not connected.` }));
                }
            }

        } catch (err) {
            console.error('❌ WS message error:', err);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid JSON' }));
        }
    });

    ws.on('close', async () => {
        console.log(`❌ Disconnected: ${socketId}`);
        await purgeSocketSession(socketId);
        activeConnections.delete(socketId);
        // Clean up any room this socket was hosting
        for (const [code, room] of rooms) {
            if (room.hostSocketId === socketId) rooms.delete(code);
        }
    });

    ws.on('error', (err) => console.error(`⚠️  Socket error on ${socketId}:`, err));
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
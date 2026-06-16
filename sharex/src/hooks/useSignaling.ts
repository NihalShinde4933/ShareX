'use client';

import { useRef, useEffect, useState, useCallback } from 'react';

interface UseSignalingOptions {
    onSignalReceived: (senderId: string, signalData: any) => void;
    onDownloaderFound: (downloaderSocketId: string) => void;  // fires on UPLOADER only
}

export function useSignaling({ onSignalReceived, onDownloaderFound }: UseSignalingOptions) {
    const [myConnectionId, setMyConnectionId] = useState<string>("");
    const [statusMessage, setStatusMessage] = useState<string>("Connecting...");
    const [hashIdText, setHashIdText] = useState("Waiting for file encryption...");

    const socketRef = useRef<WebSocket | null>(null);

    // Store callbacks in refs so the WebSocket effect ([] deps, runs once) always
    // reads the latest version without ever needing to reconnect.
    const onSignalReceivedRef   = useRef(onSignalReceived);
    const onDownloaderFoundRef  = useRef(onDownloaderFound);
    useEffect(() => { onSignalReceivedRef.current  = onSignalReceived;  }, [onSignalReceived]);
    useEffect(() => { onDownloaderFoundRef.current = onDownloaderFound; }, [onDownloaderFound]);

    useEffect(() => {
        const ws = new WebSocket(process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8080");
        socketRef.current = ws;

        ws.onopen = () => setStatusMessage("Connected to signaling server.");

        ws.onmessage = (event: MessageEvent) => {
            try {
                const packet = JSON.parse(event.data);
                console.log("📥 WS packet:", packet);

                switch (packet.type) {

                    // Server assigned us our socket ID
                    case "INIT":
                        setMyConnectionId(packet.socketId);
                        setStatusMessage("Ready.");
                        break;

                    // Uploader's file was registered successfully — no action needed
                    case "SUCCESS":
                        console.log("✅ Server:", packet.message);
                        break;

                    // UPLOADER receives this: a downloader just found their file.
                    // Fire the callback so page.tsx can call initializeSender.
                    case "DOWNLOADER_FOUND":
                        console.log(`🛰️  Downloader connected: ${packet.downloaderSocketId}`);
                        setStatusMessage(`Peer found! Starting transfer...`);
                        onDownloaderFoundRef.current(packet.downloaderSocketId);
                        break;

                    // DOWNLOADER receives this: confirms who the uploader is.
                    // The downloader doesn't need to act here — they wait for the
                    // WebRTC offer to arrive as a SIGNAL packet.
                    case "PEER_FOUND":
                        console.log(`🔍 Uploader located: ${packet.uploaderSocketId}`);
                        setStatusMessage("Uploader found! Waiting for offer...");
                        break;

                    // WebRTC signal (offer / answer / candidate) from remote peer
                    case "SIGNAL":
                        console.log(`⚓ Signal (${packet.signalData?.type}) from ${packet.senderId}`);
                        onSignalReceivedRef.current(packet.senderId, packet.signalData);
                        break;

                    case "ERROR":
                        console.error("Server error:", packet.message);
                        setStatusMessage(`Error: ${packet.message}`);
                        break;
                }
            } catch (err) {
                console.error("WS parse error:", err);
            }
        };

        ws.onerror = () => setStatusMessage("WebSocket connection failed.");
        ws.onclose = () => setStatusMessage("Signaling connection dropped.");

        return () => { ws.close(); };
    }, []); // ← runs exactly once

    const registerFile = useCallback((fileHash: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ action: "REGISTER_FILE", fileHash }));
            setHashIdText(`Your file hash: ${fileHash}`);
        } else {
            setStatusMessage("Cannot register: not connected.");
        }
    }, []);

    const lookupFile = useCallback((fileHash: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ action: "LOOKUP_FILE", fileHash }));
            setStatusMessage("Looking up file...");
        } else {
            setStatusMessage("Cannot lookup: not connected.");
        }
    }, []);

    const sendSignal = useCallback((targetId: string, signalData: any) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
                action: "RELAY_SIGNAL",
                targetId,
                signalData
            }));
        } else {
            console.warn("sendSignal: socket not open");
        }
    }, []);

    return {
        myConnectionId,
        statusMessage,
        setStatusMessage,
        registerFile,
        lookupFile,
        sendSignal,
        socketRef,
        hashIdText,
    };
}
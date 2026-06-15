'use client';

import { useRef, useEffect, useState, useCallback } from 'react';

interface UseSignalingOptions {
    onSignalReceived?: (senderId: string, signalData: any) => void;
}

export function useSignaling({ onSignalReceived }: UseSignalingOptions) {
    const [myConnectionId, setMyConnectionId] = useState<string>("");
    const [targetPeerId, setTargetPeerId] = useState<string>("");
    const [statusMessage, setStatusMessage] = useState<string>("Initializing Realtime Network Client...");
    const [hashIdText, setHashIdText] = useState("Waiting for file encryption...");

    const socketRef = useRef<WebSocket | null>(null);

    // FIX: Store the callback in a ref so the WebSocket effect never needs to re-run
    // when the callback identity changes across renders. The effect has [] deps and
    // always reads the latest version of the handler via this ref.
    const onSignalReceivedRef = useRef(onSignalReceived);
    useEffect(() => {
        onSignalReceivedRef.current = onSignalReceived;
    }, [onSignalReceived]);

    useEffect(() => {
        // FIX: Empty dependency array — WebSocket connects exactly once.
        // Previously `options?.onSignalReceived` was in deps, causing a new WebSocket
        // on every render because a new options object was created each time.
        const ws = new WebSocket("ws://localhost:8080");
        socketRef.current = ws;

        ws.onopen = () => {
            setStatusMessage("Connected to ShareX Signal Mesh Router.");
        };

        ws.onmessage = async (event: MessageEvent) => {
            try {
                const packet = JSON.parse(event.data);
                console.log("📥 Incoming Router Packet:", packet);

                switch (packet.type) {
                    case "INIT":
                        setMyConnectionId(packet.socketId);
                        setStatusMessage("Ready. Node Identity Assigned.");
                        break;

                    case "SUCCESS":
                        console.log("⚡ Router Confirmation:", packet.message);

                        if (packet.data?.socketID) {
                            setTargetPeerId(packet.data.socketID);
                            console.log(`🎯 Remote Peer Found: ${packet.data.socketID}`);
                            setStatusMessage(`Peer located! Initiating WebRTC handshake...`);
                        }
                        break;

                    case "SIGNAL":
                        console.log("⚓ WebRTC signal received:", packet.signalData);
                        // FIX: Read from ref — never stale, never triggers reconnect
                        onSignalReceivedRef.current?.(packet.senderId, packet.signalData);
                        break;

                    case "ERROR":
                        setStatusMessage(`Network error: ${packet.message}`);
                        break;

                    default:
                        break;
                }
            } catch (err) {
                console.error("Malformed routing payload:", err);
            }
        };

        ws.onerror = () => setStatusMessage("Failed to connect to signaling server.");
        ws.onclose = () => setStatusMessage("Signaling connection dropped.");

        return () => {
            ws.close();
        };
    }, []); // ✅ Connects once, never reconnects due to callback churn

    const registerFile = useCallback((fileHash: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
                action: "REGISTER_FILE",
                fileHash
            }));
            setHashIdText(`Your generated filehash is: ${fileHash}`);
        } else {
            setStatusMessage("Cannot register file: WebSocket is disconnected.");
        }
    }, []);

    const lookupFile = useCallback((fileHash: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
                action: "LOOKUP_FILE",
                fileHash
            }));
        } else {
            setStatusMessage("Cannot lookup file: WebSocket is disconnected.");
        }
    }, []);

    return {
        myConnectionId,
        targetPeerId,
        setTargetPeerId,
        statusMessage,
        setStatusMessage,
        registerFile,
        lookupFile,
        socketRef,
        hashIdText
    };
}
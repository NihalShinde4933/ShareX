'use client';

import { useRef, useEffect, useState, useCallback } from 'react';

interface UseSignalingOptions {
    onSignalReceived:  (senderId: string, signalData: any) => void;
    onDownloaderFound: (downloaderSocketId: string) => void;
}

/**
 * NOTE on "Send another file" / new socket ID:
 * page.tsx wraps the whole tree in `<div key={sessionKey}>`. Bumping
 * sessionKey forces React to unmount and remount this entire component tree,
 * which re-runs this hook's WebSocket effect from scratch and gets a brand
 * new socket ID from the server's INIT packet — exactly the "assign new
 * socket id and remove all states" behavior requested.
 */
export function useSignaling({ onSignalReceived, onDownloaderFound }: UseSignalingOptions) {
    const [myConnectionId, setMyConnectionId] = useState<string>('');
    const [statusMessage, setStatusMessage]   = useState<string>('Connecting...');
    const [hashIdText, setHashIdText]         = useState('Waiting for file encryption...');

    const socketRef = useRef<WebSocket | null>(null);

    const onSignalReceivedRef  = useRef(onSignalReceived);
    const onDownloaderFoundRef = useRef(onDownloaderFound);
    useEffect(() => { onSignalReceivedRef.current  = onSignalReceived;  }, [onSignalReceived]);
    useEffect(() => { onDownloaderFoundRef.current = onDownloaderFound; }, [onDownloaderFound]);

    useEffect(() => {
        const ws = new WebSocket(process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080');
        socketRef.current = ws;

        ws.onopen = () => setStatusMessage('Connected to signaling server.');

        ws.onmessage = (event: MessageEvent) => {
            try {
                const packet = JSON.parse(event.data);
                console.log('📥 WS packet:', packet);

                switch (packet.type) {
                    case 'INIT':
                        setMyConnectionId(packet.socketId);
                        setStatusMessage('Ready.');
                        break;

                    case 'SUCCESS':
                        console.log('✅ Server:', packet.message);
                        break;

                    case 'DOWNLOADER_FOUND':
                        console.log(`🛰️  Downloader connected: ${packet.downloaderSocketId}`);
                        setStatusMessage('Peer found! Starting transfer...');
                        onDownloaderFoundRef.current(packet.downloaderSocketId);
                        break;

                    case 'PEER_FOUND':
                        console.log(`🔍 Uploader located: ${packet.uploaderSocketId}`);
                        setStatusMessage('Uploader found! Waiting for offer...');
                        break;

                    case 'SIGNAL':
                        console.log(`⚓ Signal (${packet.signalData?.type}) from ${packet.senderId}`);
                        onSignalReceivedRef.current(packet.senderId, packet.signalData);
                        break;

                    case 'ERROR':
                        console.error('Server error:', packet.message);
                        setStatusMessage(`Error: ${packet.message}`);
                        break;
                }
            } catch (err) {
                console.error('WS parse error:', err);
            }
        };

        ws.onerror = () => setStatusMessage('WebSocket connection failed.');
        ws.onclose = () => setStatusMessage('Signaling connection dropped.');

        return () => { ws.close(); };
    }, []); // ← runs once per mount; "Send another file" remounts via the key trick in page.tsx

    const registerFile = useCallback((fileHash: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ action: 'REGISTER_FILE', fileHash }));
            setHashIdText(`Your file hash: ${fileHash}`);
        } else {
            setStatusMessage('Cannot register: not connected.');
        }
    }, []);

    const lookupFile = useCallback((fileHash: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ action: 'LOOKUP_FILE', fileHash }));
            setStatusMessage('Looking up file...');
        } else {
            setStatusMessage('Cannot lookup: not connected.');
        }
    }, []);

    /**
     * Sends a WebRTC signaling message (offer/answer/candidate) to a peer.
     *
     * FIX: page.tsx previously passed a no-op stub `(...args) => {}` into
     * useWebRTC instead of this function — meaning every offer, answer, and
     * ICE candidate vanished silently and no transfer could ever begin. This
     * is the real implementation; page.tsx must wire THIS into useWebRTC.
     */
    const sendSignal = useCallback((targetId: string, signalData: any) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
                action: 'RELAY_SIGNAL',
                targetId,
                signalData,
            }));
        } else {
            console.warn('sendSignal: socket not open — message dropped', { targetId, signalData });
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
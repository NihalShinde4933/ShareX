'use client';

/**
 * useRoomSignaling.ts — room-code based pairing for heavy (unencrypted) transfers
 *
 * Why a room code instead of hash + passphrase:
 * ────────────────────────────────────────────────────────────────────────────
 * The small-file flow uses a SHA-256 file hash (so the receiver can verify
 * which file they're getting) plus a passphrase (used to derive the AES key).
 * Heavy mode has no encryption, so there's no key to derive — a passphrase
 * would be pure friction with no security benefit. Instead we use a short,
 * human-shareable ROOM CODE (6 uppercase alphanumeric chars, e.g. "X7K2QM")
 * that the server uses purely to pair the two sockets — same job the file
 * hash was doing, just without implying any cryptographic guarantee.
 *
 * Server protocol additions (see index.ts):
 *   CREATE_ROOM           → server generates a code, replies ROOM_CREATED
 *   JOIN_ROOM { code }    → server pairs sockets, notifies both
 *   ROOM_HOST_FOUND       → sent to the joiner's counterpart (the host)
 *   ROOM_PEER_FOUND       → sent to the joiner, confirming the host's ID
 */

import { useRef, useEffect, useState, useCallback } from 'react';

interface UseRoomSignalingOptions {
    onSignalReceived: (senderId: string, signalData: any) => void;
    onPeerJoined:     (peerSocketId: string) => void;  // fires on the HOST when someone joins
}

export function useRoomSignaling({ onSignalReceived, onPeerJoined }: UseRoomSignalingOptions) {
    const [myConnectionId, setMyConnectionId] = useState<string>('');
    const [statusMessage, setStatusMessage]   = useState<string>('Connecting...');
    const [roomCode, setRoomCode]             = useState<string>('');

    const socketRef = useRef<WebSocket | null>(null);
    const onSignalReceivedRef = useRef(onSignalReceived);
    const onPeerJoinedRef     = useRef(onPeerJoined);
    useEffect(() => { onSignalReceivedRef.current = onSignalReceived; }, [onSignalReceived]);
    useEffect(() => { onPeerJoinedRef.current     = onPeerJoined;     }, [onPeerJoined]);

    useEffect(() => {
        const ws = new WebSocket(process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080');
        socketRef.current = ws;

        ws.onopen = () => setStatusMessage('Connected to signaling server.');

        ws.onmessage = (event: MessageEvent) => {
            try {
                const packet = JSON.parse(event.data);
                console.log('📥 [room] WS packet:', packet);

                switch (packet.type) {
                    case 'INIT':
                        setMyConnectionId(packet.socketId);
                        setStatusMessage('Ready.');
                        break;

                    case 'ROOM_CREATED':
                        setRoomCode(packet.code);
                        setStatusMessage(`Room ${packet.code} created. Share this code with your peer.`);
                        break;

                    // HOST receives this when someone joins their room
                    case 'ROOM_PEER_FOUND':
                        console.log(`🛰️ Peer joined room: ${packet.peerSocketId}`);
                        setStatusMessage('Peer joined! Starting transfer...');
                        onPeerJoinedRef.current(packet.peerSocketId);
                        break;

                    // JOINER receives this confirming who the host is
                    case 'ROOM_HOST_FOUND':
                        console.log(`🔍 Host located: ${packet.hostSocketId}`);
                        setStatusMessage('Host found! Waiting for transfer to begin...');
                        break;

                    case 'SIGNAL':
                        onSignalReceivedRef.current(packet.senderId, packet.signalData);
                        break;

                    case 'ERROR':
                        setStatusMessage(`Error: ${packet.message}`);
                        break;
                }
            } catch (err) {
                console.error('[room] WS parse error:', err);
            }
        };

        ws.onerror = () => setStatusMessage('WebSocket connection failed.');
        ws.onclose = () => setStatusMessage('Signaling connection dropped.');

        return () => { ws.close(); };
    }, []);

    /** Host action: ask the server to mint a new room code. */
    const createRoom = useCallback(() => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ action: 'CREATE_ROOM' }));
            setStatusMessage('Creating room...');
        } else {
            setStatusMessage('Cannot create room: not connected.');
        }
    }, []);

    /** Joiner action: pair with a room by its code. */
    const joinRoom = useCallback((code: string) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ action: 'JOIN_ROOM', code: code.toUpperCase() }));
            setStatusMessage('Joining room...');
        } else {
            setStatusMessage('Cannot join room: not connected.');
        }
    }, []);

    const sendSignal = useCallback((targetId: string, signalData: any) => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ action: 'RELAY_SIGNAL', targetId, signalData }));
        } else {
            console.warn('sendSignal: socket not open — message dropped');
        }
    }, []);

    return {
        myConnectionId,
        statusMessage,
        setStatusMessage,
        roomCode,
        createRoom,
        joinRoom,
        sendSignal,
        socketRef,
    };
}
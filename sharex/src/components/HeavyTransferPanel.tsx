'use client';

/**
 * HeavyTransferPanel.tsx — UI for the room-code based heavy-file flow.
 *
 * Host side:   pick a file > 400MB → create room → share code → auto-sends
 *              the moment a peer joins (no separate "send" click needed,
 *              mirrors the existing onDownloaderFound auto-trigger pattern).
 * Joiner side: enter the room code → auto-receives once paired.
 *
 * Visually matches the existing neon dark theme (#adff2f / amber-gold swap
 * for heavy mode to visually distinguish it from Safe mode at a glance).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRoomSignaling } from '../hooks/useRoomSignaling';
import { useHeavyTransfer } from '../hooks/useHeavyTransfer';
import { TierNotice } from './Navbar';

const HEAVY_THRESHOLD_BYTES = 400 * 1024 * 1024; // 400MB
const HEAVY_COLOR = '#ffcc00';

function NeonBar({ pct, color, label }: { pct: number; color: string; label?: string }) {
    return (
        <div className="flex flex-col gap-1.5 w-full">
            {label && (
                <div className="flex justify-between text-xs font-mono" style={{ color: `${color}cc` }}>
                    <span>{label}</span><span className="font-bold">{pct}%</span>
                </div>
            )}
            <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
                <div className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${color}44, ${color})`, boxShadow: `0 0 10px ${color}, 0 0 3px ${color}` }} />
            </div>
        </div>
    );
}

function RoomCodeBadge({ code }: { code: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); };
    return (
        <div className="rounded-xl p-5 flex flex-col gap-3 w-full text-center" style={{ background: `${HEAVY_COLOR}08`, border: `1px solid ${HEAVY_COLOR}33` }}>
            <p className="text-xs font-mono tracking-widest uppercase" style={{ color: `${HEAVY_COLOR}cc` }}>Room code — share with receiver</p>
            <div className="text-3xl font-mono font-black tracking-[0.3em]" style={{ color: HEAVY_COLOR }}>{code}</div>
            <button type="button" onClick={copy} className="self-center px-4 py-1.5 rounded-lg text-xs font-mono font-bold transition-all"
                style={{ background: copied ? `${HEAVY_COLOR}33` : `${HEAVY_COLOR}12`, color: HEAVY_COLOR, border: `1px solid ${HEAVY_COLOR}44` }}>
                {copied ? '✓ Copied' : 'Copy code'}
            </button>
        </div>
    );
}

export function HeavyTransferPanel({
    mode,
    locked,
    setLocked,
    pushToast,
}: {
    mode: 'host' | 'join';
    locked: boolean;
    setLocked: (v: boolean) => void;
    pushToast: (t: { type: 'success'|'error'|'info'; message: string; color?: string }) => void;
}) {
    const [file, setFile]               = useState<File | null>(null);
    const [joinCodeInput, setJoinCodeInput] = useState('');
    const [isProcessing, setIsProcessing]   = useState(false);
    const [sessionKey, setSessionKey]       = useState(0);

    const fileRef = useRef<File | null>(null);
    useEffect(() => { fileRef.current = file; }, [file]);

    function onPeerJoined(peerSocketId: string) {
        const f = fileRef.current;
        if (!f) { console.error('onPeerJoined: no file selected'); return; }
        setLocked(true);
        pushToast({ type: 'info', message: 'Peer joined — starting high-speed transfer...', color: HEAVY_COLOR });
        initializeHeavySender(f, peerSocketId);
    }

    function onSignalReceived(senderId: string, signalData: any) {
        if (signalData.type === 'offer') {
            setLocked(true);
            initializeHeavyReceiver(signalData.sdp, senderId);
        } else {
            handleHeavyIncomingSignal(signalData);
        }
    }

    const { myConnectionId, statusMessage, setStatusMessage, roomCode, createRoom, joinRoom, sendSignal } =
        useRoomSignaling({ onSignalReceived, onPeerJoined });

    const handleSendComplete = useCallback(() => {
        pushToast({ type: 'success', message: 'Heavy file sent successfully!', color: HEAVY_COLOR, duration: 5000 } as any);
    }, [pushToast]);
    const handleReceiveComplete = useCallback(() => {
        pushToast({ type: 'success', message: 'Heavy file received and saved to disk!', color: HEAVY_COLOR, duration: 5000 } as any);
    }, [pushToast]);

    const {
        initializeHeavySender, initializeHeavyReceiver, handleHeavyIncomingSignal,
        sendProgress, receiveProgress, receivedFileName, resetHeavyConnections,
    } = useHeavyTransfer({ sendSignal, setStatusMessage, onSendComplete: handleSendComplete, onReceiveComplete: handleReceiveComplete });

    useEffect(() => {
        if (sendProgress === 100 || receiveProgress === 100) setLocked(false);
    }, [sendProgress, receiveProgress, setLocked]);

    const handleCreateRoom = (e: React.FormEvent) => {
        e.preventDefault();
        if (!file) { setStatusMessage('Select a file above 400MB first.'); return; }
        if (file.size < HEAVY_THRESHOLD_BYTES) {
            setStatusMessage(`File is ${(file.size/1024/1024).toFixed(0)}MB — Heavy mode is for files over 400MB. Use Safe mode instead.`);
            pushToast({ type: 'error', message: 'This file is small enough for Safe mode — switch tabs to encrypt it.' });
            return;
        }
        setIsProcessing(true);
        createRoom();
        setIsProcessing(false);
    };

    const handleJoinRoom = (e: React.FormEvent) => {
        e.preventDefault();
        if (!joinCodeInput || joinCodeInput.length !== 6) { setStatusMessage('Enter the 6-character room code.'); return; }
        setIsProcessing(true);
        joinRoom(joinCodeInput);
        setIsProcessing(false);
    };

    const handleReset = useCallback(() => {
        resetHeavyConnections();
        setFile(null);
        setJoinCodeInput('');
        setIsProcessing(false);
        setStatusMessage('');
        setSessionKey(k => k + 1);
        pushToast({ type: 'info', message: 'Ready for a new heavy transfer.', color: HEAVY_COLOR });
    }, [resetHeavyConnections, setStatusMessage, pushToast]);

    const transferDone = (mode === 'host' && sendProgress === 100) || (mode === 'join' && receiveProgress === 100);

    return (
        <div key={sessionKey} className="flex flex-col gap-5 items-center w-full">
            <TierNotice tier="heavy" />

            <div className="relative w-full max-w-md rounded-2xl overflow-hidden"
                style={{ background: 'rgba(12,12,16,0.75)', backdropFilter: 'blur(16px)', border: `1px solid ${HEAVY_COLOR}33`, boxShadow: locked ? `0 0 50px ${HEAVY_COLOR}18` : '0 20px 40px rgba(0,0,0,0.4)' }}>
                <div className="p-6 flex flex-col gap-4">

                    {mode === 'host' && !transferDone && !roomCode && (
                        <form onSubmit={handleCreateRoom} className="flex flex-col gap-4">
                            <div
                                className="rounded-xl p-6 flex flex-col items-center justify-center gap-2.5 cursor-pointer transition-all"
                                style={{ background: 'rgba(255,255,255,0.01)', border: `1px dashed ${file ? HEAVY_COLOR : 'rgba(255,255,255,0.1)'}` }}
                                onClick={() => !isProcessing && document.getElementById('heavy-file-input')?.click()}
                                onDragOver={e => e.preventDefault()}
                                onDrop={e => { e.preventDefault(); if (isProcessing) return; const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
                            >
                                <input type="file" id="heavy-file-input" className="hidden"
                                    onChange={e => setFile(e.target.files?.[0] || null)} disabled={isProcessing} />
                                <div className="text-3xl" style={{ opacity: file ? 1 : 0.25 }}>{file ? '🎬' : '📦'}</div>
                                <div className="text-xs font-mono text-center font-bold truncate max-w-xs" style={{ color: file ? HEAVY_COLOR : 'rgba(255,255,255,0.3)' }}>
                                    {file ? file.name : 'Drop a large file (400MB+) or click'}
                                </div>
                                {file && (
                                    <div className="text-[11px] font-mono" style={{ color: file.size >= HEAVY_THRESHOLD_BYTES ? `${HEAVY_COLOR}88` : '#ff3366' }}>
                                        {(file.size / 1024 / 1024).toFixed(0)} MB
                                        {file.size < HEAVY_THRESHOLD_BYTES && '  ·  too small for Heavy mode'}
                                    </div>
                                )}
                            </div>
                            <button type="submit" disabled={!file || isProcessing}
                                className="w-full py-3.5 rounded-xl font-mono font-bold tracking-widest uppercase text-sm transition-all disabled:opacity-30"
                                style={{ background: `${HEAVY_COLOR}15`, border: `1px solid ${HEAVY_COLOR}`, color: HEAVY_COLOR }}>
                                ⚡ Create Room & Host
                            </button>
                        </form>
                    )}

                    {mode === 'host' && roomCode && !transferDone && (
                        <div className="flex flex-col gap-4">
                            <RoomCodeBadge code={roomCode} />
                            {sendProgress > 0 && <NeonBar pct={sendProgress} color={HEAVY_COLOR} label="Sending (unencrypted, 4 channels)" />}
                        </div>
                    )}

                    {mode === 'join' && !transferDone && (
                        <form onSubmit={handleJoinRoom} className="flex flex-col gap-4">
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs font-mono tracking-widest uppercase" style={{ color: 'rgba(255,255,255,0.4)' }}>Room code</label>
                                <input
                                    type="text" maxLength={6} value={joinCodeInput}
                                    onChange={e => setJoinCodeInput(e.target.value.toUpperCase())}
                                    placeholder="X7K2QM" disabled={isProcessing}
                                    className="w-full rounded-lg px-4 py-3 text-lg font-mono font-bold tracking-[0.3em] text-center outline-none"
                                    style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${HEAVY_COLOR}44`, color: HEAVY_COLOR }}
                                />
                            </div>
                            <button type="submit" disabled={isProcessing || joinCodeInput.length !== 6}
                                className="w-full py-3.5 rounded-xl font-mono font-bold tracking-widest uppercase text-sm transition-all disabled:opacity-30"
                                style={{ background: `${HEAVY_COLOR}15`, border: `1px solid ${HEAVY_COLOR}`, color: HEAVY_COLOR }}>
                                {isProcessing ? '⠋ Joining...' : '⚡ Join Room'}
                            </button>
                            {receiveProgress > 0 && <NeonBar pct={receiveProgress} color={HEAVY_COLOR} label={receivedFileName ? `Receiving ${receivedFileName}` : 'Receiving'} />}
                        </form>
                    )}

                    {transferDone && (
                        <div className="flex flex-col gap-4 items-center text-center py-2">
                            <div className="text-3xl">🎉</div>
                            <p className="text-sm font-mono" style={{ color: HEAVY_COLOR }}>
                                {mode === 'host' ? 'File delivered successfully!' : 'File received successfully!'}
                            </p>
                            <button type="button" onClick={handleReset}
                                className="w-full py-3 rounded-xl font-mono font-bold tracking-widest uppercase text-sm"
                                style={{ background: `${HEAVY_COLOR}15`, border: `1px solid ${HEAVY_COLOR}`, color: HEAVY_COLOR }}>
                                ↻ {mode === 'host' ? 'Send another file' : 'Receive another file'}
                            </button>
                        </div>
                    )}

                    {statusMessage && (
                        <div className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs font-mono w-full"
                            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>
                            <span className="opacity-40">›</span><span>{statusMessage}</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
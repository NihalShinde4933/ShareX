'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { deriveKey } from '../utils/crypto';
import { sliceFileIntoChunks, clearChunks } from '../utils/chunker';
import { useSignaling } from '../hooks/useSignaling';
import { useWebRTC } from '../hooks/useWebRTC';
import { useToasts, ToastStack } from '../components/Toast';
import { Navbar, TierNotice, TransferTier } from '../components/Navbar';
import { HeavyTransferPanel } from '../components/HeavyTransferPanel';

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ParticleCanvas({ active, color }: { active: boolean; color: string }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animRef   = useRef<number>(0);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d')!;

        const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
        resize();
        window.addEventListener('resize', resize);

        type P = { x: number; y: number; vy: number; size: number; alpha: number };
        const pts: P[] = [];

        const draw = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            for (let i = pts.length - 1; i >= 0; i--) {
                const p = pts[i];
                p.y += p.vy; p.alpha -= 0.004;
                if (p.y > canvas.height || p.alpha <= 0) { pts.splice(i, 1); continue; }
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fillStyle = color + Math.floor(p.alpha * 255).toString(16).padStart(2, '0');
                ctx.fill();
            }
            if (active && pts.length < 120 && Math.random() < 0.4) {
                pts.push({ x: Math.random() * canvas.width, y: 0, vy: 0.5 + Math.random() * 1.5, size: 1 + Math.random() * 2, alpha: 0.4 + Math.random() * 0.6 });
            }
            animRef.current = requestAnimationFrame(draw);
        };
        animRef.current = requestAnimationFrame(draw);
        return () => { cancelAnimationFrame(animRef.current); window.removeEventListener('resize', resize); };
    }, [active, color]);

    return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 0 }} />;
}

function NeonBar({ pct, color, label }: { pct: number; color: string; label?: string }) {
    return (
        <div className="flex flex-col gap-1.5 w-full">
            {label && (
                <div className="flex justify-between text-xs font-mono" style={{ color: `${color}cc` }}>
                    <span>{label}</span>
                    <span className="font-bold">{pct}%</span>
                </div>
            )}
            <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
                <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                        width:     `${pct}%`,
                        background: `linear-gradient(90deg, ${color}44, ${color})`,
                        boxShadow: `0 0 10px ${color}, 0 0 3px ${color}`,
                    }}
                />
            </div>
        </div>
    );
}

function ModePill({ mode, onChange, locked }: { mode: 'host' | 'download'; onChange: (m: 'host' | 'download') => void; locked: boolean }) {
    return (
        <div className="relative flex items-center rounded-full p-1.5 gap-1.5"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', opacity: locked ? 0.4 : 1, pointerEvents: locked ? 'none' : 'auto' }}>
            {(['host', 'download'] as const).map(m => (
                <button key={m} type="button" onClick={() => !locked && onChange(m)} disabled={locked}
                    className="relative z-10 px-6 py-2 rounded-full text-xs font-mono font-bold tracking-widest uppercase transition-all duration-300"
                    style={{
                        color:      mode === m ? '#0a0a0f' : 'rgba(255,255,255,0.4)',
                        background: mode === m ? (m === 'host' ? '#adff2f' : '#ff6600') : 'transparent',
                        boxShadow:  mode === m ? (m === 'host' ? '0 0 20px rgba(173,255,47,0.5)' : '0 0 20px rgba(255,102,0,0.5)') : 'none',
                        cursor:     locked ? 'not-allowed' : 'pointer',
                    }}>
                    {m === 'host' ? '⬆ Send File' : '⬇ Receive File'}
                </button>
            ))}
        </div>
    );
}

function NeonInput({ label, accentColor, ...props }: { label: string; accentColor: string } & React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <div className="flex flex-col gap-1.5 w-full">
            <label className="text-xs font-mono tracking-widest uppercase" style={{ color: 'rgba(255,255,255,0.4)' }}>
                {label}
            </label>
            <input
                {...props}
                className="w-full rounded-lg px-4 py-2.5 text-sm font-mono outline-none transition-all duration-200"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0', caretColor: accentColor, ...(props.style ?? {}) }}
                onFocus={e => { e.currentTarget.style.border = `1px solid ${accentColor}`; e.currentTarget.style.boxShadow = `0 0 0 2px ${accentColor}22`; }}
                onBlur={e  => { e.currentTarget.style.border = '1px solid rgba(255,255,255,0.1)'; e.currentTarget.style.boxShadow = 'none'; }}
            />
        </div>
    );
}

function NeonButton({ children, onClick, disabled, color = '#adff2f', type = 'button' }: {
    children: React.ReactNode; onClick?: () => void; disabled?: boolean; color?: string; type?: 'button' | 'submit';
}) {
    return (
        <button type={type} onClick={onClick} disabled={disabled}
            className="w-full py-3.5 rounded-xl font-mono font-bold tracking-widest uppercase text-sm transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ background: disabled ? 'rgba(255,255,255,0.04)' : `${color}12`, border: `1px solid ${disabled ? 'rgba(255,255,255,0.08)' : color}`, color: disabled ? 'rgba(255,255,255,0.3)' : color, boxShadow: disabled ? 'none' : `0 0 15px ${color}33, inset 0 0 15px ${color}05` }}
            onMouseEnter={e => { if (!disabled) { e.currentTarget.style.background = `${color}24`; e.currentTarget.style.boxShadow = `0 0 25px ${color}55, inset 0 0 25px ${color}10`; } }}
            onMouseLeave={e => { if (!disabled) { e.currentTarget.style.background = `${color}12`; e.currentTarget.style.boxShadow = `0 0 15px ${color}33, inset 0 0 15px ${color}05`; } }}>
            {children}
        </button>
    );
}

function HashBadge({ hash, color }: { hash: string; color: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => { navigator.clipboard.writeText(hash); setCopied(true); setTimeout(() => setCopied(false), 2000); };
    return (
        <div className="rounded-xl p-4 flex flex-col gap-2.5 w-full text-left" style={{ background: `${color}06`, border: `1px solid ${color}33` }}>
            <p className="text-xs font-mono tracking-widest uppercase" style={{ color: `${color}cc` }}>Share this hash with receiver</p>
            <div className="flex items-center gap-3">
                <code className="flex-1 text-xs font-mono break-all" style={{ color: color }}>{hash}</code>
                <button type="button" onClick={copy} className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all"
                    style={{ background: copied ? `${color}33` : `${color}12`, color: color, border: `1px solid ${color}44` }}>
                    {copied ? '✓ Copied' : 'Copy'}
                </button>
            </div>
        </div>
    );
}

function StatusLine({ msg, hostColor }: { msg: string; hostColor: string }) {
    if (!msg) return null;
    const isError = msg.startsWith('❌');
    const isOk    = msg.startsWith('✅');
    const accent = isError ? '#ff3366' : isOk ? hostColor : 'rgba(255,255,255,0.4)';
    return (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs font-mono w-full text-left"
            style={{ background: isError ? 'rgba(255,51,102,0.06)' : isOk ? `${hostColor}06` : 'rgba(255,255,255,0.02)', border: `1px solid ${isError ? 'rgba(255,51,102,0.15)' : isOk ? `${hostColor}33` : 'rgba(255,255,255,0.06)'}`, color: accent }}>
            <span className="opacity-40 shrink-0">›</span><span>{msg}</span>
        </div>
    );
}

function ChannelBadge({ active, color }: { active: boolean; color: string }) {
    return (
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            {[0, 1, 2, 3].map(i => (
                <div key={i} className="w-1.5 h-1.5 rounded-full"
                    style={{ background: active ? color : 'rgba(255,255,255,0.15)', boxShadow: active ? `0 0 6px ${color}` : 'none', transition: 'all 0.3s ease' }} />
            ))}
            <span className="text-[11px] font-mono ml-1 uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.4)' }}>
                {active ? 'Streaming' : '4 ch'}
            </span>
        </div>
    );
}

function useWorkerAvailable(): boolean {
    const [available, setAvailable] = useState(true);
    useEffect(() => {
        try {
            const w = new Worker('/workers/cryptoWorker.js');
            w.terminate();
            setAvailable(true);
        } catch {
            setAvailable(false);
        }
    }, []);
    return available;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function HomePage() {
    // ── Top-level tier: Safe (encrypted, small files) vs Heavy (unencrypted, 400MB+) ──
    const [tier, setTier]               = useState<TransferTier>('safe');
    const [heavyMode, setHeavyMode]      = useState<'host' | 'join'>('host');
    const [heavyLocked, setHeavyLocked]  = useState(false);

    // ── Safe-mode state (unchanged from the original encrypted pipeline) ──────
    const [mode, setMode]                         = useState<'host' | 'download'>('host');
    const [file, setFile]                         = useState<File | null>(null);
    const [passPhrase, setPassPhrase]             = useState('');
    const [fileHashInput, setFileHashInput]       = useState('');
    const [downloadPassword, setDownloadPassword] = useState('');
    const [isProcessing, setIsProcessing]         = useState(false);
    const [fileHash, setFileHash]                 = useState('');
    const [isTransferring, setIsTransferring]     = useState(false);

    const [encryptProgress, setEncryptProgress]   = useState(0);
    const [encryptPhase, setEncryptPhase]         = useState<'idle' | 'encrypting' | 'done'>('idle');

    // ── Session key — bumping this forces useSignaling to open a brand new
    // WebSocket (and therefore receive a brand new socket ID from the server).
    // Used by "Send another file" to fully reset identity + all transfer state.
    const [sessionKey, setSessionKey] = useState(0);

    const workerAvailable = useWorkerAvailable();
    const { toasts, pushToast, dismissToast } = useToasts();

    const passPhraseRef       = useRef('');
    const downloadPasswordRef = useRef('');
    const activeFileHashRef   = useRef('');
    const uploadSaltRef       = useRef<Uint8Array | null>(null);

    useEffect(() => { passPhraseRef.current       = passPhrase;       }, [passPhrase]);
    useEffect(() => { downloadPasswordRef.current = downloadPassword; }, [downloadPassword]);

    // ── Reload guard — covers BOTH safe-mode and heavy-mode busy states ────────
    useEffect(() => {
        const guard = (e: BeforeUnloadEvent) => {
            const safeBusy  = isTransferring || encryptPhase === 'encrypting';
            const heavyBusy = heavyLocked;
            if (!safeBusy && !heavyBusy) return;
            e.preventDefault();
            e.returnValue = 'File transfer in progress. Leaving will cancel the transfer.';
        };
        window.addEventListener('beforeunload', guard);
        return () => window.removeEventListener('beforeunload', guard);
    }, [isTransferring, encryptPhase, heavyLocked]);

    // ── Lock tab-switching while busy ─────────────────────────────────────────
    // Combined lock used by the Navbar to disable Safe/Heavy tier switching —
    // true if EITHER pipeline is mid-transfer, so the user can't abandon an
    // active transfer by flipping tiers.
    const tabLocked = isTransferring || encryptPhase === 'encrypting' || isProcessing || heavyLocked;

    function onDownloaderFound(downloaderSocketId: string) {
        const salt = uploadSaltRef.current;
        if (!salt) { console.error('onDownloaderFound: no salt'); return; }
        setMode('host');
        setIsTransferring(true);
        pushToast({ type: 'info', message: 'Peer connected — starting upload...', color: '#adff2f' });
        initializeSender(activeFileHashRef.current, passPhraseRef.current, salt, downloaderSocketId);
    }

    function onSignalReceived(senderId: string, signalData: any) {
        if (signalData.type === 'offer') {
            setMode('download');
            setIsTransferring(true);
            initializeReceiver(signalData.sdp, downloadPasswordRef.current, senderId);
        } else {
            handleIncomingSignal(signalData);
        }
    }

    const {
        myConnectionId,
        statusMessage,
        setStatusMessage,
        registerFile,
        lookupFile,
        sendSignal,        // real implementation from useSignaling
    } = useSignaling({ onSignalReceived, onDownloaderFound });

    const handleSendComplete = useCallback(() => {
        pushToast({ type: 'success', message: 'File sent successfully! Your peer is downloading.', color: '#adff2f', duration: 5000 });
    }, [pushToast]);

    const handleReceiveComplete = useCallback(() => {
        pushToast({ type: 'success', message: 'File received and saved to disk!', color: '#ff6600', duration: 5000 });
    }, [pushToast]);

    const {
        initializeSender,
        initializeReceiver,
        handleIncomingSignal,
        sendProgress,
        receiveProgress,
        downloadUrl,
        resetConnections,
    } = useWebRTC({
        sendSignal,
        setStatusMessage,
        onSendComplete: handleSendComplete,
        onReceiveComplete: handleReceiveComplete,
    });

    useEffect(() => {
        if (sendProgress === 100 || receiveProgress === 100) {
            setIsTransferring(false);
        }
    }, [sendProgress, receiveProgress]);

    const generateFileHash = useCallback(async (name: string): Promise<string> => {
        const buf = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(name + Math.random() + Date.now())
        );
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }, []);

    // ── Upload handler (Safe mode) ────────────────────────────────────────────
    const handleUpload = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!file || !passPhrase) { setStatusMessage('Select a file and enter a passphrase.'); return; }

        try {
            setIsProcessing(true);
            setEncryptPhase('encrypting');
            setEncryptProgress(0);

            const salt = crypto.getRandomValues(new Uint8Array(16));
            uploadSaltRef.current = salt;

            setStatusMessage('⚙️ Generating file identifier...');
            const hash = await generateFileHash(file.name);

            setStatusMessage('🔑 Deriving encryption key...');
            const key = await deriveKey(passPhrase, salt);

            setStatusMessage(workerAvailable
                ? '👾 Encrypting with 4 parallel workers...'
                : '🔒 Encrypting (single-threaded fallback)...'
            );

            await sliceFileIntoChunks(file, 16384, key, hash, (done, total) => {
                setEncryptProgress(Math.round((done / total) * 100));
            });

            setEncryptProgress(100);
            setEncryptPhase('done');

            activeFileHashRef.current = hash;
            setFileHash(hash);

            registerFile(hash);
            setStatusMessage('✅ File hosted! Share the hash with your peer.');
            pushToast({ type: 'info', message: `File encrypted (${Math.ceil(file.size/16384)} chunks). Waiting for a peer...`, color: '#adff2f' });

        } catch (err) {
            console.error('handleUpload:', err);
            setStatusMessage('❌ Encryption failed. Check console for details.');
            pushToast({ type: 'error', message: `Encryption failed: ${(err as Error).message}` });
            setEncryptPhase('idle');
        } finally {
            setIsProcessing(false);
        }
    }, [file, passPhrase, workerAvailable, generateFileHash, registerFile, setStatusMessage, pushToast]);

    const handleDownload = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!fileHashInput || !downloadPassword) {
            setStatusMessage('Enter the file hash and passphrase.');
            return;
        }
        try {
            setIsProcessing(true);
            setStatusMessage('Looking up peer...');
            lookupFile(fileHashInput);
        } catch (err) {
            console.error('handleDownload:', err);
            setStatusMessage('❌ Lookup failed.');
            pushToast({ type: 'error', message: 'Lookup failed. Check the hash and try again.' });
        } finally {
            setIsProcessing(false);
        }
    }, [fileHashInput, downloadPassword, lookupFile, setStatusMessage, pushToast]);

    // ── Send another file (Safe mode) ─────────────────────────────────────────
    const handleSendAnother = useCallback(async () => {
        if (activeFileHashRef.current) {
            try { await clearChunks(activeFileHashRef.current); } catch { /* best effort */ }
        }

        resetConnections();
        setFile(null);
        setPassPhrase('');
        setFileHashInput('');
        setDownloadPassword('');
        setFileHash('');
        setEncryptProgress(0);
        setEncryptPhase('idle');
        setIsTransferring(false);
        setIsProcessing(false);
        activeFileHashRef.current = '';
        uploadSaltRef.current = null;
        setStatusMessage('');

        setSessionKey(k => k + 1);

        pushToast({ type: 'info', message: 'Ready for a new transfer.', color: '#adff2f' });
    }, [resetConnections, setStatusMessage, pushToast]);

    const neonColor = mode === 'host' ? '#adff2f' : '#ff6600';
    const isActive  = isTransferring || isProcessing || encryptPhase === 'encrypting';

    const transferFullyDone =
        (mode === 'host' && sendProgress === 100) ||
        (mode === 'download' && receiveProgress === 100);

    // Heavy mode's accent color is fixed amber-gold regardless of host/join,
    // distinguishing it visually from Safe mode at a glance.
    const headerColor = tier === 'heavy' ? '#ffcc00' : neonColor;

    return (
        <div key={sessionKey} className="min-h-screen flex flex-col justify-between" style={{ background: '#07070a', color: '#e2e8f0' }}>

            <ToastStack toasts={toasts} dismissToast={dismissToast} />

            <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 0 }}>
                <div style={{ position: 'absolute', top: '-10%', left: '-10%', width: '55vw', height: '55vw', borderRadius: '50%', background: `radial-gradient(circle, ${headerColor}07 0%, transparent 65%)`, transition: 'background 0.5s ease' }} />
                <div style={{ position: 'absolute', bottom: '-10%', right: '-10%', width: '45vw', height: '45vw', borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,255,255,0.02) 0%, transparent 60%)' }} />
            </div>

            {/* ── HEADER ───────────────────────────────────────────────────── */}
            <header className="relative z-10 flex items-center justify-between px-6 py-5 max-w-7xl w-full mx-auto"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex items-center gap-3.5">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                        style={{ background: `${headerColor}15`, border: `1px solid ${headerColor}44`, transition: 'all 0.5s ease' }}>
                        <span style={{ color: headerColor, fontSize: 15 }}>✦</span>
                    </div>
                    <div>
                        <span className="font-mono font-black tracking-widest text-xl"
                            style={{ color: '#fff', textShadow: `0 0 15px ${headerColor}44` }}>SHAREX</span>
                        <div className="text-[10px] font-mono tracking-wider uppercase opacity-40">
                            P2P E2E Multi-channel Protocol
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    {!workerAvailable && tier === 'safe' && (
                        <div className="px-3 py-1 rounded-full text-[11px] font-mono font-bold uppercase tracking-wider"
                            style={{ background: 'rgba(255,51,102,0.1)', border: '1px solid rgba(255,51,102,0.3)', color: '#ff3366' }}>
                            ⚠ Cores Restricted
                        </div>
                    )}
                    <div className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-full"
                        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <div className="w-2 h-2 rounded-full animate-pulse"
                            style={{ background: myConnectionId ? '#adff2f' : '#ff3366', boxShadow: myConnectionId ? '0 0 8px #adff2f' : 'none' }} />
                        <span className="text-xs font-mono tracking-tight opacity-50">
                            {myConnectionId ? `node::${myConnectionId.slice(0, 8)}` : 'resolving network'}
                        </span>
                    </div>
                </div>
            </header>

            {/* ── NAVBAR: Safe / Heavy tier switcher ──────────────────────────── */}
            <Navbar tier={tier} onChangeTier={setTier} locked={tabLocked} />

            {/* ── MAIN ─────────────────────────────────────────────────────── */}
            <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 py-8 max-w-4xl w-full mx-auto gap-8">

                {tier === 'safe' ? (
                    <>
                        <div className="text-center flex flex-col gap-2.5">
                            <h1 className="font-mono font-black text-4xl md:text-5xl tracking-tight leading-none"
                                style={{ color: '#fff', textShadow: '0 0 30px rgba(255,255,255,0.05)' }}>
                                Zero-Relay File Stream.
                            </h1>
                            <p className="text-xs md:text-sm font-mono opacity-40 max-w-md mx-auto">
                                High-performance memory allocation pipelines operating over ephemeral cryptographic peer meshes.
                            </p>
                        </div>

                        <TierNotice tier="safe" />

                        <ModePill mode={mode} onChange={m => { setMode(m); setStatusMessage(''); }} locked={tabLocked} />

                        <div className="relative w-full max-w-md rounded-2xl overflow-hidden"
                            style={{
                                background: 'rgba(12, 12, 16, 0.75)',
                                backdropFilter: 'blur(16px)',
                                border:     `1px solid ${isActive ? neonColor + '55' : 'rgba(255,255,255,0.08)'}`,
                                boxShadow:  isActive ? `0 0 50px ${neonColor}18, 0 0 100px ${neonColor}05` : '0 20px 40px rgba(0,0,0,0.4)',
                                transition: 'all 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
                            }}>

                            <ParticleCanvas active={isActive} color={neonColor} />

                            <div className="relative z-10 p-6 flex flex-col gap-5">

                                <div className="flex items-center justify-between pb-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                    <div className="flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full"
                                            style={{ background: neonColor, boxShadow: `0 0 10px ${neonColor}`, transition: 'all 0.5s ease' }} />
                                        <span className="text-xs font-mono font-bold tracking-widest uppercase" style={{ color: neonColor, transition: 'all 0.5s ease' }}>
                                            {mode === 'host' ? 'I/O Upload Mode' : 'I/O Download Mode'}
                                        </span>
                                    </div>
                                    <ChannelBadge active={isTransferring} color={neonColor} />
                                </div>

                                {/* ── HOST ─────────────────────────────────────────── */}
                                {mode === 'host' && (
                                    <>
                                        {!transferFullyDone && (
                                            <form onSubmit={handleUpload} className="flex flex-col gap-4">
                                                <div
                                                    className="rounded-xl p-6 flex flex-col items-center justify-center gap-2.5 cursor-pointer transition-all duration-300"
                                                    style={{ background: 'rgba(255,255,255,0.01)', border: `1px dashed ${file ? '#adff2f' : 'rgba(255,255,255,0.1)'}`, boxShadow: file ? 'inset 0 0 15px rgba(173,255,47,0.04)' : 'none' }}
                                                    onClick={() => !isProcessing && !tabLocked && document.getElementById('file-input')?.click()}
                                                    onDragOver={e => e.preventDefault()}
                                                    onDrop={e => { e.preventDefault(); if (isProcessing || tabLocked) return; const f = e.dataTransfer.files[0]; if (f) setFile(f); }}>
                                                    <input type="file" id="file-input" className="hidden"
                                                        onChange={e => setFile(e.target.files?.[0] || null)} disabled={isProcessing || tabLocked} />

                                                    <div className="text-3xl filter drop-shadow-md" style={{ opacity: file ? 1 : 0.25 }}>{file ? '📦' : '📂'}</div>
                                                    <div className="text-xs font-mono text-center font-bold tracking-wide truncate max-w-xs" style={{ color: file ? '#adff2f' : 'rgba(255,255,255,0.3)' }}>
                                                        {file ? file.name : 'Drop payload file or click terminal'}
                                                    </div>
                                                    {file && (
                                                        <div className="text-[11px] font-mono opacity-40">
                                                            {(file.size / 1024 / 1024).toFixed(2)} MB · {Math.ceil(file.size / 16384).toLocaleString()} blocks
                                                        </div>
                                                    )}
                                                    {file && file.size >= 400 * 1024 * 1024 && (
                                                        <div className="text-[11px] font-mono" style={{ color: '#ffcc00' }}>
                                                            ⚠ This file is 400MB+ — Heavy file share will be much faster
                                                        </div>
                                                    )}
                                                </div>

                                                <NeonInput label="Channel Cipher Key" type="password"
                                                    placeholder="Set connection passphrase"
                                                    value={passPhrase} onChange={e => setPassPhrase(e.target.value)}
                                                    disabled={isProcessing || tabLocked} accentColor="#adff2f" />

                                                {encryptPhase !== 'encrypting' && !fileHash && (
                                                    <NeonButton type="submit" disabled={!file || !passPhrase || isProcessing} color="#adff2f">
                                                        ⬆ Initialize Host Pipeline
                                                    </NeonButton>
                                                )}

                                                {encryptPhase === 'encrypting' && (
                                                    <NeonBar pct={encryptProgress} color="#adff2f"
                                                        label={workerAvailable ? '⚡ Active Thread Encryption (4 Workers)' : '🔒 Main Thread Encryption Fallback'} />
                                                )}

                                                {fileHash && <HashBadge hash={fileHash} color="#adff2f" />}

                                                {sendProgress > 0 && (
                                                    <NeonBar pct={sendProgress} color="#adff2f" label="P2P Data Pipeline Uploading" />
                                                )}
                                            </form>
                                        )}

                                        {transferFullyDone && (
                                            <div className="flex flex-col gap-4 items-center text-center py-2">
                                                <div className="text-3xl">🎉</div>
                                                <p className="text-sm font-mono" style={{ color: '#adff2f' }}>
                                                    File delivered successfully!
                                                </p>
                                                <NeonButton type="button" onClick={handleSendAnother} color="#adff2f">
                                                    ↻ Send Another File
                                                </NeonButton>
                                            </div>
                                        )}
                                    </>
                                )}

                                {/* ── DOWNLOAD ─────────────────────────────────────── */}
                                {mode === 'download' && (
                                    <>
                                        {!transferFullyDone && (
                                            <form onSubmit={handleDownload} className="flex flex-col gap-4">
                                                <NeonInput label="Mesh Network File Hash" type="text"
                                                    placeholder="Paste SHA-256 locator hash"
                                                    value={fileHashInput} onChange={e => setFileHashInput(e.target.value)}
                                                    disabled={isProcessing || isTransferring} accentColor="#ff6600"
                                                    style={{ fontSize: 11 }} />

                                                <NeonInput label="Decryption Cipher Key" type="password"
                                                    placeholder="Enter authorization passphrase"
                                                    value={downloadPassword} onChange={e => setDownloadPassword(e.target.value)}
                                                    disabled={isProcessing || isTransferring} accentColor="#ff6600" />

                                                {!isTransferring && !downloadUrl && (
                                                    <NeonButton type="submit"
                                                        disabled={isProcessing || !fileHashInput || !downloadPassword}
                                                        color="#ff6600">
                                                        {isProcessing ? '⠋ Resolving Peer Target...' : '⬇ Handshake & Connect'}
                                                    </NeonButton>
                                                )}

                                                {receiveProgress > 0 && (
                                                    <NeonBar pct={receiveProgress} color="#ff6600"
                                                        label="Sub-channel P2P Stream Segment Ingestion" />
                                                )}

                                                {downloadUrl && (
                                                    <a href={downloadUrl} download="shared_file"
                                                        className="block w-full text-center py-3.5 rounded-xl font-mono font-bold text-sm tracking-widest uppercase transition-all duration-300"
                                                        style={{ background: 'rgba(255,102,0,0.15)', border: '1px solid #ff6600', color: '#ff6600', boxShadow: '0 0 25px rgba(255,102,0,0.3)' }}>
                                                        💾 Mount Payload to Disk
                                                    </a>
                                                )}

                                                {receiveProgress === 100 && !downloadUrl && (
                                                    <p className="text-xs text-center font-mono font-bold animate-pulse" style={{ color: '#adff2f' }}>
                                                        ✅ Block verification passing. Buffered directly into storage FS.
                                                    </p>
                                                )}
                                            </form>
                                        )}

                                        {transferFullyDone && (
                                            <div className="flex flex-col gap-4 items-center text-center py-2">
                                                <div className="text-3xl">🎉</div>
                                                <p className="text-sm font-mono" style={{ color: '#ff6600' }}>
                                                    File received successfully!
                                                </p>
                                                <NeonButton type="button" onClick={handleSendAnother} color="#ff6600">
                                                    ↻ Receive Another File
                                                </NeonButton>
                                            </div>
                                        )}
                                    </>
                                )}

                                {statusMessage && <StatusLine msg={statusMessage} hostColor={neonColor} />}

                            </div>
                        </div>
                    </>
                ) : (
                    <>
                        {/* ── HEAVY MODE (unencrypted, 400MB+, room-code pairing) ──── */}
                        <div className="text-center flex flex-col gap-2.5">
                            <h1 className="font-mono font-black text-4xl md:text-5xl tracking-tight leading-none"
                                style={{ color: '#fff', textShadow: '0 0 30px rgba(255,204,0,0.08)' }}>
                                High-throughput room transfer.
                            </h1>
                            <p className="text-xs md:text-sm font-mono opacity-40 max-w-md mx-auto">
                                Unencrypted, 4-channel parallel streaming for files over 400MB.
                            </p>
                        </div>

                        <div className="flex items-center rounded-full p-1.5 gap-1.5"
                            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', opacity: heavyLocked ? 0.4 : 1, pointerEvents: heavyLocked ? 'none' : 'auto' }}>
                            <button type="button" onClick={() => setHeavyMode('host')} disabled={heavyLocked}
                                className="px-6 py-2 rounded-full text-xs font-mono font-bold tracking-widest uppercase transition-all"
                                style={{ color: heavyMode === 'host' ? '#0a0a0f' : 'rgba(255,255,255,0.4)', background: heavyMode === 'host' ? '#ffcc00' : 'transparent' }}>
                                Host & Send
                            </button>
                            <button type="button" onClick={() => setHeavyMode('join')} disabled={heavyLocked}
                                className="px-6 py-2 rounded-full text-xs font-mono font-bold tracking-widest uppercase transition-all"
                                style={{ color: heavyMode === 'join' ? '#0a0a0f' : 'rgba(255,255,255,0.4)', background: heavyMode === 'join' ? '#ffcc00' : 'transparent' }}>
                                Join Room
                            </button>
                        </div>

                        <HeavyTransferPanel
                            mode={heavyMode}
                            locked={heavyLocked}
                            setLocked={setHeavyLocked}
                            pushToast={pushToast}
                        />
                    </>
                )}

            </main>

            {/* ── FOOTER ───────────────────────────────────────────────────── */}
            <footer className="relative z-10 px-6 py-6"
                style={{ borderTop: '1px solid rgba(255,255,255,0.04)', background: '#050507' }}>
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <span className="font-mono font-black text-xs tracking-widest text-white">SHAREX SYSTEMS</span>
                        <span className="text-[11px] font-mono opacity-20 hidden md:inline">
                            | Decentralized Symmetric Storage Block Swaps
                        </span>
                    </div>
                    <div className="flex flex-wrap justify-center items-center gap-x-6 gap-y-2">
                        {['Zero Allocation Storage Logs', 'Hardware AES Decryption', 'Multi-channel Swarms'].map(t => (
                            <span key={t} className="text-[10px] font-mono uppercase tracking-wider flex items-center gap-1.5 opacity-30">
                                <span style={{ color: headerColor }}>✓</span> {t}
                            </span>
                        ))}
                    </div>
                    <div className="text-[10px] font-mono opacity-20">
                        © {new Date().getFullYear()} ShareX · Cryptographically Sealed Core
                    </div>
                </div>
            </footer>

        </div>
    );
}

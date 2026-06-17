'use client';

import React, { useState, useEffect, useRef } from 'react';
import { deriveKey } from '../utils/crypto';
import { sliceFileIntoChunks } from '../utils/chunker';
import { useSignaling } from '../hooks/useSignaling';
import { useWebRTC } from '../hooks/useWebRTC';

// ── Neon particle stream (canvas overlay) ─────────────────────────────────────
function ParticleCanvas({ active, color }: { active: boolean; color: string }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animRef   = useRef<number>(0);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d')!;

        const resize = () => {
            canvas.width  = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
        };
        resize();
        window.addEventListener('resize', resize);

        type Particle = { x: number; y: number; vy: number; size: number; alpha: number; };
        const particles: Particle[] = [];

        const spawn = () => {
            if (!active || particles.length > 120) return;
            particles.push({
                x:     Math.random() * canvas.width,
                y:     0,
                vy:    0.5 + Math.random() * 1.5,
                size:  1 + Math.random() * 2,
                alpha: 0.4 + Math.random() * 0.6,
            });
        };

        const draw = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.y += p.vy;
                p.alpha -= 0.004;
                if (p.y > canvas.height || p.alpha <= 0) { particles.splice(i, 1); continue; }
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fillStyle = color + Math.floor(p.alpha * 255).toString(16).padStart(2, '0');
                ctx.fill();
            }
            if (active && Math.random() < 0.4) spawn();
            animRef.current = requestAnimationFrame(draw);
        };

        animRef.current = requestAnimationFrame(draw);
        return () => {
            cancelAnimationFrame(animRef.current);
            window.removeEventListener('resize', resize);
        };
    }, [active, color]);

    return (
        <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 0 }}
        />
    );
}

// ── Scanline progress bar ─────────────────────────────────────────────────────
function NeonBar({ pct, color }: { pct: number; color: string }) {
    return (
        <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
            <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                    width: `${pct}%`,
                    background: `linear-gradient(90deg, ${color}88, ${color})`,
                    boxShadow: `0 0 8px ${color}, 0 0 2px ${color}`,
                }}
            />
        </div>
    );
}

// ── Mode toggle pill ──────────────────────────────────────────────────────────
function ModePill({ mode, onChange }: { mode: 'host' | 'download'; onChange: (m: 'host' | 'download') => void }) {
    return (
        <div className="relative flex items-center rounded-full p-1 gap-1"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>
            {(['host', 'download'] as const).map(m => (
                <button
                    key={m}
                    onClick={() => onChange(m)}
                    className="relative z-10 px-5 py-1.5 rounded-full text-xs font-mono font-bold tracking-widest uppercase transition-all duration-300"
                    style={{
                        color:      mode === m ? '#0a0a0f' : 'rgba(255,255,255,0.4)',
                        background: mode === m
                            ? m === 'host' ? '#00ffe7' : '#ff2d78'
                            : 'transparent',
                        boxShadow:  mode === m
                            ? m === 'host' ? '0 0 16px #00ffe7aa' : '0 0 16px #ff2d78aa'
                            : 'none',
                    }}
                >
                    {m === 'host' ? '⬆ Send' : '⬇ Receive'}
                </button>
            ))}
        </div>
    );
}

// ── Neon input ────────────────────────────────────────────────────────────────
function NeonInput({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-xs font-mono tracking-widest uppercase" style={{ color: 'rgba(255,255,255,0.4)' }}>
                {label}
            </label>
            <input
                {...props}
                className="w-full rounded-lg px-4 py-2.5 text-sm font-mono outline-none transition-all duration-200"
                style={{
                    background:   'rgba(255,255,255,0.04)',
                    border:       '1px solid rgba(255,255,255,0.12)',
                    color:        '#e2e8f0',
                    caretColor:   '#00ffe7',
                }}
                onFocus={e => {
                    e.currentTarget.style.border     = '1px solid #00ffe7';
                    e.currentTarget.style.boxShadow  = '0 0 0 2px #00ffe722';
                }}
                onBlur={e => {
                    e.currentTarget.style.border     = '1px solid rgba(255,255,255,0.12)';
                    e.currentTarget.style.boxShadow  = 'none';
                }}
            />
        </div>
    );
}

// ── Neon button ───────────────────────────────────────────────────────────────
function NeonButton({
    children, onClick, disabled, color = '#00ffe7', type = 'button'
}: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    color?: string;
    type?: 'button' | 'submit';
}) {
    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled}
            className="w-full py-3 rounded-xl font-mono font-bold tracking-widest uppercase text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
                background:  disabled ? 'rgba(255,255,255,0.06)' : `${color}18`,
                border:      `1px solid ${disabled ? 'rgba(255,255,255,0.1)' : color}`,
                color:       disabled ? 'rgba(255,255,255,0.3)' : color,
                boxShadow:   disabled ? 'none' : `0 0 20px ${color}44, inset 0 0 20px ${color}08`,
            }}
            onMouseEnter={e => {
                if (!disabled) {
                    e.currentTarget.style.background = `${color}30`;
                    e.currentTarget.style.boxShadow  = `0 0 30px ${color}77, inset 0 0 30px ${color}12`;
                }
            }}
            onMouseLeave={e => {
                if (!disabled) {
                    e.currentTarget.style.background = `${color}18`;
                    e.currentTarget.style.boxShadow  = `0 0 20px ${color}44, inset 0 0 20px ${color}08`;
                }
            }}
        >
            {children}
        </button>
    );
}

// ── Hash display badge ────────────────────────────────────────────────────────
function HashBadge({ hash, onCopy }: { hash: string; onCopy: () => void }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard.writeText(hash);
        setCopied(true);
        onCopy();
        setTimeout(() => setCopied(false), 2000);
    };
    return (
        <div className="rounded-xl p-4 flex flex-col gap-2"
            style={{ background: 'rgba(0,255,231,0.05)', border: '1px solid rgba(0,255,231,0.2)' }}>
            <p className="text-xs font-mono tracking-widest uppercase" style={{ color: 'rgba(0,255,231,0.6)' }}>
                Share this hash with receiver
            </p>
            <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono break-all" style={{ color: '#00ffe7' }}>
                    {hash}
                </code>
                <button onClick={copy}
                    className="shrink-0 px-3 py-1 rounded-lg text-xs font-mono font-bold transition-all"
                    style={{
                        background: copied ? 'rgba(0,255,231,0.2)' : 'rgba(0,255,231,0.08)',
                        color:      '#00ffe7',
                        border:     '1px solid rgba(0,255,231,0.3)',
                    }}>
                    {copied ? '✓ Copied' : 'Copy'}
                </button>
            </div>
        </div>
    );
}

// ── Status log line ───────────────────────────────────────────────────────────
function StatusLine({ msg }: { msg: string }) {
    if (!msg) return null;
    const isError = msg.startsWith('❌');
    const isOk    = msg.startsWith('✅');
    return (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs font-mono"
            style={{
                background: isError ? 'rgba(255,45,120,0.08)'
                          : isOk    ? 'rgba(0,255,231,0.08)'
                          :            'rgba(255,255,255,0.04)',
                border: `1px solid ${isError ? 'rgba(255,45,120,0.2)' : isOk ? 'rgba(0,255,231,0.15)' : 'rgba(255,255,255,0.08)'}`,
                color:  isError ? '#ff2d78' : isOk ? '#00ffe7' : 'rgba(255,255,255,0.5)',
            }}>
            <span className="opacity-40 shrink-0">›</span>
            <span>{msg}</span>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function HomePage() {
    const [mode, setMode]         = useState<'host' | 'download'>('host');
    const [file, setFile]         = useState<File | null>(null);
    const [passPhrase, setPassPhrase]         = useState('');
    const [fileHashInput, setFileHashInput]   = useState('');
    const [downloadPassword, setDownloadPassword] = useState('');
    const [isProcessing, setIsProcessing]     = useState(false);
    const [fileHash, setFileHash] = useState('');
    const [isTransferring, setIsTransferring] = useState(false);

    // Refs
    const passPhraseRef        = useRef('');
    const downloadPasswordRef  = useRef('');
    const activeFileHashRef    = useRef('');
    const uploadSaltRef        = useRef<Uint8Array | null>(null);

    useEffect(() => { passPhraseRef.current       = passPhrase;       }, [passPhrase]);
    useEffect(() => { downloadPasswordRef.current = downloadPassword; }, [downloadPassword]);

    // Warn on reload during transfer
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (!isTransferring) return;
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [isTransferring]);

    // ── Signaling + WebRTC ───────────────────────────────────────────────────
    function onDownloaderFound(downloaderSocketId: string) {
        const salt = uploadSaltRef.current;
        if (!salt) return;
        setMode('host');
        setIsTransferring(true);
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
        sendSignal,
        hashIdText,
    } = useSignaling({ onSignalReceived, onDownloaderFound });

    const {
        initializeSender,
        initializeReceiver,
        handleIncomingSignal,
        sendProgress,
        receiveProgress,
        downloadUrl,
    } = useWebRTC({ sendSignal, setStatusMessage });

    // Mark transfer done when progress hits 100
    useEffect(() => {
        if (sendProgress === 100 || receiveProgress === 100) {
            setIsTransferring(false);
        }
    }, [sendProgress, receiveProgress]);

    // ── Helpers ──────────────────────────────────────────────────────────────
    async function generateFileHash(name: string): Promise<string> {
        const buf = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(name + Math.random() + Date.now())
        );
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ── Upload ───────────────────────────────────────────────────────────────
    const handleUpload = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!file || !passPhrase) { setStatusMessage('Select a file and enter a passphrase.'); return; }
        try {
            setIsProcessing(true);
            setStatusMessage('Encrypting file...');
            const salt = window.crypto.getRandomValues(new Uint8Array(16));
            uploadSaltRef.current = salt;
            const hash = await generateFileHash(file.name);
            const key  = await deriveKey(passPhrase, salt);
            await sliceFileIntoChunks(file, 16384, key, hash);
            activeFileHashRef.current = hash;
            setFileHash(hash);
            registerFile(hash);
            setStatusMessage('✅ File hosted! Share the hash with your peer.');
        } catch (err) {
            console.error(err);
            setStatusMessage('❌ Encryption failed.');
        } finally {
            setIsProcessing(false);
        }
    };

    // ── Download ─────────────────────────────────────────────────────────────
    const handleDownload = async (e: React.FormEvent) => {
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
            console.error(err);
            setStatusMessage('❌ Lookup failed.');
        } finally {
            setIsProcessing(false);
        }
    };

    // ── Derived display ───────────────────────────────────────────────────────
    const progress   = mode === 'host' ? sendProgress : receiveProgress;
    const neonColor  = mode === 'host' ? '#00ffe7' : '#ff2d78';
    const isActive   = isTransferring || isProcessing;

    return (
        <div className="min-h-screen flex flex-col" style={{ background: '#0a0a0f', color: '#e2e8f0' }}>

            {/* Ambient background glow */}
            <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 0 }}>
                <div style={{
                    position: 'absolute', top: '-20%', left: '-10%',
                    width: '60vw', height: '60vw', borderRadius: '50%',
                    background: 'radial-gradient(circle, #00ffe708 0%, transparent 70%)',
                }} />
                <div style={{
                    position: 'absolute', bottom: '-20%', right: '-10%',
                    width: '50vw', height: '50vw', borderRadius: '50%',
                    background: 'radial-gradient(circle, #ff2d7806 0%, transparent 70%)',
                }} />
            </div>

            {/* ── Header ─────────────────────────────────────────────────── */}
            <header className="relative z-10 flex items-center justify-between px-6 py-4"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ background: 'rgba(0,255,231,0.1)', border: '1px solid rgba(0,255,231,0.3)' }}>
                        <span style={{ color: '#00ffe7', fontSize: 14 }}>✦</span>
                    </div>
                    <div>
                        <span className="font-mono font-black tracking-widest text-lg" style={{ color: '#00ffe7', textShadow: '0 0 20px #00ffe7aa' }}>
                            SHAREX
                        </span>
                        <div className="text-xs font-mono" style={{ color: 'rgba(255,255,255,0.25)' }}>
                            end-to-end encrypted P2P transfer
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div className="w-1.5 h-1.5 rounded-full animate-pulse"
                        style={{ background: myConnectionId ? '#00ffe7' : '#ff2d78' }} />
                    <span className="text-xs font-mono" style={{ color: 'rgba(255,255,255,0.3)' }}>
                        {myConnectionId ? myConnectionId.slice(0, 8) + '...' : 'connecting'}
                    </span>
                </div>
            </header>

            {/* ── Main content ───────────────────────────────────────────── */}
            <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 py-12 gap-8">

                {/* Hero line */}
                <div className="text-center flex flex-col gap-2">
                    <h1 className="font-mono font-black text-4xl md:text-5xl tracking-tight"
                        style={{ color: '#fff', textShadow: '0 0 40px rgba(0,255,231,0.15)' }}>
                        Transfer without limits.
                    </h1>
                    <p className="text-sm font-mono" style={{ color: 'rgba(255,255,255,0.3)' }}>
                        Encrypted · Peer-to-peer · Zero servers touch your data
                    </p>
                </div>

                {/* Mode toggle */}
                {!isTransferring && (
                    <div
                        style={{
                            opacity:    isTransferring ? 0 : 1,
                            transform:  isTransferring ? 'translateY(-8px)' : 'translateY(0)',
                            transition: 'all 0.3s ease',
                        }}>
                        <ModePill mode={mode} onChange={m => { setMode(m); setStatusMessage(''); }} />
                    </div>
                )}

                {/* Transfer card */}
                <div
                    className="relative w-full max-w-md rounded-2xl overflow-hidden"
                    style={{
                        background:  'rgba(255,255,255,0.03)',
                        border:      `1px solid ${isActive ? neonColor + '44' : 'rgba(255,255,255,0.1)'}`,
                        boxShadow:   isActive ? `0 0 40px ${neonColor}22, 0 0 80px ${neonColor}0a` : '0 0 0 rgba(0,0,0,0)',
                        transition:  'all 0.4s ease',
                    }}
                >
                    {/* Particle canvas */}
                    <ParticleCanvas active={isActive} color={neonColor} />

                    {/* Card content */}
                    <div className="relative z-10 p-6 flex flex-col gap-5"
                        style={{
                            // Slide animation between modes
                            animation: 'none',
                        }}>

                        {/* Mode label */}
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full"
                                style={{ background: neonColor, boxShadow: `0 0 8px ${neonColor}` }} />
                            <span className="text-xs font-mono tracking-widest uppercase"
                                style={{ color: neonColor }}>
                                {mode === 'host' ? 'Hosting a file' : 'Receiving a file'}
                            </span>
                        </div>

                        {/* ── HOST FORM ──────────────────────────────────── */}
                        {mode === 'host' && (
                            <form onSubmit={handleUpload} className="flex flex-col gap-4">
                                {/* File drop zone */}
                                <div
                                    className="rounded-xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition-all duration-200"
                                    style={{
                                        background: 'rgba(0,255,231,0.03)',
                                        border:     `1px dashed ${file ? '#00ffe7' : 'rgba(255,255,255,0.12)'}`,
                                        boxShadow:  file ? '0 0 20px rgba(0,255,231,0.1)' : 'none',
                                    }}
                                    onClick={() => document.getElementById('file-input')?.click()}
                                    onDragOver={e => e.preventDefault()}
                                    onDrop={e => {
                                        e.preventDefault();
                                        const f = e.dataTransfer.files[0];
                                        if (f) setFile(f);
                                    }}
                                >
                                    <input
                                        type="file"
                                        id="file-input"
                                        className="hidden"
                                        onChange={e => setFile(e.target.files?.[0] || null)}
                                        disabled={isProcessing}
                                    />
                                    <div className="text-2xl">{file ? '📄' : '📁'}</div>
                                    <div className="text-sm font-mono text-center" style={{ color: file ? '#00ffe7' : 'rgba(255,255,255,0.3)' }}>
                                        {file ? file.name : 'Drop file here or click to browse'}
                                    </div>
                                    {file && (
                                        <div className="text-xs font-mono" style={{ color: 'rgba(0,255,231,0.5)' }}>
                                            {(file.size / 1024 / 1024).toFixed(2)} MB
                                        </div>
                                    )}
                                </div>

                                <NeonInput
                                    label="Encryption passphrase"
                                    type="password"
                                    placeholder="enter a strong passphrase"
                                    value={passPhrase}
                                    onChange={e => setPassPhrase(e.target.value)}
                                    disabled={isProcessing}
                                />

                                <NeonButton type="submit" disabled={isProcessing || !file || !passPhrase} color="#00ffe7">
                                    {isProcessing ? '⠋ Encrypting...' : '⬆ Encrypt & Host File'}
                                </NeonButton>

                                {/* File hash badge appears once hosted */}
                                {fileHash && (
                                    <HashBadge hash={fileHash} onCopy={() => {}} />
                                )}

                                {/* Send progress */}
                                {sendProgress > 0 && (
                                    <div className="flex flex-col gap-2">
                                        <div className="flex justify-between text-xs font-mono"
                                            style={{ color: 'rgba(0,255,231,0.6)' }}>
                                            <span>Sending</span>
                                            <span>{sendProgress}%</span>
                                        </div>
                                        <NeonBar pct={sendProgress} color="#00ffe7" />
                                    </div>
                                )}
                            </form>
                        )}

                        {/* ── DOWNLOAD FORM ────────────────────────────── */}
                        {mode === 'download' && (
                            <form onSubmit={handleDownload} className="flex flex-col gap-4">
                                <NeonInput
                                    label="File hash from sender"
                                    type="text"
                                    placeholder="paste the hash here"
                                    value={fileHashInput}
                                    onChange={e => setFileHashInput(e.target.value)}
                                    disabled={isProcessing}
                                    style={{ fontFamily: 'monospace', fontSize: 11 }}
                                />
                                <NeonInput
                                    label="Decryption passphrase"
                                    type="password"
                                    placeholder="same passphrase as sender"
                                    value={downloadPassword}
                                    onChange={e => setDownloadPassword(e.target.value)}
                                    disabled={isProcessing}
                                />

                                <NeonButton type="submit" disabled={isProcessing || !fileHashInput || !downloadPassword} color="#ff2d78">
                                    {isProcessing ? '⠋ Connecting...' : '⬇ Connect & Download'}
                                </NeonButton>

                                {/* Receive progress */}
                                {receiveProgress > 0 && (
                                    <div className="flex flex-col gap-2">
                                        <div className="flex justify-between text-xs font-mono"
                                            style={{ color: 'rgba(255,45,120,0.7)' }}>
                                            <span>Receiving</span>
                                            <span>{receiveProgress}%</span>
                                        </div>
                                        <NeonBar pct={receiveProgress} color="#ff2d78" />
                                    </div>
                                )}

                                {/* Fallback download URL (non-Chrome) */}
                                {downloadUrl && (
                                    <a
                                        href={downloadUrl}
                                        download="shared_file"
                                        className="block w-full text-center py-3 rounded-xl font-mono font-bold text-sm tracking-widest uppercase transition-all animate-bounce"
                                        style={{
                                            background: 'rgba(255,45,120,0.12)',
                                            border:     '1px solid #ff2d78',
                                            color:      '#ff2d78',
                                            boxShadow:  '0 0 20px #ff2d7844',
                                        }}
                                    >
                                        📥 Save file to device
                                    </a>
                                )}
                            </form>
                        )}

                        {/* Status line — always at the bottom of the card */}
                        {statusMessage && <StatusLine msg={statusMessage} />}
                    </div>
                </div>

                {/* How it works — 3 steps */}
                {!isTransferring && !fileHash && (
                    <div className="w-full max-w-md grid grid-cols-3 gap-3 mt-2">
                        {[
                            { icon: '🔐', label: 'Encrypt', desc: 'AES-256 in your browser' },
                            { icon: '⚡', label: 'Stream',  desc: 'Direct peer-to-peer link' },
                            { icon: '💾', label: 'Write',   desc: 'Straight to your disk'   },
                        ].map(s => (
                            <div key={s.label} className="flex flex-col items-center gap-1.5 p-3 rounded-xl text-center"
                                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                                <span className="text-xl">{s.icon}</span>
                                <span className="text-xs font-mono font-bold tracking-widest uppercase"
                                    style={{ color: 'rgba(255,255,255,0.6)' }}>{s.label}</span>
                                <span className="text-xs font-mono" style={{ color: 'rgba(255,255,255,0.25)' }}>
                                    {s.desc}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

            </main>

            {/* ── Footer ─────────────────────────────────────────────────── */}
            <footer className="relative z-10 px-6 py-6"
                style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <span className="font-mono font-black text-sm tracking-widest"
                            style={{ color: '#00ffe7', textShadow: '0 0 10px #00ffe766' }}>
                            SHAREX
                        </span>
                        <span className="text-xs font-mono" style={{ color: 'rgba(255,255,255,0.2)' }}>
                            · P2P Encrypted File Transfer
                        </span>
                    </div>
                    <div className="flex items-center gap-6">
                        {['No servers', 'No logs', 'Open protocol'].map(t => (
                            <span key={t} className="text-xs font-mono flex items-center gap-1.5"
                                style={{ color: 'rgba(255,255,255,0.25)' }}>
                                <span style={{ color: '#00ffe7' }}>✓</span> {t}
                            </span>
                        ))}
                    </div>
                    <div className="text-xs font-mono" style={{ color: 'rgba(255,255,255,0.15)' }}>
                        © {new Date().getFullYear()} ShareX · All transfers are ephemeral
                    </div>
                </div>
            </footer>

        </div>
    );
}
'use client';

/**
 * Navbar.tsx — top-level mode switcher between Safe (small file) and
 * Heavy (large file) transfer experiences.
 *
 * "Safe small file share" = the existing AES-256-GCM encrypted pipeline,
 * hash + passphrase pairing, 16KB chunks, IndexedDB staging.
 *
 * "Heavy file share" = the new unencrypted pipeline for files > 400MB,
 * room-code pairing, 1MB chunks, direct File-object streaming with no
 * IndexedDB staging step.
 */

import React from 'react';

export type TransferTier = 'safe' | 'heavy';

interface NavbarProps {
    tier: TransferTier;
    onChangeTier: (tier: TransferTier) => void;
    locked: boolean;   // true mid-transfer — prevents switching tiers and losing state
}

export function Navbar({ tier, onChangeTier, locked }: NavbarProps) {
    return (
        <nav
            className="relative z-10 flex items-center justify-center gap-2 px-4 py-3"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(7,7,10,0.6)' }}
        >
            <button
                type="button"
                disabled={locked}
                onClick={() => !locked && onChangeTier('safe')}
                className="px-5 py-2 rounded-full text-xs font-mono font-bold tracking-widest uppercase transition-all duration-300"
                style={{
                    color:      tier === 'safe' ? '#0a0a0f' : 'rgba(255,255,255,0.4)',
                    background: tier === 'safe' ? '#adff2f' : 'transparent',
                    border:     tier === 'safe' ? '1px solid #adff2f' : '1px solid rgba(255,255,255,0.1)',
                    boxShadow:  tier === 'safe' ? '0 0 16px rgba(173,255,47,0.4)' : 'none',
                    opacity:    locked ? 0.35 : 1,
                    cursor:     locked ? 'not-allowed' : 'pointer',
                }}
            >
                🔒 Safe small file share
            </button>

            <button
                type="button"
                disabled={locked}
                onClick={() => !locked && onChangeTier('heavy')}
                className="px-5 py-2 rounded-full text-xs font-mono font-bold tracking-widest uppercase transition-all duration-300"
                style={{
                    color:      tier === 'heavy' ? '#0a0a0f' : 'rgba(255,255,255,0.4)',
                    background: tier === 'heavy' ? '#ffcc00' : 'transparent',
                    border:     tier === 'heavy' ? '1px solid #ffcc00' : '1px solid rgba(255,255,255,0.1)',
                    boxShadow:  tier === 'heavy' ? '0 0 16px rgba(255,204,0,0.4)' : 'none',
                    opacity:    locked ? 0.35 : 1,
                    cursor:     locked ? 'not-allowed' : 'pointer',
                }}
            >
                ⚡ Heavy file share
            </button>
        </nav>
    );
}

/**
 * Shared notice banner — both tiers show a clear notice explaining what
 * they're getting (encrypted+slower vs unencrypted+fast), satisfying the
 * "both pages should have notice regarding the file transfer" requirement.
 */
export function TierNotice({ tier }: { tier: TransferTier }) {
    if (tier === 'safe') {
        return (
            <div
                className="w-full max-w-md rounded-xl px-4 py-3 text-xs font-mono flex items-start gap-2.5"
                style={{ background: 'rgba(173,255,47,0.05)', border: '1px solid rgba(173,255,47,0.2)', color: '#adff2f' }}
            >
                <span className="shrink-0">🔒</span>
                <span style={{ color: 'rgba(173,255,47,0.85)' }}>
                    Safe mode encrypts your file with AES-256-GCM before it ever leaves your browser.
                    Best for files under 400MB. Larger files will take significantly longer to encrypt —
                    switch to Heavy file share for faster, unencrypted transfer of big files.
                </span>
            </div>
        );
    }
    return (
        <div
            className="w-full max-w-md rounded-xl px-4 py-3 text-xs font-mono flex items-start gap-2.5"
            style={{ background: 'rgba(255,204,0,0.06)', border: '1px solid rgba(255,204,0,0.25)', color: '#ffcc00' }}
        >
            <span className="shrink-0">⚠️</span>
            <span style={{ color: 'rgba(255,204,0,0.9)' }}>
                Heavy mode sends your file directly with <strong style={{ fontWeight: 500 }}>no app-level encryption</strong> for
                maximum speed across 4 parallel channels. Data is still protected in transit by WebRTC's
                built-in DTLS, but is not separately encrypted by ShareX. Use this for large, low-sensitivity
                files (videos, archives, disk images) — pairing happens via a one-time room code instead of a passphrase.
            </span>
        </div>
    );
}
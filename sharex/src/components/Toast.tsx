'use client';

/**
 * Toast.tsx — lightweight toast notification system matching the ShareX neon theme
 *
 * Usage:
 *   const { toasts, pushToast } = useToasts();
 *   pushToast({ type: 'success', message: 'File sent!', color: '#adff2f' });
 *   <ToastStack toasts={toasts} />
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';

export interface ToastItem {
    id:      number;
    type:    'success' | 'error' | 'info';
    message: string;
    color?:  string;     // overrides the default type color (used for mode theming)
    duration?: number;   // ms before auto-dismiss, default 4000
}

let toastIdCounter = 0;

export function useToasts() {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

    const dismissToast = useCallback((id: number) => {
        setToasts(prev => prev.filter(t => t.id !== id));
        const t = timers.current.get(id);
        if (t) { clearTimeout(t); timers.current.delete(id); }
    }, []);

    const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
        const id = ++toastIdCounter;
        setToasts(prev => [...prev, { ...toast, id }]);
        const duration = toast.duration ?? 4000;
        const timer = setTimeout(() => dismissToast(id), duration);
        timers.current.set(id, timer);
        return id;
    }, [dismissToast]);

    useEffect(() => () => {
        // Cleanup all timers on unmount
        timers.current.forEach(t => clearTimeout(t));
        timers.current.clear();
    }, []);

    return { toasts, pushToast, dismissToast };
}

const TYPE_ICON: Record<ToastItem['type'], string> = {
    success: '✅',
    error:   '❌',
    info:    'ℹ️',
};

const TYPE_DEFAULT_COLOR: Record<ToastItem['type'], string> = {
    success: '#adff2f',
    error:   '#ff3366',
    info:    '#ff6600',
};

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
    const color = toast.color ?? TYPE_DEFAULT_COLOR[toast.type];
    const [exiting, setExiting] = useState(false);

    const handleDismiss = () => {
        setExiting(true);
        setTimeout(onDismiss, 200); // wait for exit animation
    };

    return (
        <div
            className="flex items-start gap-3 rounded-xl px-4 py-3 pointer-events-auto"
            style={{
                background: 'rgba(12,12,16,0.92)',
                backdropFilter: 'blur(12px)',
                border: `1px solid ${color}44`,
                boxShadow: `0 0 24px ${color}22, 0 8px 24px rgba(0,0,0,0.4)`,
                minWidth: 260,
                maxWidth: 360,
                animation: exiting
                    ? 'shareXToastOut 0.2s ease forwards'
                    : 'shareXToastIn 0.3s cubic-bezier(0.16,1,0.3,1) forwards',
            }}
        >
            <span style={{ fontSize: 16, lineHeight: 1, marginTop: 1 }}>{TYPE_ICON[toast.type]}</span>
            <span
                className="flex-1 text-xs font-mono leading-relaxed"
                style={{ color: '#e2e8f0' }}
            >
                {toast.message}
            </span>
            <button
                onClick={handleDismiss}
                className="text-xs font-mono opacity-40 hover:opacity-80 transition-opacity shrink-0"
                style={{ color: '#e2e8f0' }}
                aria-label="Dismiss"
            >
                ✕
            </button>
        </div>
    );
}

export function ToastStack({ toasts, dismissToast }: { toasts: ToastItem[]; dismissToast: (id: number) => void }) {
    return (
        <>
            <style>{`
                @keyframes shareXToastIn {
                    from { opacity: 0; transform: translateY(-12px) scale(0.96); }
                    to   { opacity: 1; transform: translateY(0)     scale(1);    }
                }
                @keyframes shareXToastOut {
                    from { opacity: 1; transform: translateY(0)    scale(1);    }
                    to   { opacity: 0; transform: translateY(-8px) scale(0.96); }
                }
            `}</style>
            <div
                className="fixed top-5 right-5 z-50 flex flex-col gap-2.5 pointer-events-none"
                style={{ zIndex: 9999 }}
            >
                {toasts.map(t => (
                    <ToastCard key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
                ))}
            </div>
        </>
    );
}
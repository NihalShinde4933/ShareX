'use client';

import React, { useState, useEffect, useRef } from 'react';
import { deriveKey } from '../utils/crypto';
import { sliceFileIntoChunks } from '../utils/chunker';
import { useSignaling } from '../hooks/useSignaling';
import { useWebRTC } from '../hooks/useWebRTC';

export default function HomePage() {
    const [file, setFile]                     = useState<File | null>(null);
    const [passPhrase, setPassPhrase]         = useState("");
    const [fileHashInput, setFileHashInput]   = useState("");
    const [downloadPassword, setDownloadPassword] = useState("");
    const [downloadUrl, setDownloadUrl]       = useState("");
    const [isProcessing, setIsProcessing]     = useState(false);

    // Refs that async callbacks read — prevents stale closure bugs
    const passPhraseRef       = useRef<string>("");
    const downloadPasswordRef = useRef<string>("");
    const activeFileHashRef   = useRef<string>("");
    const uploadSaltRef       = useRef<Uint8Array | null>(null);

    useEffect(() => { passPhraseRef.current       = passPhrase;       }, [passPhrase]);
    useEffect(() => { downloadPasswordRef.current = downloadPassword; }, [downloadPassword]);

    // ── Hooks ─────────────────────────────────────────────────────────────────

    /**
     * onDownloaderFound: fires on the UPLOADER when the server sends DOWNLOADER_FOUND.
     * At that point we have the downloader's socket ID and can start a WebRTC offer.
     */
    function onDownloaderFound(downloaderSocketId: string) {
        const salt = uploadSaltRef.current;
        if (!salt) {
            console.error("onDownloaderFound: no uploadSalt — was file encrypted?");
            return;
        }
        console.log(`🛰️  Downloader ${downloaderSocketId} found — starting sender`);
        initializeSender(
            activeFileHashRef.current,
            passPhraseRef.current,
            salt,
            downloaderSocketId
        );
    }

    /**
     * onSignalReceived: fires on BOTH machines for WebRTC signaling packets.
     *   - offer   → we are the DOWNLOADER → call initializeReceiver
     *   - answer/candidate → we are the UPLOADER → call handleIncomingSignal
     */
    function onSignalReceived(senderId: string, signalData: any) {
        if (signalData.type === 'offer') {
            console.log(`📥 Offer from ${senderId} — initializing receiver`);
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
        sendSignal,       // ← owned by useSignaling, passed to useWebRTC
        hashIdText,
    } = useSignaling({ onSignalReceived, onDownloaderFound });

    const {
        initializeSender,
        initializeReceiver,
        handleIncomingSignal,
        receivedChunks,
    } = useWebRTC({ sendSignal, setStatusMessage });

    // ── Build download URL when receiver finishes ─────────────────────────────
    useEffect(() => {
        if (receivedChunks.length === 0) return;
        const blob = new Blob(
            receivedChunks.map(b => new Uint8Array(b)),
            { type: "application/octet-stream" }
        );
        setDownloadUrl(URL.createObjectURL(blob));
        setStatusMessage("✅ File ready! Click below to save.");
    }, [receivedChunks]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Handlers ──────────────────────────────────────────────────────────────

    async function generateFileHash(name: string): Promise<string> {
        const buf = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(name + Math.random() + Date.now())
        );
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const handleUploadAndEncrypt = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!file || !passPhrase) {
            setStatusMessage("Please select a file and enter a passphrase.");
            return;
        }
        try {
            setIsProcessing(true);
            setDownloadUrl("");
            setStatusMessage("Encrypting file...");

            // Generate the salt ONCE here.
            // This same salt is stored in uploadSaltRef and later sent over the
            // WebRTC data channel (in initializeSender) as the first unencrypted
            // message so the receiver can derive the identical AES-GCM key.
            const salt = window.crypto.getRandomValues(new Uint8Array(16));
            uploadSaltRef.current = salt;

            const fileHash = await generateFileHash(file.name);
            const key = await deriveKey(passPhrase, salt);

            // All DB writes are awaited inside sliceFileIntoChunks
            await sliceFileIntoChunks(file, 16384, key, fileHash);
            activeFileHashRef.current = fileHash;

            // Tell the signaling server we're hosting this hash.
            // When a downloader looks it up, the server sends us DOWNLOADER_FOUND
            // and our onDownloaderFound callback fires initializeSender.
            registerFile(fileHash);
            setStatusMessage("✅ Hosted! Share the hash below with your peer.");
        } catch (err) {
            console.error(err);
            setStatusMessage("Encryption failed.");
        } finally {
            setIsProcessing(false);
        }
    };

    const handleLookupAndStream = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!fileHashInput || !downloadPassword) {
            setStatusMessage("Enter both the file hash and passphrase.");
            return;
        }
        try {
            setIsProcessing(true);
            setDownloadUrl("");
            // After this, everything is event-driven:
            // server → DOWNLOADER_FOUND on uploader → offer → SIGNAL on downloader
            // → initializeReceiver → answer → data channel → chunks → decrypt
            lookupFile(fileHashInput);
        } catch (err) {
            console.error(err);
            setStatusMessage("Lookup failed.");
        } finally {
            setIsProcessing(false);
        }
    };

    // ── UI ────────────────────────────────────────────────────────────────────
    return (
        <div className='h-screen flex flex-col bg-blue-200 items-center justify-center p-4'>
            <div className='flex flex-col bg-white self-center p-3 rounded-lg shadow-md max-w-2xl w-full'>

                <div className="flex flex-col items-center justify-center p-5 border-b border-gray-200 gap-1">
                    <span className="text-5xl font-bold text-blue-600 tracking-wide">ShareX</span>
                    <span className="text-[10px] font-mono text-gray-400">
                        Node ID: {myConnectionId || "Connecting..."}
                    </span>
                </div>

                <div className="flex flex-col md:flex-row justify-center p-5 items-stretch gap-4">

                    {/* Uploader */}
                    <form onSubmit={handleUploadAndEncrypt}
                        className="flex flex-col flex-1 border border-gray-300 rounded p-4 justify-center gap-2">
                        <span className="text-xs font-bold text-blue-600 uppercase tracking-wider mb-1">
                            Host a File
                        </span>
                        <label htmlFor="file" className="font-medium text-sm text-gray-700">Select file</label>
                        <input type="file" id="file"
                            className='border border-gray-300 rounded p-1 text-sm w-full'
                            onChange={(e) => setFile(e.target.files?.[0] || null)}
                            disabled={isProcessing} />
                        <label htmlFor="passphrase" className="font-medium text-sm text-gray-700 mt-2">Passphrase</label>
                        <input type="password" id="passphrase"
                            value={passPhrase} onChange={(e) => setPassPhrase(e.target.value)}
                            className='border border-gray-300 rounded p-1 w-full'
                            disabled={isProcessing} />
                        <button type="submit" disabled={isProcessing}
                            className='mt-4 bg-blue-600 text-white px-4 py-1.5 rounded font-medium hover:bg-blue-700 w-full transition disabled:bg-gray-400 text-sm'>
                            {isProcessing ? "Encrypting..." : "Encrypt & Host"}
                        </button>
                    </form>

                    {/* Downloader */}
                    <form onSubmit={handleLookupAndStream}
                        className="flex flex-col flex-1 border border-gray-300 rounded p-4 justify-center gap-2">
                        <span className="text-xs font-bold text-green-600 uppercase tracking-wider mb-1">
                            Download a File
                        </span>
                        <label htmlFor="hashInput" className="font-medium text-sm text-gray-700">File Hash</label>
                        <input type="text" id="hashInput"
                            value={fileHashInput} onChange={(e) => setFileHashInput(e.target.value)}
                            className='border border-gray-300 rounded p-1 w-full font-mono text-xs'
                            disabled={isProcessing} />
                        <label htmlFor="downloadPassword" className="font-medium text-sm text-gray-700 mt-2">Passphrase</label>
                        <input type="password" id="downloadPassword"
                            value={downloadPassword} onChange={(e) => setDownloadPassword(e.target.value)}
                            className='border border-gray-300 rounded p-1 w-full'
                            disabled={isProcessing} />
                        <button type="submit" disabled={isProcessing}
                            className='mt-4 bg-green-600 text-white px-4 py-1.5 rounded font-medium hover:bg-green-700 w-full transition disabled:bg-gray-400 text-sm'>
                            {isProcessing ? "Looking up..." : "Connect & Download"}
                        </button>

                        {downloadUrl && (
                            <a href={downloadUrl} download="shared_file"
                                className='mt-2 bg-blue-600 text-white px-4 py-1.5 rounded font-medium text-center hover:bg-blue-700 transition block text-sm p-2 shadow-sm animate-bounce'>
                                📥 Click to save file
                            </a>
                        )}
                    </form>

                </div>

                <div className="bg-gray-100 border-t border-gray-200 text-xs font-mono text-gray-600 p-2 rounded-b text-center">
                    {hashIdText}<br />
                    Status: {statusMessage}
                </div>
            </div>
        </div>
    );
}
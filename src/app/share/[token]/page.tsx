'use client';

import React, { useEffect, useState } from 'react';
import {
  Download, Lock, FileText, Image as ImageIcon, Film, Music, File,
  AlertTriangle, Clock, CheckCircle2, Shield, Loader2, ExternalLink
} from 'lucide-react';

interface SharedFileData {
  id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  uploaded_at: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getFileIcon(mimeType: string) {
  const cls = 'h-16 w-16';
  if (mimeType?.startsWith('image/')) return <ImageIcon className={`${cls} text-emerald-400`} />;
  if (mimeType?.startsWith('video/')) return <Film className={`${cls} text-purple-400`} />;
  if (mimeType?.startsWith('audio/')) return <Music className={`${cls} text-amber-400`} />;
  if (mimeType?.includes('pdf')) return <FileText className={`${cls} text-rose-400`} />;
  return <File className={`${cls} text-indigo-400`} />;
}

export default function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'password' | 'ready' | 'error' | 'expired' | 'notfound'>('loading');
  const [fileData, setFileData] = useState<SharedFileData | null>(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Resolve params
  useEffect(() => {
    params.then((p) => setToken(p.token));
  }, [params]);

  // Fetch share link metadata
  useEffect(() => {
    if (!token) return;

    const fetchMeta = async () => {
      try {
        const res = await fetch(`/api/share/${token}`);
        if (res.status === 404) { setPhase('notfound'); return; }
        if (res.status === 410) { setPhase('expired'); return; }
        if (!res.ok) { setPhase('error'); setErrorMessage('Failed to load share link.'); return; }

        const json = await res.json();
        const data = json.data || json;
        setFileData(data.file);

        if (data.isPasswordProtected) {
          setPhase('password');
        } else {
          setPhase('ready');
        }
      } catch {
        setPhase('error');
        setErrorMessage('Network error. Please try again.');
      }
    };

    fetchMeta();
  }, [token]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setPasswordError('');

    try {
      const res = await fetch(`/api/share/${token}/download?password=${encodeURIComponent(password)}`, {
        method: 'HEAD',
      }).catch(() => null);

      // If HEAD not supported, attempt a quick GET check
      const checkRes = await fetch(`/api/share/${token}?password=${encodeURIComponent(password)}`);
      if (checkRes.status === 401) {
        setPasswordError('Incorrect password. Please try again.');
        return;
      }
      setPhase('ready');
    } catch {
      setPasswordError('Could not verify password. Try again.');
    }
  };

  const handleDownload = async () => {
    if (!token || !fileData) return;
    setIsDownloading(true);
    try {
      const url = password
        ? `/api/share/${token}/download?password=${encodeURIComponent(password)}`
        : `/api/share/${token}/download`;

      const link = document.createElement('a');
      link.href = url;
      link.download = fileData.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setTimeout(() => setIsDownloading(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white font-sans flex flex-col items-center justify-center px-4 py-16 selection:bg-indigo-500 selection:text-white">
      {/* Background gradient */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(99,102,241,0.12)_0%,_transparent_70%)]" />

      {/* Branding */}
      <div className="mb-10 flex items-center gap-2 text-slate-400 text-sm">
        <Shield className="h-5 w-5 text-indigo-400" />
        <span className="font-semibold tracking-wide text-slate-300">MultiDrive</span>
        <span className="text-slate-600">·</span>
        <span>Secure file sharing</span>
      </div>

      {/* Card */}
      <div className="relative w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/80 backdrop-blur-2xl shadow-2xl overflow-hidden">
        {/* Top gradient bar */}
        <div className="h-1 w-full bg-gradient-to-r from-indigo-500 via-purple-500 to-cyan-500" />

        <div className="p-8">
          {/* LOADING */}
          {phase === 'loading' && (
            <div className="flex flex-col items-center gap-4 py-8">
              <Loader2 className="h-10 w-10 text-indigo-400 animate-spin" />
              <p className="text-sm text-slate-400">Loading shared file…</p>
            </div>
          )}

          {/* NOT FOUND */}
          {phase === 'notfound' && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800">
                <AlertTriangle className="h-8 w-8 text-amber-400" />
              </div>
              <h1 className="text-xl font-bold text-white">Link Not Found</h1>
              <p className="text-sm text-slate-400">This share link doesn't exist or has been removed.</p>
            </div>
          )}

          {/* EXPIRED */}
          {phase === 'expired' && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800">
                <Clock className="h-8 w-8 text-rose-400" />
              </div>
              <h1 className="text-xl font-bold text-white">Link Expired</h1>
              <p className="text-sm text-slate-400">This share link has passed its expiry date.</p>
            </div>
          )}

          {/* ERROR */}
          {phase === 'error' && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800">
                <AlertTriangle className="h-8 w-8 text-rose-400" />
              </div>
              <h1 className="text-xl font-bold text-white">Error</h1>
              <p className="text-sm text-slate-400">{errorMessage || 'Something went wrong.'}</p>
            </div>
          )}

          {/* PASSWORD GATE */}
          {phase === 'password' && fileData && (
            <div className="space-y-6">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20">
                  <Lock className="h-7 w-7 text-amber-400" />
                </div>
                <div>
                  <h1 className="text-lg font-bold text-white">Password Protected</h1>
                  <p className="text-xs text-slate-400 mt-1 truncate max-w-xs">{fileData.filename}</p>
                </div>
              </div>

              <form onSubmit={handlePasswordSubmit} className="space-y-3">
                <input
                  type="password"
                  placeholder="Enter password…"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  className="w-full h-10 rounded-xl border border-slate-700 bg-slate-800 px-4 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                />
                {passwordError && (
                  <p className="text-xs text-rose-400 flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" /> {passwordError}
                  </p>
                )}
                <button
                  type="submit"
                  className="w-full h-10 rounded-xl bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-500 transition"
                >
                  Unlock File
                </button>
              </form>
            </div>
          )}

          {/* READY — file info + download */}
          {phase === 'ready' && fileData && (
            <div className="space-y-6">
              {/* File info */}
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-slate-800/80 border border-slate-700">
                  {getFileIcon(fileData.mime_type)}
                </div>
                <div>
                  <h1 className="text-base font-bold text-white leading-tight break-all px-2">
                    {fileData.filename}
                  </h1>
                  <div className="mt-2 flex items-center justify-center gap-3 text-xs text-slate-500">
                    <span className="font-mono">{formatBytes(fileData.size_bytes)}</span>
                    <span>·</span>
                    <span>{fileData.mime_type}</span>
                  </div>
                </div>
              </div>

              {/* Security badge */}
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/20 px-4 py-3 flex items-start gap-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                <p className="text-xs text-emerald-300 leading-relaxed">
                  This file is served securely via an encrypted link. Your download is private and direct.
                </p>
              </div>

              {/* Download button */}
              <button
                onClick={handleDownload}
                disabled={isDownloading}
                className="w-full flex items-center justify-center gap-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 py-3 text-sm font-bold text-white hover:from-indigo-500 hover:to-purple-500 transition disabled:opacity-60 shadow-lg shadow-indigo-900/40"
              >
                {isDownloading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {isDownloading ? 'Starting download…' : 'Download File'}
              </button>

              <p className="text-center text-[11px] text-slate-600">
                Shared via{' '}
                <a href="/" className="text-indigo-400 hover:underline inline-flex items-center gap-0.5">
                  MultiDrive <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

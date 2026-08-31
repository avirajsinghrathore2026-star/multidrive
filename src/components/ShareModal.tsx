'use client';

import React, { useState } from 'react';
import { X, Share2, Copy, Check, Lock, Clock, Link as LinkIcon } from 'lucide-react';
import { FileRecord } from './FileBrowser';

interface ShareModalProps {
  file: FileRecord | null;
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({ file, onClose }) => {
  const [durationHours, setDurationHours] = useState(24);
  const [password, setPassword] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!file) return null;

  const handleGenerateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsGenerating(true);
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: file.id,
          durationHours: Number(durationHours),
          password: password.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setGeneratedUrl(json.publicUrl);
      }
    } catch (err) {
      console.error('Failed to generate share link:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyLink = () => {
    if (generatedUrl) {
      navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-5 relative">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
              <Share2 className="h-4 w-4" />
            </div>
            <h3 className="text-base font-bold text-white">Create Expiring Share Link</h3>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-xs text-slate-400">
          Target File: <span className="text-slate-200 font-semibold">{file.filename}</span>
        </p>

        {generatedUrl ? (
          <div className="space-y-4 pt-2">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-3 space-y-2">
              <p className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
                <Check className="h-4 w-4 text-emerald-400" /> Share Link Ready
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={generatedUrl}
                  className="h-8 flex-1 rounded-md border border-slate-800 bg-slate-950 px-2.5 text-xs text-slate-300 font-mono focus:outline-none"
                />
                <button
                  onClick={handleCopyLink}
                  className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>

            <button
              onClick={() => setGeneratedUrl(null)}
              className="w-full rounded-xl border border-slate-800 py-2 text-xs font-semibold text-slate-400 hover:bg-slate-800"
            >
              Generate Another Link
            </button>
          </div>
        ) : (
          <form onSubmit={handleGenerateLink} className="space-y-4">
            {/* Expiration Timer Selector */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1 flex items-center gap-1">
                <Clock className="h-3.5 w-3.5 text-indigo-400" /> Expiration Timer
              </label>
              <select
                value={durationHours}
                onChange={(e) => setDurationHours(Number(e.target.value))}
                className="w-full h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value={1}>1 Hour</option>
                <option value={24}>24 Hours (1 Day)</option>
                <option value={168}>7 Days</option>
                <option value={720}>30 Days</option>
              </select>
            </div>

            {/* Optional Password */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1 flex items-center gap-1">
                <Lock className="h-3.5 w-3.5 text-amber-400" /> Optional Password Protection
              </label>
              <input
                type="password"
                placeholder="Leave blank for no password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-xs text-white placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-800 px-4 py-2 text-xs font-semibold text-slate-400 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isGenerating}
                className="rounded-xl bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {isGenerating ? 'Generating...' : 'Generate Public Link'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

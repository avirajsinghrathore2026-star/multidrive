'use client';

import React, { useEffect, useState } from 'react';
import { Trash2, RotateCcw, AlertTriangle, HardDrive, RefreshCw } from 'lucide-react';
import { formatBytes } from './StorageDashboard';
import { FileRecord } from './FileBrowser';

export const RecyclingBin: React.FC<{ onRefreshDashboard: () => void }> = ({ onRefreshDashboard }) => {
  const [trashedFiles, setTrashedFiles] = useState<FileRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTrash = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/files?folderId=all');
      if (res.ok) {
        const json = await res.json();
        // Filter in_trash === true
        const inTrash = (json.files || []).filter((f: FileRecord & { in_trash?: boolean }) => f.in_trash);
        setTrashedFiles(inTrash);
      }
    } catch (err) {
      console.error('Failed to load trash:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTrash();
  }, []);

  const handleRestore = async (fileId: string) => {
    try {
      const res = await fetch('/api/files/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_restore', fileIds: [fileId] }),
      });
      if (res.ok) {
        await fetchTrash();
        onRefreshDashboard();
      }
    } catch (err) {
      console.error('Restore error:', err);
    }
  };

  const handleEmptyTrash = async () => {
    if (trashedFiles.length === 0) return;
    if (!confirm(`Permanently delete all ${trashedFiles.length} items from Google Drive? This action cannot be undone.`)) return;

    const fileIds = trashedFiles.map((f) => f.id);
    try {
      const res = await fetch('/api/files/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_permanent_delete', fileIds }),
      });
      if (res.ok) {
        await fetchTrash();
        onRefreshDashboard();
      }
    } catch (err) {
      console.error('Empty trash error:', err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-rose-400">
            <Trash2 className="h-4 w-4" /> Recycling Bin
          </div>
          <h3 className="text-xl font-extrabold text-white mt-1">
            {trashedFiles.length} item{trashedFiles.length === 1 ? '' : 's'} in Trash
          </h3>
          <p className="text-xs text-slate-400 mt-1">Items in trash remain stored in Google Drive until permanently deleted.</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchTrash}
            disabled={isLoading}
            className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700 transition"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            onClick={handleEmptyTrash}
            disabled={trashedFiles.length === 0}
            className="flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 transition disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            <span>Empty Trash</span>
          </button>
        </div>
      </div>

      {/* Trashed Items List */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-xl overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-950/60 text-slate-400 border-b border-slate-800">
            <tr>
              <th className="py-3 px-4 font-semibold">Filename</th>
              <th className="py-3 px-4 font-semibold">Account</th>
              <th className="py-3 px-4 font-semibold">Size</th>
              <th className="py-3 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {trashedFiles.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-12 text-center text-slate-500">
                  Recycling bin is empty.
                </td>
              </tr>
            ) : (
              trashedFiles.map((file) => (
                <tr key={file.id} className="hover:bg-slate-800/40 transition">
                  <td className="py-3 px-4 font-medium text-slate-200 truncate max-w-xs">{file.filename}</td>
                  <td className="py-3 px-4 text-slate-400">{file.connected_accounts?.google_email || 'Drive Account'}</td>
                  <td className="py-3 px-4 font-mono text-slate-400">{formatBytes(file.size_bytes)}</td>
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={() => handleRestore(file.id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-950/40 px-2.5 py-1 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/60 transition"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>Restore</span>
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

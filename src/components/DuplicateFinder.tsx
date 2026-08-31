'use client';

import React, { useEffect, useState } from 'react';
import { Copy, Trash2, CheckCircle2, RefreshCw, AlertCircle, HardDrive } from 'lucide-react';
import { formatBytes } from './StorageDashboard';
import { FileRecord } from './FileBrowser';

interface DuplicateGroup {
  filename: string;
  sizeBytes: number;
  totalGroupSize: number;
  reclaimableSize: number;
  items: FileRecord[];
}

export const DuplicateFinder: React.FC<{ onRefreshDashboard: () => void }> = ({ onRefreshDashboard }) => {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [totalReclaimable, setTotalReclaimable] = useState(0);
  const [totalDuplicates, setTotalDuplicates] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);

  const scanDuplicates = async () => {
    setIsScanning(true);
    try {
      const res = await fetch('/api/files/duplicates');
      if (res.ok) {
        const json = await res.json();
        setGroups(json.groups || []);
        setTotalReclaimable(json.totalReclaimableBytes || 0);
        setTotalDuplicates(json.totalDuplicateFiles || 0);
      }
    } catch (err) {
      console.error('Failed to scan duplicates:', err);
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    scanDuplicates();
  }, []);

  const handleCleanDuplicateGroup = async (group: DuplicateGroup) => {
    // Keep newest item (index 0), delete older duplicate copies
    const duplicateIds = group.items.slice(1).map((i) => i.id);
    setIsCleaning(true);
    try {
      const res = await fetch('/api/files/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_delete', fileIds: duplicateIds }),
      });

      if (res.ok) {
        await scanDuplicates();
        onRefreshDashboard();
      }
    } catch (err) {
      console.error('Failed to clean duplicates:', err);
    } finally {
      setIsCleaning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
            <Copy className="h-4 w-4" /> Duplicate File Scanner
          </div>
          <h3 className="text-xl font-extrabold text-white mt-1">
            {totalDuplicates > 0 ? (
              <>Found <span className="text-amber-400">{totalDuplicates} duplicate copies</span> ({formatBytes(totalReclaimable)} reclaimable)</>
            ) : (
              'No duplicate files detected across your connected accounts'
            )}
          </h3>
          <p className="text-xs text-slate-400 mt-1">Scans files matching identical filenames and sizes across all connected accounts.</p>
        </div>

        <button
          onClick={scanDuplicates}
          disabled={isScanning}
          className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-indigo-500 transition disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
          <span>Rescan Duplicates</span>
        </button>
      </div>

      {/* Duplicate Groups List */}
      {groups.length === 0 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-12 text-center text-slate-400 text-xs">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400 mb-2" />
          <p className="font-semibold text-slate-200">Your storage is clean!</p>
          <p className="text-slate-500 mt-1">No redundant duplicate files were found across your Google Drive accounts.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group, idx) => (
            <div key={idx} className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <div>
                  <h4 className="text-sm font-bold text-white">{group.filename}</h4>
                  <p className="text-xs text-slate-400">
                    Size: <span className="font-mono text-slate-200">{formatBytes(group.sizeBytes)}</span> | Copies: <span className="text-amber-400 font-bold">{group.items.length}</span>
                  </p>
                </div>

                <button
                  onClick={() => handleCleanDuplicateGroup(group)}
                  disabled={isCleaning}
                  className="flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-950/40 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-900/60 transition disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Clean {group.items.length - 1} Duplicate(s)</span>
                </button>
              </div>

              {/* Items Table */}
              <div className="space-y-2">
                {group.items.map((item, itemIdx) => (
                  <div key={item.id} className="flex items-center justify-between rounded-lg bg-slate-950/60 p-3 text-xs">
                    <div className="flex items-center gap-3">
                      {itemIdx === 0 ? (
                        <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                          NEWEST (Keep)
                        </span>
                      ) : (
                        <span className="rounded-full bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-[10px] font-bold text-rose-400">
                          DUPLICATE
                        </span>
                      )}
                      <span className="text-slate-300">{item.connected_accounts?.google_email || 'Account'}</span>
                    </div>

                    <span className="text-slate-500 text-[11px]">
                      Uploaded: {new Date(item.uploaded_at).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

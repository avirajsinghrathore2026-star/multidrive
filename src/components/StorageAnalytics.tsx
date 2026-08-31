'use client';

import React, { useEffect, useState } from 'react';
import { BarChart3, FileText, Image as ImageIcon, Film, Music, Archive, File, Download, Eye, HardDrive } from 'lucide-react';
import { formatBytes } from './StorageDashboard';
import { FileRecord } from './FileBrowser';

interface AnalyticsData {
  categories: Record<string, { count: number; bytes: number }>;
  totalFiles: number;
  totalStorageBytes: number;
  topFiles: FileRecord[];
}

export const StorageAnalytics: React.FC<{ onPreview: (f: FileRecord) => void }> = ({ onPreview }) => {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAnalytics = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/files/analytics');
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (err) {
      console.error('Failed to load analytics:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, []);

  if (isLoading) {
    return <div className="p-12 text-center text-xs text-slate-500">Loading storage analytics...</div>;
  }

  if (!data) return null;

  const getCategoryIcon = (cat: string) => {
    switch (cat) {
      case 'Images':
        return <ImageIcon className="h-5 w-5 text-emerald-400" />;
      case 'Videos':
        return <Film className="h-5 w-5 text-purple-400" />;
      case 'Audio':
        return <Music className="h-5 w-5 text-amber-400" />;
      case 'Documents':
        return <FileText className="h-5 w-5 text-rose-400" />;
      case 'Archives':
        return <Archive className="h-5 w-5 text-cyan-400" />;
      default:
        return <File className="h-5 w-5 text-indigo-400" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-xl">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-400">Total Storage Used</p>
          <h3 className="text-2xl font-extrabold text-white mt-1">{formatBytes(data.totalStorageBytes)}</h3>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-xl">
          <p className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Total Managed Files</p>
          <h3 className="text-2xl font-extrabold text-white mt-1">{data.totalFiles}</h3>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 backdrop-blur-xl">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">Categories</p>
          <h3 className="text-2xl font-extrabold text-white mt-1">{Object.keys(data.categories).length}</h3>
        </div>
      </div>

      {/* Category Distribution Grid */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-xl space-y-4">
        <h4 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-indigo-400" /> Storage Breakdown by File Type
        </h4>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Object.entries(data.categories).map(([catName, stats]) => {
            const percentage = data.totalStorageBytes > 0 ? Math.round((stats.bytes / data.totalStorageBytes) * 100) : 0;

            return (
              <div key={catName} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    {getCategoryIcon(catName)}
                    <span className="text-sm font-bold text-white">{catName}</span>
                  </div>
                  <span className="text-xs font-mono text-slate-400">{stats.count} files</span>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-slate-400 font-medium">
                    <span>{formatBytes(stats.bytes)}</span>
                    <span className="text-slate-200">{percentage}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 transition-all duration-500"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top 10 Largest Files */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-xl space-y-4">
        <h4 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-amber-400" /> Top 10 Largest Files
        </h4>

        <div className="overflow-x-auto">
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
              {data.topFiles.map((file) => (
                <tr key={file.id} className="hover:bg-slate-800/40 transition">
                  <td className="py-3 px-4 font-semibold text-slate-200 truncate max-w-xs">{file.filename}</td>
                  <td className="py-3 px-4 text-slate-400">{file.connected_accounts?.google_email || 'Drive Account'}</td>
                  <td className="py-3 px-4 font-mono text-indigo-400 font-semibold">{formatBytes(file.size_bytes)}</td>
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={() => onPreview(file)}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                      title="Preview"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

'use client';

import React from 'react';
import { HardDrive, Cloud, AlertCircle, RefreshCw, Plus, CheckCircle2 } from 'lucide-react';

export interface AccountData {
  id: string;
  google_email: string;
  storage_used_bytes: number;
  storage_total_bytes: number;
  quota_last_checked_at: string;
}

interface StorageDashboardProps {
  accounts: AccountData[];
  onRefresh: () => void;
  isRefreshing: boolean;
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export const StorageDashboard: React.FC<StorageDashboardProps> = ({
  accounts,
  onRefresh,
  isRefreshing,
}) => {
  // Compute totals
  const totalUsed = accounts.reduce((acc, curr) => acc + Number(curr.storage_used_bytes || 0), 0);
  const totalCapacity = accounts.reduce((acc, curr) => acc + Number(curr.storage_total_bytes || 0), 0);
  const overallPercentage = totalCapacity > 0 ? Math.min(100, Math.round((totalUsed / totalCapacity) * 100)) : 0;

  // Sort fullest first
  const sortedAccounts = [...accounts].sort((a, b) => {
    const ratioA = a.storage_total_bytes > 0 ? a.storage_used_bytes / a.storage_total_bytes : 0;
    const ratioB = b.storage_total_bytes > 0 ? b.storage_used_bytes / b.storage_total_bytes : 0;
    return ratioB - ratioA;
  });

  return (
    <div className="space-y-6">
      {/* Total Combined Storage Card */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-xl shadow-xl">
        <div className="absolute top-0 right-0 -mt-8 -mr-8 h-48 w-48 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />
        
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-indigo-400">
              <Cloud className="h-4 w-4" /> Unified Storage Overview
            </div>
            <h2 className="mt-1 text-3xl font-extrabold text-white">
              {formatBytes(totalUsed)} <span className="text-xl text-slate-400 font-medium">/ {formatBytes(totalCapacity)} used</span>
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Combined capacity across <span className="font-semibold text-slate-200">{accounts.length} connected</span> Google account{accounts.length === 1 ? '' : 's'}
            </p>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={onRefresh}
              disabled={isRefreshing}
              className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 hover:text-white transition disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin text-indigo-400' : ''}`} />
              <span>Refresh All Quotas</span>
            </button>

            <a
              href="/api/auth/google/connect"
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-indigo-500 transition shadow-lg shadow-indigo-500/25"
            >
              <Plus className="h-4 w-4" />
              <span>Connect Account</span>
            </a>
          </div>
        </div>

        {/* Combined Progress Bar */}
        <div className="mt-5 space-y-1.5">
          <div className="flex justify-between text-xs text-slate-400 font-medium">
            <span>Overall Usage</span>
            <span className="text-slate-200 font-bold">{overallPercentage}%</span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-slate-800 p-0.5">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                overallPercentage > 90
                  ? 'bg-rose-500 shadow-rose-500/50'
                  : overallPercentage > 70
                  ? 'bg-amber-500 shadow-amber-500/50'
                  : 'bg-emerald-500 shadow-emerald-500/50'
              }`}
              style={{ width: `${overallPercentage}%` }}
            />
          </div>
        </div>
      </div>

      {/* Individual Account Cards */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-indigo-400" /> Connected Accounts ({sortedAccounts.length})
          </h3>
          <span className="text-xs text-slate-500">Sorted fullest first</span>
        </div>

        {sortedAccounts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 p-8 text-center">
            <AlertCircle className="mx-auto h-10 w-10 text-slate-600 mb-3" />
            <h4 className="text-base font-medium text-slate-300">No Google Accounts Connected</h4>
            <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
              Connect your Google accounts to automatically route file uploads to accounts with the most free space.
            </p>
            <a
              href="/api/auth/google/connect"
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition"
            >
              <Plus className="h-4 w-4" /> Connect First Account
            </a>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedAccounts.map((acc) => {
              const used = Number(acc.storage_used_bytes || 0);
              const total = Number(acc.storage_total_bytes || 16106127360);
              const percentage = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
              const freeSpace = Math.max(0, total - used);

              // Progress Bar Color Logic
              let progressColor = 'bg-emerald-500';
              let badgeColor = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';

              if (percentage > 90) {
                progressColor = 'bg-rose-500';
                badgeColor = 'text-rose-400 bg-rose-500/10 border-rose-500/20';
              } else if (percentage > 70) {
                progressColor = 'bg-amber-500';
                badgeColor = 'text-amber-400 bg-amber-500/10 border-amber-500/20';
              }

              return (
                <div
                  key={acc.id}
                  className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 transition-all hover:border-slate-700 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="truncate">
                      <p className="text-sm font-semibold text-white truncate" title={acc.google_email}>
                        {acc.google_email}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Free space: <span className="text-slate-200 font-medium">{formatBytes(freeSpace)}</span>
                      </p>
                    </div>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-bold ${badgeColor}`}>
                      {percentage}%
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="mt-4 space-y-1">
                    <div className="h-2.5 w-full rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${progressColor}`}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] text-slate-500 pt-0.5">
                      <span>{formatBytes(used)} used</span>
                      <span>{formatBytes(total)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

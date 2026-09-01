'use client';

import React from 'react';
import { HardDrive, Plus, RefreshCw, Layers, ShieldCheck, LogIn, LogOut, User } from 'lucide-react';

interface NavbarProps {
  connectedCount: number;
  totalStorageFormatted: string;
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenUpload: () => void;
  userEmail: string | null;
  onOpenAuth: () => void;
  onSignOut: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  connectedCount,
  totalStorageFormatted,
  onRefresh,
  isRefreshing,
  onOpenUpload,
  userEmail,
  onOpenAuth,
  onSignOut,
}) => {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        {/* Brand Logo */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 via-blue-500 to-cyan-400 shadow-lg shadow-indigo-500/20">
            <HardDrive className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white">MultiDrive</h1>
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-400 border border-indigo-500/20">
                <ShieldCheck className="h-3 w-3" /> Supabase Vault
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">Unified Multi-Account Google Drive Storage</p>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex items-center gap-3">
          {/* User Session / Auth Trigger */}
          {userEmail ? (
            <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300">
              <User className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
              <span className="max-w-[120px] truncate hidden md:inline">{userEmail}</span>
              <button
                onClick={onSignOut}
                className="ml-1 text-slate-400 hover:text-rose-400 transition"
                title="Sign Out"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={onOpenAuth}
              className="flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-950/40 px-3 py-2 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/60 hover:text-white transition shadow-sm"
            >
              <LogIn className="h-3.5 w-3.5 text-indigo-400" />
              <span>Sign In / Register</span>
            </button>
          )}

          {/* Refresh Quotas */}
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white transition disabled:opacity-50"
            title="Refresh Account Storage Quotas"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin text-indigo-400' : ''}`} />
            <span className="hidden sm:inline">Refresh Quotas</span>
          </button>

          {/* Connect Account Button */}
          <a
            href={userEmail ? '/api/auth/google/connect' : '#'}
            onClick={(e) => {
              if (!userEmail) {
                e.preventDefault();
                onOpenAuth();
              }
            }}
            className="flex items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-950/50 px-3 py-2 text-xs font-medium text-indigo-300 hover:bg-indigo-900/60 hover:text-white transition shadow-sm"
          >
            <Plus className="h-4 w-4 text-indigo-400" />
            <span>Connect Account</span>
          </a>

          {/* Upload Button */}
          <button
            onClick={onOpenUpload}
            className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-indigo-500/20 hover:from-blue-500 hover:to-indigo-500 transition"
          >
            <Layers className="h-4 w-4" />
            <span>Upload File</span>
          </button>
        </div>
      </div>
    </header>
  );
};

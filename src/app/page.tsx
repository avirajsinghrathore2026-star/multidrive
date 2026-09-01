import React from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { HardDrive, ShieldCheck, ArrowRight, Layers, Zap, Database, Lock, RefreshCw, CheckCircle2 } from 'lucide-react';

export default async function MarketingLandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white flex flex-col justify-between">
      {/* Background Gradient & Glow Effects */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(99,102,241,0.25),rgba(255,255,255,0))] pointer-events-none" />

      {/* Top Navbar */}
      <header className="relative z-10 border-b border-slate-800/80 backdrop-blur-xl bg-slate-950/60 sticky top-0">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5 text-lg font-black tracking-tight text-white group">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-500/30 group-hover:scale-105 transition">
              <HardDrive className="h-5 w-5" />
            </div>
            <span className="bg-gradient-to-r from-white via-slate-200 to-indigo-300 bg-clip-text text-transparent">
              MultiDrive
            </span>
          </Link>

          <div className="flex items-center gap-4">
            {user ? (
              <Link
                href="/dashboard"
                className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-500/25 transition"
              >
                <span>Go to Dashboard</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : (
              <Link
                href="/login"
                className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-500/25 transition"
              >
                <span>Get Started / Log In</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="relative z-10 mx-auto max-w-7xl px-6 py-20 lg:py-28 text-center space-y-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-950/40 px-3.5 py-1.5 text-xs font-bold text-indigo-300">
          <SparkleIcon />
          <span>Unified Multi-Account Storage Aggregator</span>
        </div>

        <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-6xl max-w-4xl mx-auto leading-tight">
          Pool Unlimited Cloud Storage Into a{' '}
          <span className="bg-gradient-to-r from-indigo-400 via-sky-300 to-purple-400 bg-clip-text text-transparent">
            Single Virtual Drive
          </span>
        </h1>

        <p className="max-w-2xl mx-auto text-base sm:text-lg text-slate-400 font-medium leading-relaxed">
          Connect multiple Google Drive accounts seamlessly. MultiDrive aggregates your available cloud capacity into one unified drive, protected by a fault-tolerant background engine with zero data loss guarantees.
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
          {user ? (
            <Link
              href="/dashboard"
              className="w-full sm:w-auto flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-8 py-3.5 text-sm font-bold text-white shadow-xl shadow-indigo-500/25 transition transform hover:-translate-y-0.5"
            >
              <span>Go to Dashboard</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          ) : (
            <Link
              href="/login"
              className="w-full sm:w-auto flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-8 py-3.5 text-sm font-bold text-white shadow-xl shadow-indigo-500/25 transition transform hover:-translate-y-0.5"
            >
              <span>Get Started Free</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          )}
        </div>

        {/* Core Value Props Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-16 text-left max-w-5xl mx-auto">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-xl space-y-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
              <Layers className="h-5 w-5" />
            </div>
            <h3 className="text-base font-bold text-white">1:1 Storage Paradigm</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Files are mapped 1:1 to single physical objects on optimal Google Drive accounts, eliminating multi-part file chunking or metadata fragmentation.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-xl space-y-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600/20 text-emerald-400 border border-emerald-500/30">
              <RefreshCw className="h-5 w-5" />
            </div>
            <h3 className="text-base font-bold text-white">Resumable Background Jobs</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Uploads, account-to-account migrations, and archive zipping run via durable background job envelopes with exponential backoff and crash recovery.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-xl space-y-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-600/20 text-sky-400 border border-sky-500/30">
              <Lock className="h-5 w-5" />
            </div>
            <h3 className="text-base font-bold text-white">Vault Authenticated Encryption</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Google OAuth tokens and credentials are encrypted using AES-256-GCM authenticated vault encryption primitives with strict database RLS isolation.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-slate-800/80 py-6 text-center text-xs text-slate-500">
        <div className="mx-auto max-w-7xl px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© 2026 MultiDrive. Production-Grade Cloud Storage Aggregator.</p>
          <div className="flex items-center gap-4 text-slate-400">
            <span>Next.js 16 SSR</span>
            <span>•</span>
            <span>Supabase PostgreSQL</span>
            <span>•</span>
            <span>Google OAuth PKCE</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg className="h-3.5 w-3.5 text-indigo-400" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z" />
    </svg>
  );
}

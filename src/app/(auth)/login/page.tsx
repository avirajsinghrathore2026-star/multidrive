'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { HardDrive, Mail, Lock, ArrowRight, CheckCircle2, AlertCircle, Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';

function AuthPortalContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const nextPath = searchParams.get('next') || '/dashboard';
  const errorParam = searchParams.get('error');

  const [activeMode, setActiveMode] = useState<'password' | 'magic-link'>('password');
  const [isSignUp, setIsSignUp] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    if (errorParam) {
      setMessage({
        text: decodeURIComponent(errorParam),
        type: 'error',
      });
    }
  }, [errorParam]);

  // Google OAuth PKCE Sign In Handler
  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    setMessage(null);
    try {
      const supabase = createClient();
      const origin = window.location.origin;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${origin}/api/auth/callback?next=${encodeURIComponent(nextPath)}`,
        },
      });

      if (error) throw error;
    } catch (err: any) {
      console.error('Google Sign In Error:', err);
      let errorMsg = err.message || 'Failed to initiate Google OAuth';
      if (errorMsg.includes('provider is not enabled') || errorMsg.includes('Unsupported provider') || err.error_code === 'validation_failed') {
        errorMsg = 'Google OAuth Login is not enabled in your Supabase project dashboard. Please log in using Email & Password or Magic Link below (or enable Google under Authentication -> Providers in Supabase).';
      }
      setMessage({ text: errorMsg, type: 'error' });
      setIsGoogleLoading(false);
    }
  };

  // Password Login / Registration Handler
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setMessage({ text: 'Please fill in all fields', type: 'error' });
      return;
    }

    setIsLoading(true);
    setMessage(null);

    try {
      const supabase = createClient();
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(nextPath)}`,
          },
        });
        if (error) throw error;
        setMessage({
          text: 'Registration successful! Check your email to confirm your account.',
          type: 'success',
        });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(nextPath);
      }
    } catch (err: any) {
      console.error('Auth Error:', err);
      setMessage({ text: err.message || 'Authentication failed', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  // Magic Link OTP Handler
  const handleMagicLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setMessage({ text: 'Please enter your email address', type: 'error' });
      return;
    }

    setIsLoading(true);
    setMessage(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(nextPath)}`,
        },
      });

      if (error) throw error;
      setMessage({
        text: 'Magic link dispatched! Check your email inbox to log in.',
        type: 'success',
      });
    } catch (err: any) {
      console.error('Magic Link Error:', err);
      setMessage({ text: err.message || 'Failed to send magic link', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center py-12 sm:px-6 lg:px-8 selection:bg-indigo-500 selection:text-white">
      {/* Background Gradient Mesh */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(99,102,241,0.25),rgba(255,255,255,0))] pointer-events-none" />

      {/* Header Branding */}
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center z-10 space-y-3">
        <Link href="/" className="inline-flex items-center gap-2 text-xl font-black tracking-tight text-white group">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-500/30 group-hover:scale-105 transition">
            <HardDrive className="h-5 w-5" />
          </div>
          <span className="bg-gradient-to-r from-white via-slate-200 to-indigo-300 bg-clip-text text-transparent">
            MultiDrive
          </span>
        </Link>
        <h2 className="text-2xl font-bold tracking-tight text-white">
          {isSignUp ? 'Create your MultiDrive account' : 'Sign in to your account'}
        </h2>
        <p className="text-xs text-slate-400">Unified Multi-Account Storage Aggregator</p>
      </div>

      {/* Auth Card Container */}
      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md z-10 px-4 sm:px-0">
        <div className="bg-slate-900/80 border border-slate-800 backdrop-blur-xl py-8 px-6 shadow-2xl rounded-2xl sm:px-10 space-y-6">
          {/* Notification Message */}
          {message && (
            <div
              className={`flex items-start gap-3 rounded-xl p-3.5 border text-xs font-semibold ${
                message.type === 'success'
                  ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-950/40 border-rose-500/30 text-rose-300'
              }`}
            >
              {message.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
              )}
              <span>{message.text}</span>
            </div>
          )}

          {/* Primary Action: Sign In With Google OAuth */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading || isLoading}
            className="w-full flex items-center justify-center gap-3 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-800 px-4 py-3 text-xs font-bold text-white shadow-md transition disabled:opacity-50"
          >
            {isGoogleLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.28v3.15C3.25 21.3 7.31 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.28C.46 8.21 0 10.05 0 12s.46 3.79 1.28 5.42l4-3.15z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.25 2.7 1.28 6.58l4 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                />
              </svg>
            )}
            <span>Continue with Google</span>
          </button>

          {/* Divider */}
          <div className="relative flex items-center justify-center">
            <div className="w-full border-t border-slate-800" />
            <span className="bg-slate-900 px-3 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
              Or with email
            </span>
          </div>

          {/* Secondary Auth Method Tabs */}
          <div className="grid grid-cols-2 rounded-xl bg-slate-950/60 p-1 border border-slate-800">
            <button
              type="button"
              onClick={() => setActiveMode('password')}
              className={`rounded-lg py-1.5 text-xs font-bold transition ${
                activeMode === 'password' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              Password
            </button>
            <button
              type="button"
              onClick={() => setActiveMode('magic-link')}
              className={`rounded-lg py-1.5 text-xs font-bold transition ${
                activeMode === 'magic-link' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'
              }`}
            >
              Magic Link
            </button>
          </div>

          {/* Password Auth Form */}
          {activeMode === 'password' && (
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div>
                <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="user@example.com"
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/60 pl-9 pr-4 py-2.5 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/60 pl-9 pr-4 py-2.5 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading || isGoogleLoading}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-3 text-xs font-bold text-white shadow-lg shadow-indigo-500/25 transition disabled:opacity-50"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <span>{isSignUp ? 'Create Account' : 'Sign In'}</span>
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>

              <div className="text-center pt-2">
                <button
                  type="button"
                  onClick={() => setIsSignUp(!isSignUp)}
                  className="text-xs text-slate-400 hover:text-indigo-300 transition"
                >
                  {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
                </button>
              </div>
            </form>
          )}

          {/* Magic Link Form */}
          {activeMode === 'magic-link' && (
            <form onSubmit={handleMagicLinkSubmit} className="space-y-4">
              <div>
                <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="user@example.com"
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/60 pl-9 pr-4 py-2.5 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading || isGoogleLoading}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-3 text-xs font-bold text-white shadow-lg shadow-indigo-500/25 transition disabled:opacity-50"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    <span>Send Magic Link</span>
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AuthPortalPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950 text-slate-400 p-8 text-center text-xs">Loading Auth Portal...</div>}>
      <AuthPortalContent />
    </Suspense>
  );
}

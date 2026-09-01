'use client';

import React, { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Navbar } from '@/components/Navbar';
import { StorageDashboard, AccountData } from '@/components/StorageDashboard';
import { FileBrowser, FileRecord, VirtualFolder } from '@/components/FileBrowser';
import { UploadModal } from '@/components/UploadModal';
import { FilePreviewModal } from '@/components/FilePreviewModal';
import { StorageAnalytics } from '@/components/StorageAnalytics';
import { DuplicateFinder } from '@/components/DuplicateFinder';
import { RecyclingBin } from '@/components/RecyclingBin';
import { ShareModal } from '@/components/ShareModal';
import { AuthModal } from '@/components/AuthModal';
import { createClient } from '@/lib/supabase/client';
import { CheckCircle2, AlertCircle, HardDrive, BarChart3, Copy, Trash2, ArrowLeftRight } from 'lucide-react';

type TabType = 'overview' | 'analytics' | 'duplicates' | 'trash';

function DashboardContent() {
  const searchParams = useSearchParams();

  // Navigation Tab State
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  // User Auth State
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isAuthOpen, setIsAuthOpen] = useState(false);

  // Core State
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [folders, setFolders] = useState<VirtualFolder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRebalancing, setIsRebalancing] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null);
  const [shareFile, setShareFile] = useState<FileRecord | null>(null);

  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Check Current User Auth Session
  const checkUserSession = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        setUserEmail(data.user.email || null);
      } else {
        setUserEmail(null);
      }
    } catch (err) {
      console.error('Failed to check user session:', err);
    }
  }, []);

  useEffect(() => {
    checkUserSession();
  }, [checkUserSession]);

  // OAuth callback & unauthenticated error toast handler
  useEffect(() => {
    const connected = searchParams.get('connected');
    const email = searchParams.get('email');
    const error = searchParams.get('error');

    if (connected === 'true' && email) {
      setToastMessage({
        text: `Successfully connected Google Account: ${decodeURIComponent(email)}`,
        type: 'success',
      });
    } else if (error) {
      let errorText = `OAuth Error (${error})`;
      if (error === 'unauthenticated') {
        errorText = 'Authentication Required: Please sign up or log in first before connecting a Google Drive account.';
        setIsAuthOpen(true); // Auto-open Auth modal when unauthenticated
      } else if (error === 'oauth_cancelled') {
        errorText = 'Google Authorization was cancelled.';
      } else if (error === 'oauth_no_refresh_token') {
        errorText = 'Google did not return a refresh token. Go to your Google Account security settings, revoke access for MultiDrive, and try connecting again.';
      } else if (error === 'oauth_state_mismatch') {
        errorText = 'OAuth state mismatch. Please refresh the page and try connecting again.';
      }

      setToastMessage({
        text: errorText,
        type: 'error',
      });
    }
  }, [searchParams]);

  // Load Accounts
  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/accounts');
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.accounts || []);
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    }
  }, []);

  // Load Files
  const fetchFiles = useCallback(async (folderId: string | null) => {
    try {
      const url = folderId ? `/api/files?folderId=${folderId}` : '/api/files?folderId=all';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files || []);
      }
    } catch (err) {
      console.error('Failed to fetch files:', err);
    }
  }, []);

  // Load Folders
  const fetchFolders = useCallback(async () => {
    try {
      const res = await fetch('/api/folders?parentId=root');
      if (res.ok) {
        const data = await res.json();
        setFolders(data.folders || []);
      }
    } catch (err) {
      console.error('Failed to fetch folders:', err);
    }
  }, []);

  const refreshAllData = useCallback(() => {
    fetchAccounts();
    fetchFiles(currentFolderId);
    fetchFolders();
  }, [fetchAccounts, fetchFiles, fetchFolders, currentFolderId]);

  useEffect(() => {
    setIsLoading(true);
    Promise.all([fetchAccounts(), fetchFiles(currentFolderId), fetchFolders()]).finally(() => {
      setIsLoading(false);
    });
  }, [fetchAccounts, fetchFiles, fetchFolders, currentFolderId]);

  // Sign Out Handler
  const handleSignOut = async () => {
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
      setUserEmail(null);
      setAccounts([]);
      setFiles([]);
      setFolders([]);
      setToastMessage({ text: 'Signed out successfully', type: 'success' });
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  // Quota Refresh Handler
  const handleRefreshQuotas = async () => {
    setIsRefreshing(true);
    try {
      const res = await fetch('/api/accounts', { method: 'POST', body: JSON.stringify({}) });
      if (res.ok) {
        await fetchAccounts();
        setToastMessage({ text: 'Storage quotas refreshed successfully', type: 'success' });
      }
    } catch (err) {
      console.error('Quota refresh error:', err);
    } finally {
      setIsRefreshing(false);
    }
  };

  // One-Click Storage Rebalancing Handler
  const handleRebalanceStorage = async () => {
    setIsRebalancing(true);
    try {
      const res = await fetch('/api/files/rebalance', { method: 'POST' });
      const json = await res.json();
      if (res.ok) {
        refreshAllData();
        setToastMessage({ text: json.message || 'Storage rebalancing completed', type: 'success' });
      } else {
        setToastMessage({ text: json.error || 'Rebalance failed', type: 'error' });
      }
    } catch (err) {
      console.error('Rebalance error:', err);
    } finally {
      setIsRebalancing(false);
    }
  };

  // Create Virtual Folder
  const handleCreateFolder = async (name: string) => {
    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentFolderId: currentFolderId }),
      });
      if (res.ok) {
        await fetchFolders();
        setToastMessage({ text: `Created virtual folder "${name}"`, type: 'success' });
      }
    } catch (err) {
      console.error('Create folder error:', err);
    }
  };

  // Move file to Trash (Soft Delete)
  const handleDeleteFile = async (fileId: string) => {
    try {
      const res = await fetch('/api/files/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_delete', fileIds: [fileId] }),
      });
      if (res.ok) {
        refreshAllData();
        setToastMessage({ text: 'File moved to Recycling Bin', type: 'success' });
      }
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  // Rename File
  const handleRenameFile = async (fileId: string, currentName: string) => {
    try {
      const res = await fetch(`/api/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: currentName }),
      });
      if (res.ok) {
        fetchFiles(currentFolderId);
        setToastMessage({ text: 'File renamed successfully', type: 'success' });
      }
    } catch (err) {
      console.error('Rename error:', err);
    }
  };

  // Download File Handler
  const handleDownloadFile = (file: FileRecord) => {
    const downloadUrl = `/api/files/${file.id}/download`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const totalStorageFormatted = accounts.length > 0 ? `${accounts.length} Connected` : '0 Connected';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Top Navbar */}
      <Navbar
        connectedCount={accounts.length}
        totalStorageFormatted={totalStorageFormatted}
        onRefresh={handleRefreshQuotas}
        isRefreshing={isRefreshing}
        onOpenUpload={() => setIsUploadOpen(true)}
        userEmail={userEmail}
        onOpenAuth={() => setIsAuthOpen(true)}
        onSignOut={handleSignOut}
      />

      {/* Main Container */}
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-8">
        {/* Toast Notification */}
        {toastMessage && (
          <div
            className={`flex items-center justify-between rounded-xl p-4 border shadow-lg backdrop-blur-md transition ${
              toastMessage.type === 'success'
                ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-200'
                : 'bg-rose-950/40 border-rose-500/30 text-rose-200'
            }`}
          >
            <div className="flex items-center gap-3 text-xs font-semibold">
              {toastMessage.type === 'success' ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              ) : (
                <AlertCircle className="h-5 w-5 text-rose-400" />
              )}
              <span>{toastMessage.text}</span>
            </div>
            <button onClick={() => setToastMessage(null)} className="text-xs text-slate-400 hover:text-white">
              Dismiss
            </button>
          </div>
        )}

        {/* Dashboard Navigation Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveTab('overview')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
                activeTab === 'overview'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                  : 'bg-slate-900/60 text-slate-400 border border-slate-800 hover:text-white'
              }`}
            >
              <HardDrive className="h-4 w-4" />
              <span>Overview & Files</span>
            </button>

            <button
              onClick={() => setActiveTab('analytics')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
                activeTab === 'analytics'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                  : 'bg-slate-900/60 text-slate-400 border border-slate-800 hover:text-white'
              }`}
            >
              <BarChart3 className="h-4 w-4" />
              <span>Analytics & Breakdown</span>
            </button>

            <button
              onClick={() => setActiveTab('duplicates')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
                activeTab === 'duplicates'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                  : 'bg-slate-900/60 text-slate-400 border border-slate-800 hover:text-white'
              }`}
            >
              <Copy className="h-4 w-4" />
              <span>Duplicate Finder</span>
            </button>

            <button
              onClick={() => setActiveTab('trash')}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
                activeTab === 'trash'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20'
                  : 'bg-slate-900/60 text-slate-400 border border-slate-800 hover:text-white'
              }`}
            >
              <Trash2 className="h-4 w-4" />
              <span>Recycling Bin</span>
            </button>
          </div>

          {/* Quick Action: Rebalance Storage */}
          {accounts.length > 1 && (
            <button
              onClick={handleRebalanceStorage}
              disabled={isRebalancing}
              className="flex items-center gap-2 rounded-xl border border-indigo-500/30 bg-indigo-950/40 px-3.5 py-2 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/60 transition disabled:opacity-50"
              title="Migrate files from full accounts to accounts with high free space"
            >
              <ArrowLeftRight className={`h-4 w-4 ${isRebalancing ? 'animate-spin' : ''}`} />
              <span>Rebalance Storage</span>
            </button>
          )}
        </div>

        {/* Tab 1: Overview & Files */}
        {activeTab === 'overview' && (
          <div className="space-y-10">
            <StorageDashboard accounts={accounts} onRefresh={handleRefreshQuotas} isRefreshing={isRefreshing} />

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-white tracking-tight">Unified File Manager</h3>
                <span className="text-xs text-slate-400">{files.filter((f) => !f.in_trash).length} active items</span>
              </div>

              <FileBrowser
                files={files}
                folders={folders}
                currentFolderId={currentFolderId}
                onSelectFolder={(id) => setCurrentFolderId(id)}
                onCreateFolder={handleCreateFolder}
                onDeleteFile={handleDeleteFile}
                onRenameFile={handleRenameFile}
                onPreviewFile={(f) => setPreviewFile(f)}
                onDownloadFile={handleDownloadFile}
                onShareFile={(f) => setShareFile(f)}
                onRefreshDashboard={refreshAllData}
              />
            </div>
          </div>
        )}

        {/* Tab 2: Analytics & Breakdown */}
        {activeTab === 'analytics' && <StorageAnalytics onPreview={(f) => setPreviewFile(f)} />}

        {/* Tab 3: Duplicate Finder */}
        {activeTab === 'duplicates' && <DuplicateFinder onRefreshDashboard={refreshAllData} />}

        {/* Tab 4: Recycling Bin */}
        {activeTab === 'trash' && <RecyclingBin onRefreshDashboard={refreshAllData} />}
      </main>

      {/* Auth Sign In / Sign Up Modal */}
      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
        onAuthSuccess={() => {
          checkUserSession();
          refreshAllData();
        }}
      />

      {/* Upload Modal */}
      <UploadModal
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        accounts={accounts}
        folders={folders}
        currentFolderId={currentFolderId}
        onUploadSuccess={() => {
          refreshAllData();
          setToastMessage({ text: 'File uploaded successfully', type: 'success' });
        }}
      />

      {/* File Preview Lightbox Modal */}
      <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onDownload={handleDownloadFile} />

      {/* Share Link Modal */}
      <ShareModal file={shareFile} onClose={() => setShareFile(null)} />
    </div>
  );
}

export default function MultiDriveDashboard() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-950 text-slate-400 p-8 text-center text-xs">Loading MultiDrive...</div>}>
      <DashboardContent />
    </Suspense>
  );
}

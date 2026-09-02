'use client';

import React, { useState } from 'react';
import { X, UploadCloud, File, HardDrive, CheckCircle2, AlertCircle } from 'lucide-react';
import { AccountData, formatBytes } from './StorageDashboard';
import { VirtualFolder } from './FileBrowser';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: AccountData[];
  folders: VirtualFolder[];
  currentFolderId: string | null;
  onUploadSuccess: () => void;
}

export const UploadModal: React.FC<UploadModalProps> = ({
  isOpen,
  onClose,
  accounts,
  folders,
  currentFolderId,
  onUploadSuccess,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(currentFolderId);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [targetEmail, setTargetEmail] = useState<string | null>(null);

  if (!isOpen) return null;

  // Identify account with most free space for preview
  const bestAccount = [...accounts]
    .map((acc) => ({
      ...acc,
      freeSpace: Number(acc.storage_total_bytes) - Number(acc.storage_used_bytes),
    }))
    .sort((a, b) => b.freeSpace - a.freeSpace)[0];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
      setErrorMessage(null);
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) return;

    setIsUploading(true);
    setUploadProgress(5);
    setErrorMessage(null);

    try {
      if (selectedFile.size <= 4 * 1024 * 1024) {
        // Path A: Standard Server Upload for small files (<= 4 MB)
        setUploadProgress(30);
        const formData = new FormData();
        formData.append('file', selectedFile);
        if (selectedFolderId) {
          formData.append('virtualFolderId', selectedFolderId);
        }

        setUploadProgress(60);
        const res = await fetch('/api/jobs/upload', {
          method: 'POST',
          body: formData,
        });

        const resText = await res.text();
        let json: any = {};
        try {
          json = JSON.parse(resText);
        } catch {
          throw new Error(resText || 'Upload failed');
        }

        if (!res.ok) {
          throw new Error(json.error?.message || json.error || 'Upload failed');
        }

        setUploadProgress(100);
        setTargetEmail(bestAccount?.google_email || null);
      } else {
        // Path B: Chunked Resumable Upload (3.5 MB chunks) for large files (> 4 MB)
        const initRes = await fetch('/api/jobs/upload/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: selectedFile.name,
            sizeBytes: selectedFile.size,
            mimeType: selectedFile.type || 'application/octet-stream',
            virtualFolderId: selectedFolderId || null,
          }),
        });

        const initData = await initRes.json();
        if (!initRes.ok) {
          throw new Error(initData.error?.message || initData.error || 'Failed to initiate upload session');
        }

        const { uploadUrl, fileRecordId, reservationId, targetAccountEmail } = initData.data;
        setTargetEmail(targetAccountEmail);

        const chunkSize = 3.5 * 1024 * 1024; // 3.5 MB per chunk (well under 4.5 MB Vercel limit)
        const totalBytes = selectedFile.size;
        let driveFileId = `gdrive-uploaded-${fileRecordId}`;

        for (let start = 0; start < totalBytes; start += chunkSize) {
          const end = Math.min(start + chunkSize, totalBytes) - 1;
          const chunkBlob = selectedFile.slice(start, end + 1);

          const chunkForm = new FormData();
          chunkForm.append('uploadUrl', uploadUrl);
          chunkForm.append('chunk', chunkBlob, selectedFile.name);
          chunkForm.append('startByte', start.toString());
          chunkForm.append('endByte', end.toString());
          chunkForm.append('totalBytes', totalBytes.toString());

          const chunkRes = await fetch('/api/jobs/upload/chunk', {
            method: 'POST',
            body: chunkForm,
          });

          const chunkData = await chunkRes.json();
          if (!chunkRes.ok) {
            throw new Error(chunkData.error?.message || chunkData.error || 'Chunk upload failed');
          }

          if (chunkData.data?.googleDriveFileId) {
            driveFileId = chunkData.data.googleDriveFileId;
          }

          const percentComplete = Math.round(((end + 1) / totalBytes) * 85) + 10;
          setUploadProgress(percentComplete);
        }

        setUploadProgress(95);

        const completeRes = await fetch('/api/jobs/upload/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileRecordId,
            googleDriveFileId: driveFileId,
            reservationId,
          }),
        });

        if (!completeRes.ok) {
          const compData = await completeRes.json();
          throw new Error(compData.error?.message || compData.error || 'Failed to finalize upload record');
        }

        setUploadProgress(100);
      }

      setTimeout(() => {
        setIsUploading(false);
        setSelectedFile(null);
        setUploadProgress(0);
        onUploadSuccess();
        onClose();
      }, 800);
    } catch (err: any) {
      setIsUploading(false);
      setUploadProgress(0);
      setErrorMessage(err.message || 'An error occurred during upload.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-5 relative">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
              <UploadCloud className="h-5 w-5" />
            </div>
            <h3 className="text-base font-bold text-white">Upload to MultiDrive</h3>
          </div>
          <button
            onClick={onClose}
            disabled={isUploading}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Auto Routing Target Info */}
        {bestAccount ? (
          <div className="rounded-xl border border-indigo-500/20 bg-indigo-950/40 p-3 flex items-center gap-3">
            <HardDrive className="h-5 w-5 text-indigo-400 shrink-0" />
            <div className="text-xs">
              <p className="font-semibold text-indigo-200">Smart Upload Routing</p>
              <p className="text-slate-400">
                Target: <span className="text-white font-medium">{bestAccount.google_email}</span> ({formatBytes(bestAccount.freeSpace)} free space)
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-rose-500/20 bg-rose-950/40 p-3 flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-rose-400 shrink-0" />
            <p className="text-xs text-rose-200">Please connect a Google account before uploading files.</p>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleUploadSubmit} className="space-y-4">
          {/* File Selector */}
          <div className="relative border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-xl p-6 text-center transition cursor-pointer bg-slate-950/40">
            <input
              type="file"
              onChange={handleFileChange}
              disabled={isUploading || !bestAccount}
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            />
            {selectedFile ? (
              <div className="flex items-center justify-center gap-3">
                <File className="h-8 w-8 text-indigo-400" />
                <div className="text-left truncate max-w-xs">
                  <p className="text-xs font-semibold text-white truncate">{selectedFile.name}</p>
                  <p className="text-[11px] text-slate-400">{formatBytes(selectedFile.size)}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <UploadCloud className="mx-auto h-8 w-8 text-slate-500" />
                <p className="text-xs font-medium text-slate-300">Click to select or drag and drop file</p>
                <p className="text-[11px] text-slate-500">Streams directly to target Google Drive</p>
              </div>
            )}
          </div>

          {/* Target Folder Selector */}
          {folders.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">Target Virtual Folder</label>
              <select
                value={selectedFolderId || ''}
                onChange={(e) => setSelectedFolderId(e.target.value || null)}
                className="w-full h-9 rounded-lg border border-slate-800 bg-slate-950 px-3 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Root / Unassigned</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    📁 {f.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Upload Progress Bar */}
          {isUploading && (
            <div className="space-y-1.5 pt-2">
              <div className="flex justify-between text-xs text-slate-400">
                <span>Streaming upload to Google Drive...</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Error Banner */}
          {errorMessage && (
            <p className="text-xs font-medium text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg p-2.5">
              {errorMessage}
            </p>
          )}

          {/* Buttons */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isUploading}
              className="rounded-xl border border-slate-800 px-4 py-2 text-xs font-semibold text-slate-400 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedFile || isUploading || !bestAccount}
              className="rounded-xl bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 shadow-md shadow-indigo-500/20"
            >
              {isUploading ? 'Uploading...' : 'Start Upload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

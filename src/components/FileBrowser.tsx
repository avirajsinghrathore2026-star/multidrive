'use client';

import React, { useState } from 'react';
import {
  Folder,
  FolderPlus,
  File,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  Download,
  Eye,
  Edit2,
  Trash2,
  ChevronRight,
  HardDrive,
  Clock,
  Search,
  Share2,
  CheckSquare,
  Square,
  Layers,
  Archive,
} from 'lucide-react';
import { formatBytes } from './StorageDashboard';

export interface FileRecord {
  id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  connected_account_id: string;
  virtual_folder_id: string | null;
  google_drive_file_id: string;
  uploaded_at: string;
  in_trash?: boolean;
  connected_accounts?: {
    google_email: string;
  };
}

export interface VirtualFolder {
  id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
}

interface FileBrowserProps {
  files: FileRecord[];
  folders: VirtualFolder[];
  currentFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  onCreateFolder: (name: string) => void;
  onDeleteFile: (fileId: string) => void;
  onRenameFile: (fileId: string, currentName: string) => void;
  onPreviewFile: (file: FileRecord) => void;
  onDownloadFile: (file: FileRecord) => void;
  onShareFile: (file: FileRecord) => void;
  onRefreshDashboard: () => void;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <ImageIcon className="h-5 w-5 text-emerald-400" />;
  if (mimeType.startsWith('video/')) return <Film className="h-5 w-5 text-purple-400" />;
  if (mimeType.startsWith('audio/')) return <Music className="h-5 w-5 text-amber-400" />;
  if (mimeType.includes('pdf')) return <FileText className="h-5 w-5 text-rose-400" />;
  return <File className="h-5 w-5 text-indigo-400" />;
}

export const FileBrowser: React.FC<FileBrowserProps> = ({
  files,
  folders,
  currentFolderId,
  onSelectFolder,
  onCreateFolder,
  onDeleteFile,
  onRenameFile,
  onPreviewFile,
  onDownloadFile,
  onShareFile,
  onRefreshDashboard,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);

  // Filter active files (excluding trashed files)
  const activeFiles = files.filter((f) => !f.in_trash);

  // Filter files by search query
  const filteredFiles = activeFiles.filter((f) =>
    f.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const isAllSelected = filteredFiles.length > 0 && selectedFileIds.length === filteredFiles.length;

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedFileIds([]);
    } else {
      setSelectedFileIds(filteredFiles.map((f) => f.id));
    }
  };

  const toggleSelectFile = (fileId: string) => {
    if (selectedFileIds.includes(fileId)) {
      setSelectedFileIds(selectedFileIds.filter((id) => id !== fileId));
    } else {
      setSelectedFileIds([...selectedFileIds, fileId]);
    }
  };

  // Batch Zip Download
  const handleBatchDownloadZip = async () => {
    if (selectedFileIds.length === 0) return;
    setIsBatchProcessing(true);
    try {
      const res = await fetch('/api/files/download-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: selectedFileIds }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'MultiDrive_Archive.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (err) {
      console.error('Batch zip download error:', err);
    } finally {
      setIsBatchProcessing(false);
    }
  };

  // Batch Trash
  const handleBatchTrash = async () => {
    if (selectedFileIds.length === 0) return;
    setIsBatchProcessing(true);
    try {
      const res = await fetch('/api/files/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_delete', fileIds: selectedFileIds }),
      });

      if (res.ok) {
        setSelectedFileIds([]);
        onRefreshDashboard();
      }
    } catch (err) {
      console.error('Batch trash error:', err);
    } finally {
      setIsBatchProcessing(false);
    }
  };

  // Batch Move to Virtual Folder
  const handleBatchMove = async () => {
    if (selectedFileIds.length === 0) return;
    const targetId = prompt('Enter folder ID or leave blank for root:');
    setIsBatchProcessing(true);
    try {
      const res = await fetch('/api/files/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_move', fileIds: selectedFileIds, targetFolderId: targetId || null }),
      });

      if (res.ok) {
        setSelectedFileIds([]);
        onRefreshDashboard();
      }
    } catch (err) {
      console.error('Batch move error:', err);
    } finally {
      setIsBatchProcessing(false);
    }
  };

  const handleCreateFolderSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newFolderName.trim()) {
      onCreateFolder(newFolderName.trim());
      setNewFolderName('');
      setIsCreatingFolder(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-xl shadow-xl overflow-hidden relative">
      {/* Batch Floating Toolbar */}
      {selectedFileIds.length > 0 && (
        <div className="sticky top-0 z-30 flex items-center justify-between bg-indigo-950/90 border-b border-indigo-500/30 px-4 py-2.5 backdrop-blur-md">
          <span className="text-xs font-bold text-indigo-200 flex items-center gap-1.5">
            <CheckSquare className="h-4 w-4 text-indigo-400" />
            {selectedFileIds.length} file{selectedFileIds.length === 1 ? '' : 's'} selected
          </span>

          <div className="flex items-center gap-2">
            <button
              onClick={handleBatchDownloadZip}
              disabled={isBatchProcessing}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500 transition"
            >
              <Archive className="h-3.5 w-3.5" />
              <span>Download Zip</span>
            </button>

            <button
              onClick={handleBatchMove}
              disabled={isBatchProcessing}
              className="flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800 transition"
            >
              <Layers className="h-3.5 w-3.5 text-amber-400" />
              <span>Move Selected</span>
            </button>

            <button
              onClick={handleBatchTrash}
              disabled={isBatchProcessing}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-950/40 px-3 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-900/60 transition"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Move to Trash</span>
            </button>

            <button
              onClick={() => setSelectedFileIds([])}
              className="text-xs text-slate-400 hover:text-white px-2"
            >
              Deselect
            </button>
          </div>
        </div>
      )}

      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border-b border-slate-800 bg-slate-950/40">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <button
            onClick={() => onSelectFolder(null)}
            className={`hover:text-indigo-400 transition ${currentFolderId === null ? 'font-bold text-white' : 'text-slate-400'}`}
          >
            All Files
          </button>
          {currentFolderId && (
            <>
              <ChevronRight className="h-4 w-4 text-slate-600" />
              <span className="font-bold text-white">
                {folders.find((f) => f.id === currentFolderId)?.name || 'Folder'}
              </span>
            </>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
            <input
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-44 sm:w-60 rounded-lg border border-slate-800 bg-slate-900/90 pl-8 pr-3 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <button
            onClick={() => setIsCreatingFolder(true)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 transition"
          >
            <FolderPlus className="h-3.5 w-3.5 text-amber-400" />
            <span>New Folder</span>
          </button>
        </div>
      </div>

      {/* New Folder Inline Form */}
      {isCreatingFolder && (
        <form onSubmit={handleCreateFolderSubmit} className="flex items-center gap-2 p-3 bg-indigo-950/30 border-b border-indigo-500/20">
          <Folder className="h-4 w-4 text-amber-400" />
          <input
            type="text"
            placeholder="Folder name..."
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            className="h-8 flex-1 rounded-md border border-indigo-500/30 bg-slate-900 px-3 text-xs text-white focus:outline-none"
          />
          <button type="submit" className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500">
            Create
          </button>
          <button type="button" onClick={() => setIsCreatingFolder(false)} className="rounded-md border border-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-400 hover:bg-slate-800">
            Cancel
          </button>
        </form>
      )}

      {/* Virtual Folders Grid */}
      {folders.length > 0 && currentFolderId === null && (
        <div className="p-4 border-b border-slate-800/60 bg-slate-950/20">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Virtual Folders</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {folders.map((folder) => (
              <button
                key={folder.id}
                onClick={() => onSelectFolder(folder.id)}
                className="flex items-center gap-2.5 rounded-xl border border-slate-800 bg-slate-900/90 p-2.5 text-left transition hover:border-slate-700 hover:bg-slate-800"
              >
                <Folder className="h-5 w-5 text-amber-400 shrink-0" />
                <span className="text-xs font-medium text-slate-200 truncate">{folder.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Files Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-950/60 text-slate-400 border-b border-slate-800">
            <tr>
              <th className="py-3 px-4 w-10">
                <button onClick={toggleSelectAll} className="text-slate-400 hover:text-white">
                  {isAllSelected ? <CheckSquare className="h-4 w-4 text-indigo-400" /> : <Square className="h-4 w-4" />}
                </button>
              </th>
              <th className="py-3 px-4 font-semibold">Name</th>
              <th className="py-3 px-4 font-semibold hidden md:table-cell">Account</th>
              <th className="py-3 px-4 font-semibold">Size</th>
              <th className="py-3 px-4 font-semibold hidden sm:table-cell">Uploaded</th>
              <th className="py-3 px-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filteredFiles.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-slate-500">
                  No files found in this location.
                </td>
              </tr>
            ) : (
              filteredFiles.map((file) => {
                const isSelected = selectedFileIds.includes(file.id);
                return (
                  <tr key={file.id} className={`group transition ${isSelected ? 'bg-indigo-950/20' : 'hover:bg-slate-800/40'}`}>
                    <td className="py-3 px-4">
                      <button onClick={() => toggleSelectFile(file.id)} className="text-slate-400 hover:text-white">
                        {isSelected ? <CheckSquare className="h-4 w-4 text-indigo-400" /> : <Square className="h-4 w-4" />}
                      </button>
                    </td>

                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        {getFileIcon(file.mime_type)}
                        <span className="font-medium text-slate-200 group-hover:text-white truncate max-w-xs sm:max-w-md">
                          {file.filename}
                        </span>
                      </div>
                    </td>

                    <td className="py-3 px-4 hidden md:table-cell">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-300 border border-slate-700">
                        <HardDrive className="h-3 w-3 text-indigo-400" />
                        {file.connected_accounts?.google_email || 'Google Account'}
                      </span>
                    </td>

                    <td className="py-3 px-4 text-slate-400 font-mono">
                      {formatBytes(file.size_bytes)}
                    </td>

                    <td className="py-3 px-4 text-slate-400 hidden sm:table-cell">
                      <div className="flex items-center gap-1 text-[11px]">
                        <Clock className="h-3 w-3 text-slate-500" />
                        {new Date(file.uploaded_at).toLocaleDateString()}
                      </div>
                    </td>

                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => onShareFile(file)}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-cyan-400 transition"
                          title="Generate Share Link"
                        >
                          <Share2 className="h-4 w-4" />
                        </button>

                        <button
                          onClick={() => onPreviewFile(file)}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition"
                          title="Preview File"
                        >
                          <Eye className="h-4 w-4" />
                        </button>

                        <button
                          onClick={() => onDownloadFile(file)}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-indigo-400 transition"
                          title="Download File"
                        >
                          <Download className="h-4 w-4" />
                        </button>

                        <button
                          onClick={() => {
                            const newName = prompt('Enter new filename:', file.filename);
                            if (newName && newName.trim()) {
                              onRenameFile(file.id, newName.trim());
                            }
                          }}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-amber-400 transition"
                          title="Rename File"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>

                        <button
                          onClick={() => onDeleteFile(file.id)}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-400 transition"
                          title="Move to Trash"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

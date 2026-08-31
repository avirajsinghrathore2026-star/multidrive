'use client';

import React from 'react';
import { X, Download, FileText } from 'lucide-react';
import { FileRecord } from './FileBrowser';

interface FilePreviewModalProps {
  file: FileRecord | null;
  onClose: () => void;
  onDownload: (file: FileRecord) => void;
}

export const FilePreviewModal: React.FC<FilePreviewModalProps> = ({
  file,
  onClose,
  onDownload,
}) => {
  if (!file) return null;

  const previewUrl = `/api/files/${file.id}/preview`;
  const isImage = file.mime_type.startsWith('image/');
  const isPdf = file.mime_type.includes('pdf');
  const isVideo = file.mime_type.startsWith('video/');
  const isAudio = file.mime_type.startsWith('audio/');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 sm:p-6">
      <div className="flex h-full max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-4 py-3">
          <div className="flex items-center gap-2 truncate">
            <FileText className="h-5 w-5 text-indigo-400 shrink-0" />
            <h4 className="text-sm font-semibold text-white truncate" title={file.filename}>
              {file.filename}
            </h4>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onDownload(file)}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 transition"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download</span>
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content Viewer Body */}
        <div className="flex-1 overflow-auto bg-slate-950/80 p-4 flex items-center justify-center min-h-[300px]">
          {isImage ? (
            <img
              src={previewUrl}
              alt={file.filename}
              className="max-h-full max-w-full rounded-lg object-contain"
            />
          ) : isPdf ? (
            <iframe
              src={previewUrl}
              title={file.filename}
              className="h-full w-full rounded-lg border-0 min-h-[500px]"
            />
          ) : isVideo ? (
            <video controls className="max-h-full max-w-full rounded-lg">
              <source src={previewUrl} type={file.mime_type} />
              Your browser does not support video playback.
            </video>
          ) : isAudio ? (
            <div className="text-center p-8 space-y-4">
              <p className="text-sm font-medium text-slate-300">Audio Playback</p>
              <audio controls className="mx-auto">
                <source src={previewUrl} type={file.mime_type} />
                Your browser does not support audio.
              </audio>
            </div>
          ) : (
            <div className="text-center p-8 space-y-4">
              <FileText className="mx-auto h-16 w-16 text-slate-600" />
              <div>
                <p className="text-sm font-medium text-slate-300">No inline preview available for this file type.</p>
                <p className="text-xs text-slate-500 mt-1">Type: {file.mime_type}</p>
              </div>
              <button
                onClick={() => onDownload(file)}
                className="mt-2 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                <Download className="h-4 w-4" /> Download File
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

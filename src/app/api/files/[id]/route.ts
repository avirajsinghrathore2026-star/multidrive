import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile } from '@/lib/auth';
import { deleteFileRecord } from '@/lib/storage-engine';
import { successResponse, errorResponse, handleApiError } from '@/lib/api-utils';
import { decryptToken } from '@/lib/vault';
import { renameDriveFile } from '@/lib/google-drive';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, adminSupabase } = await requireUser();
    const { id } = await params;

    const file = await requireOwnedFile(adminSupabase, user.id, id);
    return successResponse({ file });
  } catch (err: any) {
    return handleApiError(err);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, adminSupabase } = await requireUser();
    const { id } = await params;

    await requireOwnedFile(adminSupabase, user.id, id);
    await deleteFileRecord(adminSupabase, user.id, id);

    return successResponse({ success: true, message: 'File deleted successfully' });
  } catch (err: any) {
    return handleApiError(err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, adminSupabase } = await requireUser();
    const { id } = await params;

    const fileRecord = await requireOwnedFile(adminSupabase, user.id, id);
    const body = await request.json();
    const filename = body.filename;

    if (!filename || typeof filename !== 'string' || !filename.trim()) {
      return errorResponse('INVALID_ARGUMENT', 'Filename string required', undefined, 400);
    }

    const newFilename = filename.trim();

    const { data: updated, error: updateErr } = await adminSupabase
      .from('file_records')
      .update({ filename: newFilename, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', user.id)
      .select('*')
      .single();

    if (updateErr) throw updateErr;

    try {
      const account = fileRecord.connected_accounts;
      if (account && account.vault_secret_id) {
        const refreshToken = decryptToken(account.vault_secret_id);
        await renameDriveFile(refreshToken, fileRecord.google_drive_file_id, newFilename);
      }
    } catch (renameErr) {
      console.error('Warning: Failed to rename file on Google Drive API:', renameErr);
    }

    return successResponse({ file: updated });
  } catch (err: any) {
    return handleApiError(err);
  }
}

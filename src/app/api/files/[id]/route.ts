import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireOwnedFile, requireOwnedFolder, AuthError } from '@/lib/auth';
import { decryptToken } from '@/lib/vault';
import { deleteDriveFile, renameDriveFile, fetchGoogleAccountDetails } from '@/lib/google-drive';

// DELETE /api/files/[id] - Delete file from Google Drive & Database
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, supabase } = await requireUser();

    // 1. Verify file ownership strictly
    const fileRecord = await requireOwnedFile(supabase, user.id, id);
    const account = fileRecord.connected_accounts;
    const refreshToken = decryptToken(account.vault_secret_id);

    // 2. Delete file from Google Drive
    await deleteDriveFile(refreshToken, fileRecord.google_drive_file_id);

    // 3. Delete database record
    await supabase.from('file_records').delete().eq('id', id).eq('user_id', user.id);

    // 4. Refresh account storage quota
    fetchGoogleAccountDetails(refreshToken)
      .then((details) => {
        return supabase
          .from('connected_accounts')
          .update({
            storage_used_bytes: details.storageUsedBytes,
            storage_total_bytes: details.storageTotalBytes,
            quota_last_checked_at: new Date().toISOString(),
          })
          .eq('id', account.id)
          .eq('user_id', user.id);
      })
      .catch((err) => console.error('Post-delete quota refresh failed:', err));

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Delete file route error:', err);
    return NextResponse.json({ error: 'Failed to delete file' }, { status: 500 });
  }
}

// PATCH /api/files/[id] - Rename file or move virtual folder
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, supabase } = await requireUser();
    const body = await request.json();
    const { filename, virtualFolderId } = body;

    // 1. Verify file ownership strictly
    const fileRecord = await requireOwnedFile(supabase, user.id, id);

    const updatePayload: Record<string, unknown> = {};

    // Rename action
    if (filename && filename !== fileRecord.filename) {
      const account = fileRecord.connected_accounts;
      const refreshToken = decryptToken(account.vault_secret_id);
      await renameDriveFile(refreshToken, fileRecord.google_drive_file_id, filename);
      updatePayload.filename = filename;
    }

    // Move virtual folder action (verify target folder ownership)
    if (virtualFolderId !== undefined) {
      if (virtualFolderId !== null && virtualFolderId !== 'root') {
        await requireOwnedFolder(supabase, user.id, virtualFolderId);
        updatePayload.virtual_folder_id = virtualFolderId;
      } else {
        updatePayload.virtual_folder_id = null;
      }
    }

    const { data: updatedRecord, error: updateErr } = await supabase
      .from('file_records')
      .update(updatePayload)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .single();

    if (updateErr) {
      return NextResponse.json({ error: 'Failed to update file' }, { status: 500 });
    }

    return NextResponse.json({ success: true, file: updatedRecord });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Patch file route error:', err);
    return NextResponse.json({ error: 'Failed to update file' }, { status: 500 });
  }
}

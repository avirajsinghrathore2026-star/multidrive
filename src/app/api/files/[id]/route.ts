import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/vault';
import { deleteDriveFile, renameDriveFile, fetchGoogleAccountDetails } from '@/lib/google-drive';

// DELETE /api/files/[id] - Delete file from Google Drive & Database
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    // 1. Fetch file record with connected account details
    const { data: fileRecord, error: fetchErr } = await supabase
      .from('file_records')
      .select('*, connected_accounts(*)')
      .eq('id', id)
      .single();

    if (fetchErr || !fileRecord) {
      return NextResponse.json({ error: 'File record not found' }, { status: 404 });
    }

    const account = fileRecord.connected_accounts;
    const refreshToken = decryptToken(account.vault_secret_id);

    // 2. Delete file from Google Drive
    await deleteDriveFile(refreshToken, fileRecord.google_drive_file_id);

    // 3. Delete database record
    await supabase.from('file_records').delete().eq('id', id);

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
          .eq('id', account.id);
      })
      .catch((err) => console.error('Post-delete quota refresh failed:', err));

    return NextResponse.json({ success: true });
  } catch (err) {
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
    const body = await request.json();
    const { filename, virtualFolderId } = body;

    const supabase = await createClient();
    const { data: fileRecord, error: fetchErr } = await supabase
      .from('file_records')
      .select('*, connected_accounts(*)')
      .eq('id', id)
      .single();

    if (fetchErr || !fileRecord) {
      return NextResponse.json({ error: 'File record not found' }, { status: 404 });
    }

    const updatePayload: Record<string, unknown> = {};

    // Rename action
    if (filename && filename !== fileRecord.filename) {
      const account = fileRecord.connected_accounts;
      const refreshToken = decryptToken(account.vault_secret_id);
      await renameDriveFile(refreshToken, fileRecord.google_drive_file_id, filename);
      updatePayload.filename = filename;
    }

    // Move virtual folder action
    if (virtualFolderId !== undefined) {
      updatePayload.virtual_folder_id = virtualFolderId;
    }

    const { data: updatedRecord, error: updateErr } = await supabase
      .from('file_records')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, file: updatedRecord });
  } catch (err) {
    console.error('Patch file route error:', err);
    return NextResponse.json({ error: 'Failed to update file' }, { status: 500 });
  }
}

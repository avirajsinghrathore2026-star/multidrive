import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireOwnedFolder, AuthError } from '@/lib/auth';
import { decryptToken } from '@/lib/vault';
import { deleteDriveFile, fetchGoogleAccountDetails } from '@/lib/google-drive';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();
    const body = await request.json();
    const { action, fileIds, targetFolderId } = body;

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return NextResponse.json({ error: 'fileIds array is required' }, { status: 400 });
    }

    // 1. Move to Trash (Soft Delete)
    if (action === 'bulk_delete') {
      const { error } = await supabase
        .from('file_records')
        .update({
          in_trash: true,
          deleted_at: new Date().toISOString(),
        })
        .in('id', fileIds)
        .eq('user_id', user.id);

      if (error) return NextResponse.json({ error: 'Failed to delete files' }, { status: 500 });
      return NextResponse.json({ success: true, count: fileIds.length });
    }

    // 2. Restore from Trash
    if (action === 'bulk_restore') {
      const { error } = await supabase
        .from('file_records')
        .update({
          in_trash: false,
          deleted_at: null,
        })
        .in('id', fileIds)
        .eq('user_id', user.id);

      if (error) return NextResponse.json({ error: 'Failed to restore files' }, { status: 500 });
      return NextResponse.json({ success: true, count: fileIds.length });
    }

    // 3. Move to Virtual Folder
    if (action === 'bulk_move') {
      if (targetFolderId && targetFolderId !== 'root') {
        await requireOwnedFolder(supabase, user.id, targetFolderId);
      }

      const { error } = await supabase
        .from('file_records')
        .update({
          virtual_folder_id: targetFolderId && targetFolderId !== 'root' ? targetFolderId : null,
        })
        .in('id', fileIds)
        .eq('user_id', user.id);

      if (error) return NextResponse.json({ error: 'Failed to move files' }, { status: 500 });
      return NextResponse.json({ success: true, count: fileIds.length });
    }

    // 4. Permanent Delete (Removes from Drive & Database)
    if (action === 'bulk_permanent_delete') {
      const { data: files, error: fetchErr } = await supabase
        .from('file_records')
        .select('*, connected_accounts(*)')
        .in('id', fileIds)
        .eq('user_id', user.id);

      if (fetchErr || !files) {
        return NextResponse.json({ error: 'Failed to fetch files for permanent delete' }, { status: 500 });
      }

      const affectedAccountIds = new Set<string>();

      for (const file of files) {
        try {
          const account = file.connected_accounts;
          const refreshToken = decryptToken(account.vault_secret_id);
          await deleteDriveFile(refreshToken, file.google_drive_file_id);
          affectedAccountIds.add(account.id);
        } catch (err) {
          console.error(`Failed to delete file ${file.id} from Drive:`, err);
        }
      }

      // Delete records from database strictly matching user_id
      await supabase.from('file_records').delete().in('id', fileIds).eq('user_id', user.id);

      // Refresh affected account quotas asynchronously
      for (const accId of Array.from(affectedAccountIds)) {
        const { data: acc } = await supabase
          .from('connected_accounts')
          .select('*')
          .eq('id', accId)
          .eq('user_id', user.id)
          .single();

        if (acc) {
          try {
            const refreshToken = decryptToken(acc.vault_secret_id);
            const details = await fetchGoogleAccountDetails(refreshToken);
            await supabase
              .from('connected_accounts')
              .update({
                storage_used_bytes: details.storageUsedBytes,
                storage_total_bytes: details.storageTotalBytes,
                quota_last_checked_at: new Date().toISOString(),
              })
              .eq('id', accId)
              .eq('user_id', user.id);
          } catch (e) {
            console.error('Quota refresh error after batch delete:', e);
          }
        }
      }

      return NextResponse.json({ success: true, count: files.length });
    }

    return NextResponse.json({ error: 'Invalid batch action' }, { status: 400 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Batch file handler error:', err);
    return NextResponse.json({ error: 'Batch operation failed' }, { status: 500 });
  }
}

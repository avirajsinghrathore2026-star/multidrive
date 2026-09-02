import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile } from '@/lib/auth';
import { deleteFileRecord } from '@/lib/storage-engine';
import { deleteDriveFile } from '@/lib/google-drive';
import { decryptToken } from '@/lib/vault';
import { successResponse, errorResponse, handleApiError, parseAndValidateJson, checkRateLimit } from '@/lib/api-utils';
import { BatchOperationSchema } from '@/lib/schemas/api-schemas';

export async function POST(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();

    // Rate Limiting Check (§5, §7)
    const rateLimit = await checkRateLimit(`batch_files:${user.id}`, 15, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Batch operation rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const validated = await parseAndValidateJson(request, BatchOperationSchema);

    // Fail Fast Authorization Verification on all target files (§7)
    for (const fileId of validated.fileIds) {
      await requireOwnedFile(adminSupabase, user.id, fileId);
    }

    if (validated.action === 'delete') {
      const results = [];
      for (const fileId of validated.fileIds) {
        await deleteFileRecord(adminSupabase, user.id, fileId);
        results.push({ fileId, status: 'deleted' });
      }
      return successResponse({ action: 'delete', results });
    }

    if (validated.action === 'move') {
      const { data, error } = await adminSupabase
        .from('file_records')
        .update({ virtual_folder_id: validated.targetFolderId || null })
        .in('id', validated.fileIds)
        .eq('user_id', user.id)
        .select('*');

      if (error) throw error;
      return successResponse({ action: 'move', updatedFiles: data });
    }

    if (validated.action === 'bulk_restore') {
      const { data, error } = await adminSupabase
        .from('file_records')
        .update({ in_trash: false })
        .in('id', validated.fileIds)
        .eq('user_id', user.id)
        .select('*');

      if (error) throw error;
      return successResponse({ action: 'bulk_restore', restoredFiles: data });
    }

    if (validated.action === 'bulk_permanent_delete') {
      const results = [];
      for (const fileId of validated.fileIds) {
        try {
          // Fetch full record to get Drive file ID and account token
          const fileRecord = await requireOwnedFile(adminSupabase, user.id, fileId);
          const account = fileRecord.connected_accounts;
          if (account?.vault_secret_id && fileRecord.google_drive_file_id) {
            const refreshToken = decryptToken(account.vault_secret_id);
            await deleteDriveFile(refreshToken, fileRecord.google_drive_file_id);
          }
        } catch (driveErr) {
          console.error(`[batch] Failed to delete file ${fileId} from Google Drive:`, driveErr);
          // Continue — still remove from DB even if Drive delete fails
        }
        await deleteFileRecord(adminSupabase, user.id, fileId);
        results.push({ fileId, status: 'permanently_deleted' });
      }
      return successResponse({ action: 'bulk_permanent_delete', results });
    }

    return errorResponse('INVALID_ARGUMENT', `Unsupported batch action: ${validated.action}`, undefined, 400);
  } catch (err: any) {
    return handleApiError(err);
  }
}


import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile } from '@/lib/auth';
import { deleteFileRecord } from '@/lib/storage-engine';
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

    return errorResponse('INVALID_ARGUMENT', `Unsupported batch action: ${validated.action}`, undefined, 400);
  } catch (err: any) {
    return handleApiError(err);
  }
}

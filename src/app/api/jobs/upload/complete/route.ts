import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile } from '@/lib/auth';
import { successResponse, errorResponse, handleApiError, parseAndValidateJson, checkRateLimit } from '@/lib/api-utils';
import { z } from 'zod';

const CompleteUploadSchema = z.object({
  fileRecordId: z.string().uuid('Invalid fileRecordId'),
  googleDriveFileId: z.string().min(1, 'googleDriveFileId required'),
  reservationId: z.string().optional().nullable(),
});

export async function POST(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();

    // Rate limiting
    const rateLimit = await checkRateLimit(`job_upload_complete:${user.id}`, 30, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Upload completion rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const validated = await parseAndValidateJson(request, CompleteUploadSchema);

    // Verify ownership
    const existingFile = await requireOwnedFile(adminSupabase, user.id, validated.fileRecordId);

    // 1. Durable Commit: Mark file state complete with physical Google Drive object ID
    const { data: fileRecord, error: updateErr } = await adminSupabase
      .from('file_records')
      .update({
        google_drive_file_id: validated.googleDriveFileId,
        upload_state: 'complete',
        upload_state_updated_at: new Date().toISOString(),
      })
      .eq('id', validated.fileRecordId)
      .eq('user_id', user.id)
      .select('*')
      .single();

    if (updateErr) throw updateErr;

    // 2. Release storage reservation lease if present
    if (validated.reservationId) {
      await adminSupabase
        .from('storage_reservations')
        .update({ released_at: new Date().toISOString() })
        .eq('id', validated.reservationId);
    }

    return successResponse({ success: true, fileRecord });
  } catch (err: any) {
    return handleApiError(err);
  }
}

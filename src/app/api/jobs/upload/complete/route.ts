import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile } from '@/lib/auth';
import { successResponse, errorResponse, handleApiError, parseAndValidateJson, checkRateLimit } from '@/lib/api-utils';
import { transitionUploadState, verifyPhysicalObject } from '@/lib/storage-engine';
import { decryptToken } from '@/lib/vault';
import { z } from 'zod';

const CompleteUploadSchema = z.object({
  fileRecordId: z.string().uuid('Invalid fileRecordId'),
  googleDriveFileId: z.string().min(1, 'googleDriveFileId required'),
  reservationId: z.string().optional().nullable(),
});

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();

    // Rate limiting
    const rateLimit = await checkRateLimit(`job_upload_complete:${user.id}`, 30, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Upload completion rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const validated = await parseAndValidateJson(request, CompleteUploadSchema);

    if (!validated.googleDriveFileId || validated.googleDriveFileId.startsWith('gdrive-uploaded-') || validated.googleDriveFileId.startsWith('pending-')) {
      return errorResponse('INVALID_ARGUMENT', 'Invalid Google Drive file ID. Physical upload may not have completed.', undefined, 400);
    }

    // Verify ownership and get file details
    const existingFile = await requireOwnedFile(adminSupabase, user.id, validated.fileRecordId);

    // 1. Transition to uploaded
    await transitionUploadState(adminSupabase, existingFile.id, 'uploading', 'uploaded', {
      google_drive_file_id: validated.googleDriveFileId,
    });

    // 2. Fetch connected account for verification
    const { data: account } = await adminSupabase
      .from('connected_accounts')
      .select('vault_secret_id')
      .eq('id', existingFile.connected_account_id)
      .single();

    if (!account) {
      throw new Error(`NO_CONNECTED_ACCOUNTS: Connected account not found for verification.`);
    }

    const refreshToken = decryptToken(account.vault_secret_id);

    // 3. Verify Physical Object (Size & Checksum)
    const verifyResult = await verifyPhysicalObject(
      refreshToken,
      validated.googleDriveFileId,
      Number(existingFile.size_bytes)
    );

    if (!verifyResult.isValid) {
      throw new Error(`VERIFICATION_MISMATCH: Physical verification failed: ${verifyResult.error}`);
    }

    // 4. Complete transitions
    await transitionUploadState(adminSupabase, existingFile.id, 'uploaded', 'verified', {
      verified_md5: verifyResult.md5,
    });
    await transitionUploadState(adminSupabase, existingFile.id, 'verified', 'committed');
    const completedFile = await transitionUploadState(adminSupabase, existingFile.id, 'committed', 'complete');

    // 5. Release storage reservation lease if present
    if (validated.reservationId) {
      await adminSupabase
        .from('storage_reservations')
        .update({ released_at: new Date().toISOString() })
        .eq('id', validated.reservationId);
    }

    return successResponse({ success: true, fileRecord: completedFile });
  } catch (err: any) {
    return handleApiError(err);
  }
}

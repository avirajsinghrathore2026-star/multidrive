import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { createReservationLease } from '@/lib/storage-engine';
import { createResumableUploadSession } from '@/lib/google-drive';
import { decryptToken } from '@/lib/vault';
import { successResponse, errorResponse, handleApiError, parseAndValidateJson, checkRateLimit } from '@/lib/api-utils';
import { z } from 'zod';
import crypto from 'crypto';

const InitiateUploadSchema = z.object({
  filename: z.string().min(1, 'Filename required'),
  sizeBytes: z.number().positive('File size must be positive'),
  mimeType: z.string().default('application/octet-stream'),
  virtualFolderId: z.string().optional().nullable(),
});

export async function POST(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();

    // Rate limiting
    const rateLimit = await checkRateLimit(`job_upload_initiate:${user.id}`, 30, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Upload initiate rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const validated = await parseAndValidateJson(request, InitiateUploadSchema);
    const fileRecordId = crypto.randomUUID();
    const idempotencyKey = `idemp-direct-upload-${fileRecordId}`;

    // 1. Capacity Selection & Storage Lease Reservation
    const leaseResult = await createReservationLease(
      adminSupabase,
      user.id,
      fileRecordId,
      BigInt(validated.sizeBytes),
      idempotencyKey
    );

    const targetAccount = leaseResult.account;
    const refreshToken = decryptToken(targetAccount.vault_secret_id);

    // 2. Obtain Google Drive Resumable Session URL
    const { uploadUrl } = await createResumableUploadSession(
      refreshToken,
      validated.filename,
      validated.mimeType,
      validated.sizeBytes
    );

    // 3. Create pending file record in DB
    const { data: fileRecord, error: fileErr } = await adminSupabase
      .from('file_records')
      .insert({
        id: fileRecordId,
        user_id: user.id,
        connected_account_id: targetAccount.id,
        google_drive_file_id: 'pending-direct-upload',
        filename: validated.filename,
        size_bytes: validated.sizeBytes,
        mime_type: validated.mimeType,
        virtual_folder_id: validated.virtualFolderId || null,
        upload_state: 'uploading',
        idempotency_key: idempotencyKey,
        uploaded_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (fileErr) throw fileErr;

    return successResponse({
      uploadUrl,
      fileRecordId,
      reservationId: leaseResult.reservation.id,
      targetAccountEmail: targetAccount.google_email,
    });
  } catch (err: any) {
    return handleApiError(err);
  }
}

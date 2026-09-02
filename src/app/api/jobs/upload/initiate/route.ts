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

    // 1. Query user connected accounts to find best capacity account candidate
    let { data: accounts, error: accErr } = await adminSupabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', user.id);

    if (!accounts || accounts.length === 0) {
      // Fallback matching by user email
      if (user.email) {
        const { data: fallbackAccs } = await adminSupabase
          .from('connected_accounts')
          .select('*')
          .eq('google_email', user.email);

        if (fallbackAccs && fallbackAccs.length > 0) {
          await adminSupabase
            .from('connected_accounts')
            .update({ user_id: user.id })
            .eq('google_email', user.email);
          accounts = fallbackAccs;
        }
      }
    }

    if (!accounts || accounts.length === 0) {
      return errorResponse('NO_CONNECTED_ACCOUNTS', 'No connected Google Drive accounts found. Please connect a Google account first.', undefined, 400);
    }

    // Sort fullest first to find account with max free space
    const targetAccount = accounts
      .map((acc) => ({
        ...acc,
        freeSpace: BigInt(acc.storage_total_bytes) - BigInt(acc.storage_used_bytes),
      }))
      .sort((a, b) => (b.freeSpace > a.freeSpace ? 1 : -1))[0];

    if (targetAccount.freeSpace < BigInt(validated.sizeBytes)) {
      return errorResponse('INSUFFICIENT_CAPACITY', `File size (${validated.sizeBytes} bytes) exceeds available storage capacity across connected accounts.`, undefined, 400);
    }

    // 2. Insert pending file_records row FIRST to satisfy foreign key constraint
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

    // 3. Create Storage Capacity Lease Reservation (now referencing existing fileRecordId)
    const leaseResult = await createReservationLease(
      adminSupabase,
      user.id,
      fileRecordId,
      BigInt(validated.sizeBytes),
      idempotencyKey
    );

    const refreshToken = decryptToken(targetAccount.vault_secret_id);

    // 4. Obtain Google Drive Resumable Session URL
    const { uploadUrl } = await createResumableUploadSession(
      refreshToken,
      validated.filename,
      validated.mimeType,
      validated.sizeBytes
    );

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

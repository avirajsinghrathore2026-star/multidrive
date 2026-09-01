import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { reserveAndUploadFile } from '@/lib/storage-engine';
import { successResponse, errorResponse, handleApiError, checkRateLimit } from '@/lib/api-utils';
import { UploadJobSchema } from '@/lib/schemas/api-schemas';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();

    // Rate Limiting Check (§5, §7)
    const rateLimit = await checkRateLimit(`files_upload:${user.id}`, 20, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'File upload rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const idempotencyKeyInput = formData.get('idempotencyKey') as string | null;
    const virtualFolderId = (formData.get('virtualFolderId') as string | null) || undefined;

    if (!file) {
      return errorResponse('INVALID_ARGUMENT', 'No file provided in form-data payload', undefined, 400);
    }

    const validated = UploadJobSchema.parse({
      sizeBytes: file.size,
      idempotencyKey: idempotencyKeyInput || undefined,
    });

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const idempotencyKey = validated.idempotencyKey || `idemp-direct-upload-${crypto.randomUUID()}`;

    const result = await reserveAndUploadFile(
      supabase,
      user.id,
      file.name,
      file.size,
      file.type || 'application/octet-stream',
      buffer,
      idempotencyKey,
      virtualFolderId
    );

    return successResponse(result);
  } catch (err: any) {
    return handleApiError(err);
  }
}

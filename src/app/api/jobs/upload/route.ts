import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { createOrReuseJob, acquireJobLease } from '@/lib/job-engine';
import { processUploadJob } from '@/lib/jobs/upload-handler';
import { successResponse, errorResponse, handleApiError, checkRateLimit } from '@/lib/api-utils';
import { UploadJobSchema } from '@/lib/schemas/api-schemas';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();

    // Rate Limiting Check (§5, §7)
    const rateLimit = await checkRateLimit(`job_upload:${user.id}`, 20, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Upload rate limit exceeded. Please wait before retrying.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const clientKey = formData.get('idempotencyKey') as string | null;
    const expectedMd5 = formData.get('expectedMd5') as string | null;

    if (!file) {
      return errorResponse('INVALID_ARGUMENT', 'No file provided in form-data payload', undefined, 400);
    }

    // Validate sizeBytes and parameters via Zod Schema
    const validated = UploadJobSchema.parse({
      sizeBytes: file.size,
      idempotencyKey: clientKey || undefined,
      expectedMd5: expectedMd5 || undefined,
    });

    const idempotencyKey = validated.idempotencyKey || `idemp-job-upload-${crypto.randomUUID()}`;

    // Create or reuse upload job (§13)
    const { job, isReused } = await createOrReuseJob(supabase, 'upload_jobs', user.id, idempotencyKey, {
      size_bytes: validated.sizeBytes,
    });

    if (job.state === 'COMPLETED') {
      return successResponse({ job, isReused: true });
    }

    // Acquire worker lease and process upload job
    const workerId = crypto.randomUUID();
    const leasedJob = await acquireJobLease(supabase, 'upload_jobs', job.id, workerId);

    if (!leasedJob) {
      return successResponse({ job, isReused: true, message: 'Job leased by another worker' });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const completedJob = await processUploadJob(job.id, buffer, validated.expectedMd5);
    return successResponse({ job: completedJob, isReused });
  } catch (err: any) {
    return handleApiError(err);
  }
}

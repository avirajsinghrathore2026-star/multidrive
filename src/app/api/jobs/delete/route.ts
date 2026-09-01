import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile } from '@/lib/auth';
import { createOrReuseJob, acquireJobLease } from '@/lib/job-engine';
import { processDeleteJob } from '@/lib/jobs/delete-handler';
import { successResponse, errorResponse, handleApiError, parseAndValidateJson, checkRateLimit } from '@/lib/api-utils';
import { DeleteJobSchema } from '@/lib/schemas/api-schemas';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();

    // Rate Limiting Check (§5, §7)
    const rateLimit = await checkRateLimit(`job_delete:${user.id}`, 20, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Delete job rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const validated = await parseAndValidateJson(request, DeleteJobSchema);

    // Fail Fast API Authorization Check (§7)
    const fileRecord = await requireOwnedFile(supabase, user.id, validated.fileId);
    const idempotencyKey = validated.idempotencyKey || `idemp-job-delete-${validated.fileId}`;

    const { job, isReused } = await createOrReuseJob(supabase, 'delete_jobs', user.id, idempotencyKey, {
      file_record_id: validated.fileId,
      provider_object_id: fileRecord.google_drive_file_id,
    });

    if (job.state === 'COMPLETED') {
      return successResponse({ job, isReused: true });
    }

    const workerId = crypto.randomUUID();
    const leasedJob = await acquireJobLease(supabase, 'delete_jobs', job.id, workerId);

    if (!leasedJob) {
      return successResponse({ job, isReused: true, message: 'Job leased by another worker' });
    }

    const completedJob = await processDeleteJob(job.id);
    return successResponse({ job: completedJob, isReused });
  } catch (err: any) {
    return handleApiError(err);
  }
}

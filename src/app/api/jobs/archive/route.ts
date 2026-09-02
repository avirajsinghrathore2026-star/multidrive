import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile } from '@/lib/auth';
import { createOrReuseJob, acquireJobLease } from '@/lib/job-engine';
import { processArchiveJob } from '@/lib/jobs/archive-handler';
import { successResponse, errorResponse, handleApiError, parseAndValidateJson, checkRateLimit } from '@/lib/api-utils';
import { ArchiveJobSchema } from '@/lib/schemas/api-schemas';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();

    // Rate Limiting Check (§5, §7)
    const rateLimit = await checkRateLimit(`job_archive:${user.id}`, 10, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Archive job rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const validated = await parseAndValidateJson(request, ArchiveJobSchema);

    // Fail Fast API Authorization Check on each file ID (§7)
    for (const fileId of validated.fileIds) {
      await requireOwnedFile(adminSupabase, user.id, fileId);
    }

    const idempotencyKey = validated.idempotencyKey || `idemp-job-archive-${crypto.randomUUID()}`;

    const { job, isReused } = await createOrReuseJob(adminSupabase, 'archive_jobs', user.id, idempotencyKey, {
      file_record_ids: validated.fileIds,
    });

    if (job.state === 'COMPLETED') {
      return successResponse({ job, isReused: true });
    }

    const workerId = crypto.randomUUID();
    const leasedJob = await acquireJobLease(adminSupabase, 'archive_jobs', job.id, workerId);

    if (!leasedJob) {
      return successResponse({ job, isReused: true, message: 'Job leased by another worker' });
    }

    const completedJob = await processArchiveJob(job.id);
    return successResponse({ job: completedJob, isReused });
  } catch (err: any) {
    return handleApiError(err);
  }
}

import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile, requireOwnedAccount } from '@/lib/auth';
import { createOrReuseJob, acquireJobLease } from '@/lib/job-engine';
import { processMigrationJob } from '@/lib/jobs/migration-handler';
import { successResponse, errorResponse, handleApiError, parseAndValidateJson, checkRateLimit } from '@/lib/api-utils';
import { MigrationJobSchema } from '@/lib/schemas/api-schemas';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();

    // Rate Limiting Check (§5, §7)
    const rateLimit = await checkRateLimit(`job_migration:${user.id}`, 10, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Migration rate limit exceeded. Please wait before retrying.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const validated = await parseAndValidateJson(request, MigrationJobSchema);

    // Fail Fast API Authorization Check (§7)
    const fileRecord = await requireOwnedFile(adminSupabase, user.id, validated.fileId);
    await requireOwnedAccount(adminSupabase, user.id, validated.destinationAccountId);

    const idempotencyKey = validated.idempotencyKey || `idemp-job-migrate-${validated.fileId}-${validated.destinationAccountId}`;

    const { job, isReused } = await createOrReuseJob(adminSupabase, 'migration_jobs', user.id, idempotencyKey, {
      file_record_id: validated.fileId,
      source_account_id: fileRecord.connected_account_id,
      destination_account_id: validated.destinationAccountId,
      source_provider_object_id: fileRecord.google_drive_file_id,
    });

    if (job.state === 'COMPLETED') {
      return successResponse({ job, isReused: true });
    }

    const workerId = crypto.randomUUID();
    const leasedJob = await acquireJobLease(adminSupabase, 'migration_jobs', job.id, workerId);

    if (!leasedJob) {
      return successResponse({ job, isReused: true, message: 'Job leased by another worker' });
    }

    const completedJob = await processMigrationJob(job.id);
    return successResponse({ job: completedJob, isReused });
  } catch (err: any) {
    return handleApiError(err);
  }
}

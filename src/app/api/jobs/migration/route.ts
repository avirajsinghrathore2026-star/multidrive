import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireOwnedFile, requireOwnedAccount, AuthError } from '@/lib/auth';
import { createOrReuseJob, acquireJobLease } from '@/lib/job-engine';
import { processMigrationJob } from '@/lib/jobs/migration-handler';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();
    const body = await request.json();
    const { fileId, destinationAccountId, idempotencyKey: clientKey } = body;

    if (!fileId || !destinationAccountId) {
      return NextResponse.json({ error: 'fileId and destinationAccountId are required' }, { status: 400 });
    }

    const fileRecord = await requireOwnedFile(supabase, user.id, fileId);
    await requireOwnedAccount(supabase, user.id, destinationAccountId);

    const idempotencyKey = clientKey || `idemp-job-migrate-${fileId}-${destinationAccountId}`;

    const { job, isReused } = await createOrReuseJob(supabase, 'migration_jobs', user.id, idempotencyKey, {
      file_record_id: fileId,
      source_account_id: fileRecord.connected_account_id,
      destination_account_id: destinationAccountId,
      source_provider_object_id: fileRecord.google_drive_file_id,
    });

    if (job.state === 'COMPLETED') {
      return NextResponse.json({ success: true, job, isReused: true });
    }

    const workerId = crypto.randomUUID();
    const leasedJob = await acquireJobLease(supabase, 'migration_jobs', job.id, workerId);

    if (!leasedJob) {
      return NextResponse.json({ success: true, job, isReused: true, message: 'Job leased by another worker' });
    }

    const completedJob = await processMigrationJob(job.id);
    return NextResponse.json({ success: true, job: completedJob, isReused });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('API Migration Job handler error:', err);
    return NextResponse.json({ error: err.message || 'Migration job processing failed' }, { status: 500 });
  }
}

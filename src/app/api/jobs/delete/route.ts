import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireOwnedFile, AuthError } from '@/lib/auth';
import { createOrReuseJob, acquireJobLease } from '@/lib/job-engine';
import { processDeleteJob } from '@/lib/jobs/delete-handler';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();
    const body = await request.json();
    const { fileId, idempotencyKey: clientKey } = body;

    if (!fileId) {
      return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
    }

    const fileRecord = await requireOwnedFile(supabase, user.id, fileId);
    const idempotencyKey = clientKey || `idemp-job-delete-${fileId}`;

    const { job, isReused } = await createOrReuseJob(supabase, 'delete_jobs', user.id, idempotencyKey, {
      file_record_id: fileId,
      provider_object_id: fileRecord.google_drive_file_id,
    });

    if (job.state === 'COMPLETED') {
      return NextResponse.json({ success: true, job, isReused: true });
    }

    const workerId = crypto.randomUUID();
    const leasedJob = await acquireJobLease(supabase, 'delete_jobs', job.id, workerId);

    if (!leasedJob) {
      return NextResponse.json({ success: true, job, isReused: true, message: 'Job leased by another worker' });
    }

    const completedJob = await processDeleteJob(job.id);
    return NextResponse.json({ success: true, job: completedJob, isReused });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('API Delete Job handler error:', err);
    return NextResponse.json({ error: err.message || 'Delete job processing failed' }, { status: 500 });
  }
}

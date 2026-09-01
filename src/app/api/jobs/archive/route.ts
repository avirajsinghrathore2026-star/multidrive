import { NextRequest, NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';
import { createOrReuseJob, acquireJobLease } from '@/lib/job-engine';
import { processArchiveJob } from '@/lib/jobs/archive-handler';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();
    const body = await request.json();
    const { fileIds, idempotencyKey: clientKey } = body;

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return NextResponse.json({ error: 'fileIds array is required' }, { status: 400 });
    }

    const sortedIds = [...fileIds].sort().join(',');
    const idempotencyKey = clientKey || `idemp-job-archive-${crypto.createHash('md5').update(sortedIds).digest('hex')}`;

    const { job, isReused } = await createOrReuseJob(supabase, 'archive_jobs', user.id, idempotencyKey, {
      file_record_ids: fileIds,
    });

    if (job.state === 'COMPLETED') {
      return NextResponse.json({ success: true, job, isReused: true });
    }

    const workerId = crypto.randomUUID();
    const leasedJob = await acquireJobLease(supabase, 'archive_jobs', job.id, workerId);

    if (!leasedJob) {
      return NextResponse.json({ success: true, job, isReused: true, message: 'Job leased by another worker' });
    }

    const completedJob = await processArchiveJob(job.id);
    return NextResponse.json({ success: true, job: completedJob, isReused });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('API Archive Job handler error:', err);
    return NextResponse.json({ error: err.message || 'Archive job processing failed' }, { status: 500 });
  }
}

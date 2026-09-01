import { NextRequest, NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';
import { createOrReuseJob, acquireJobLease } from '@/lib/job-engine';
import { processUploadJob } from '@/lib/jobs/upload-handler';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const clientKey = formData.get('idempotencyKey') as string | null;
    const expectedMd5 = formData.get('expectedMd5') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const idempotencyKey = clientKey || `idemp-job-upload-${crypto.randomUUID()}`;

    // Create or reuse upload job (§13)
    const { job, isReused } = await createOrReuseJob(supabase, 'upload_jobs', user.id, idempotencyKey, {
      size_bytes: file.size,
    });

    if (job.state === 'COMPLETED') {
      return NextResponse.json({ success: true, job, isReused: true });
    }

    // Acquire worker lease and process upload job
    const workerId = crypto.randomUUID();
    const leasedJob = await acquireJobLease(supabase, 'upload_jobs', job.id, workerId);

    if (!leasedJob) {
      return NextResponse.json({ success: true, job, isReused: true, message: 'Job leased by another worker' });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const completedJob = await processUploadJob(job.id, buffer, expectedMd5 || undefined);
    return NextResponse.json({ success: true, job: completedJob, isReused });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('API Upload Job handler error:', err);
    return NextResponse.json({ error: err.message || 'Upload job processing failed' }, { status: 500 });
  }
}

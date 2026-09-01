import { NextRequest, NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/server';
import { JobType } from '@/lib/job-engine';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { user } = await requireUser();
    const resolvedParams = await params;
    const jobId = resolvedParams.id;

    const searchParams = request.nextUrl.searchParams;
    const jobType = (searchParams.get('type') || 'upload_jobs') as JobType;

    const admin = await createAdminClient();
    const nowIso = new Date().toISOString();

    const { data: job, error: fetchErr } = await admin
      .from(jobType)
      .select('*')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .single();

    if (fetchErr || !job) {
      return NextResponse.json({ error: 'Job non-existent or access denied' }, { status: 404 });
    }

    if (job.state === 'COMPLETED') {
      return NextResponse.json(
        { error: 'CANCELLATION_REJECTED: Job has passed point of no return and is already COMPLETED' },
        { status: 400 }
      );
    }

    const { data: updatedJob, error: updateErr } = await admin
      .from(jobType)
      .update({
        cancel_requested_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', jobId)
      .select('*')
      .single();

    if (updateErr) {
      return NextResponse.json({ error: 'Failed to request job cancellation' }, { status: 500 });
    }

    return NextResponse.json({ success: true, job: updatedJob });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Job cancellation handler error:', err);
    return NextResponse.json({ error: 'Failed to request cancellation' }, { status: 500 });
  }
}

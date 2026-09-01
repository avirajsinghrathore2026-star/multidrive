import { NextRequest, NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/server';
import { JobType } from '@/lib/job-engine';

export async function GET(
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

    const { data: job, error } = await admin
      .from(jobType)
      .select('*')
      .eq('id', jobId)
      .eq('user_id', user.id)
      .single();

    if (error || !job) {
      return NextResponse.json({ error: 'Job non-existent or access denied' }, { status: 404 });
    }

    return NextResponse.json({ success: true, job });
  } catch (err: any) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Failed to query job status' }, { status: 500 });
  }
}

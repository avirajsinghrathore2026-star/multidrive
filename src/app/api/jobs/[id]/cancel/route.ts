import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { requestJobCancellation } from '@/lib/job-engine';
import { successResponse, errorResponse, handleApiError } from '@/lib/api-utils';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, adminSupabase } = await requireUser();
    const { id } = await params;

    const tables = ['upload_jobs', 'migration_jobs', 'delete_jobs', 'archive_jobs'] as const;

    for (const table of tables) {
      const { data: job } = await adminSupabase
        .from(table)
        .select('*')
        .eq('id', id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (job) {
        const updatedJob = await requestJobCancellation(adminSupabase, table, id, user.id);
        return successResponse({ job: updatedJob });
      }
    }

    return errorResponse('NOT_FOUND', `Job ${id} not found`, undefined, 404);
  } catch (err: any) {
    return handleApiError(err);
  }
}

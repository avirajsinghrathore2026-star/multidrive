import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { successResponse, errorResponse, handleApiError } from '@/lib/api-utils';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, supabase } = await requireUser();
    const { id } = await params;

    const tables = ['upload_jobs', 'migration_jobs', 'delete_jobs', 'archive_jobs'] as const;

    for (const table of tables) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq('id', id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (data) {
        return successResponse({ job: data, job_type: table });
      }
    }

    return errorResponse('NOT_FOUND', `Job ${id} not found`, undefined, 404);
  } catch (err: any) {
    return handleApiError(err);
  }
}

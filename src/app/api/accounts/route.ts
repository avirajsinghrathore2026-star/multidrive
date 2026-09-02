import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { successResponse, handleApiError } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();

    const { data, error } = await adminSupabase
      .from('connected_accounts')
      .select('id, user_id, google_email, storage_used_bytes, storage_total_bytes, quota_last_checked_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return successResponse({ accounts: data });
  } catch (err: any) {
    return handleApiError(err);
  }
}

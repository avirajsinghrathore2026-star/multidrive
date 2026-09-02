import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { successResponse, handleApiError } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();

    // 1. Primary Query: Fetch accounts matching authenticated user_id
    const { data: accounts, error } = await adminSupabase
      .from('connected_accounts')
      .select('id, user_id, google_email, storage_used_bytes, storage_total_bytes, quota_last_checked_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    let finalAccounts = accounts || [];

    // 2. Resilient Fallback: If 0 accounts found for user_id but user.email exists, claim matching google_email accounts
    if (finalAccounts.length === 0 && user.email) {
      const { data: matchingAccounts } = await adminSupabase
        .from('connected_accounts')
        .select('id, user_id, google_email, storage_used_bytes, storage_total_bytes, quota_last_checked_at, created_at')
        .eq('google_email', user.email)
        .order('created_at', { ascending: true });

      if (matchingAccounts && matchingAccounts.length > 0) {
        // Auto-rebind accounts to active user.id
        await adminSupabase
          .from('connected_accounts')
          .update({ user_id: user.id })
          .eq('google_email', user.email);

        finalAccounts = matchingAccounts;
      }
    }

    return successResponse({ accounts: finalAccounts });
  } catch (err: any) {
    return handleApiError(err);
  }
}

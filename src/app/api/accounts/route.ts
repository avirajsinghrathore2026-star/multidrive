import { NextRequest } from 'next/server';
import { requireUser, requireOwnedAccount } from '@/lib/auth';
import { successResponse, errorResponse, handleApiError } from '@/lib/api-utils';
import { decryptToken } from '@/lib/vault';
import { fetchGoogleAccountDetails, revokeGoogleToken } from '@/lib/google-drive';

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

/**
 * POST /api/accounts: Force live refresh of storage quotas across all connected Google Drive accounts
 */
export async function POST(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();
    const { data: accounts, error } = await adminSupabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', user.id);

    if (error) throw error;

    const updatedAccounts = [];

    for (const account of accounts || []) {
      try {
        const refreshToken = decryptToken(account.vault_secret_id);
        const details = await fetchGoogleAccountDetails(refreshToken);

        const { data: updated, error: updateErr } = await adminSupabase
          .from('connected_accounts')
          .update({
            storage_used_bytes: details.storageUsedBytes,
            storage_total_bytes: details.storageTotalBytes,
            quota_last_checked_at: new Date().toISOString(),
          })
          .eq('id', account.id)
          .select('id, user_id, google_email, storage_used_bytes, storage_total_bytes, quota_last_checked_at, created_at')
          .single();

        if (!updateErr && updated) {
          updatedAccounts.push(updated);
        } else {
          updatedAccounts.push(account);
        }
      } catch (accErr) {
        console.error(`Failed to refresh quota for account ${account.id}:`, accErr);
        updatedAccounts.push(account);
      }
    }

    return successResponse({ accounts: updatedAccounts });
  } catch (err: any) {
    return handleApiError(err);
  }
}

/**
 * DELETE /api/accounts?id=accountId: Disconnect connected account and revoke OAuth token
 */
export async function DELETE(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();
    const accountId = request.nextUrl.searchParams.get('id');

    if (!accountId) {
      return errorResponse('INVALID_ARGUMENT', 'Account ID parameter "id" required', undefined, 400);
    }

    const account = await requireOwnedAccount(adminSupabase, user.id, accountId);

    // Revoke OAuth access token on Google Drive
    try {
      const refreshToken = decryptToken(account.vault_secret_id);
      await revokeGoogleToken(refreshToken);
    } catch (revokeErr) {
      console.error('Warning: Failed to revoke token on Google Drive API:', revokeErr);
    }

    // Delete connected account row
    const { error: deleteErr } = await adminSupabase
      .from('connected_accounts')
      .delete()
      .eq('id', accountId)
      .eq('user_id', user.id);

    if (deleteErr) throw deleteErr;

    return successResponse({ success: true, message: 'Google account disconnected successfully' });
  } catch (err: any) {
    return handleApiError(err);
  }
}

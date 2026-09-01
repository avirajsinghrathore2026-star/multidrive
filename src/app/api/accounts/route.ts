import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireOwnedAccount, AuthError } from '@/lib/auth';
import { fetchGoogleAccountDetails, revokeGoogleToken } from '@/lib/google-drive';
import { decryptToken } from '@/lib/vault';

export async function GET() {
  try {
    const { user, supabase } = await requireUser();

    const { data: accounts, error } = await supabase
      .from('connected_accounts')
      .select('id, google_email, storage_used_bytes, storage_total_bytes, quota_last_checked_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch connected accounts:', error);
      return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
    }

    return NextResponse.json({ accounts: accounts || [] });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST() {
  try {
    const { user, supabase } = await requireUser();

    const { data: accounts, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', user.id);

    if (error || !accounts) {
      return NextResponse.json({ error: 'Failed to fetch accounts for quota refresh' }, { status: 500 });
    }

    const updatedAccounts = [];

    for (const account of accounts) {
      try {
        const refreshToken = decryptToken(account.vault_secret_id);
        const details = await fetchGoogleAccountDetails(refreshToken);

        const { data: updated } = await supabase
          .from('connected_accounts')
          .update({
            storage_used_bytes: details.storageUsedBytes,
            storage_total_bytes: details.storageTotalBytes,
            quota_last_checked_at: new Date().toISOString(),
          })
          .eq('id', account.id)
          .eq('user_id', user.id)
          .select()
          .single();

        if (updated) updatedAccounts.push(updated);
      } catch (refreshErr) {
        console.error(`Failed to refresh quota for account ${account.id}:`, refreshErr);
      }
    }

    return NextResponse.json({ success: true, accounts: updatedAccounts });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// DELETE /api/accounts - Disconnect Google Account with RESTRICT integrity check (ISSUE-04)
export async function DELETE(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();
    const searchParams = request.nextUrl.searchParams;
    const accountId = searchParams.get('id');

    if (!accountId) {
      return NextResponse.json({ error: 'Account ID is required' }, { status: 400 });
    }

    const account = await requireOwnedAccount(supabase, user.id, accountId);

    // Check if active file records reference this connected account
    const { count: fileCount } = await supabase
      .from('file_records')
      .select('id', { count: 'exact', head: true })
      .eq('connected_account_id', accountId)
      .eq('user_id', user.id);

    if (fileCount && fileCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot disconnect account containing ${fileCount} active files. Please delete or move those files first to prevent data loss.`,
        },
        { status: 400 }
      );
    }

    // Revoke token with Google
    try {
      const refreshToken = decryptToken(account.vault_secret_id);
      await revokeGoogleToken(refreshToken);
    } catch (revokeErr) {
      console.error('Failed to revoke Google token during disconnect:', revokeErr);
    }

    // Delete connected account from database (RESTRICT enforced at DB level)
    const { error: dbError } = await supabase
      .from('connected_accounts')
      .delete()
      .eq('id', accountId)
      .eq('user_id', user.id);

    if (dbError) {
      console.error('Failed to delete connected account from DB:', dbError);
      return NextResponse.json({ error: 'Failed to disconnect account' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Account disconnect error:', err);
    return NextResponse.json({ error: 'Failed to disconnect account' }, { status: 500 });
  }
}

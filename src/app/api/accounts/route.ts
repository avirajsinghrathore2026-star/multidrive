import { NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';
import { fetchGoogleAccountDetails } from '@/lib/google-drive';
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

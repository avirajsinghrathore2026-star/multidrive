import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/vault';
import { fetchGoogleAccountDetails } from '@/lib/google-drive';

// GET /api/accounts - List all connected accounts sorted by fullness (fullest first)
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    let query = supabase.from('connected_accounts').select('*');
    if (user) {
      query = query.eq('user_id', user.id);
    }

    const { data: accounts, error } = await query;

    if (error) {
      console.error('Error fetching accounts:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Sort accounts by fill percentage descending (fullest first)
    const sorted = (accounts || []).sort((a, b) => {
      const ratioA = a.storage_total_bytes > 0 ? a.storage_used_bytes / a.storage_total_bytes : 0;
      const ratioB = b.storage_total_bytes > 0 ? b.storage_used_bytes / b.storage_total_bytes : 0;
      return ratioB - ratioA;
    });

    return NextResponse.json({ accounts: sorted });
  } catch (err) {
    console.error('Accounts GET error:', err);
    return NextResponse.json({ error: 'Failed to retrieve accounts' }, { status: 500 });
  }
}

// POST /api/accounts/refresh - Refresh storage quotas across accounts
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { accountId } = body;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    let query = supabase.from('connected_accounts').select('*');
    if (accountId) {
      query = query.eq('id', accountId);
    } else if (user) {
      query = query.eq('user_id', user.id);
    }

    const { data: accounts, error } = await query;
    if (error || !accounts) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const updated = [];
    for (const acc of accounts) {
      try {
        const refreshToken = decryptToken(acc.vault_secret_id);
        const details = await fetchGoogleAccountDetails(refreshToken);

        const { data: updatedAcc } = await supabase
          .from('connected_accounts')
          .update({
            storage_used_bytes: details.storageUsedBytes,
            storage_total_bytes: details.storageTotalBytes,
            quota_last_checked_at: new Date().toISOString(),
          })
          .eq('id', acc.id)
          .select()
          .single();

        if (updatedAcc) updated.push(updatedAcc);
      } catch (refreshErr) {
        console.error(`Quota refresh failed for account ${acc.id}:`, refreshErr);
      }
    }

    return NextResponse.json({ success: true, refreshed: updated.length });
  } catch (err) {
    console.error('Account refresh error:', err);
    return NextResponse.json({ error: 'Failed to refresh account quota' }, { status: 500 });
  }
}

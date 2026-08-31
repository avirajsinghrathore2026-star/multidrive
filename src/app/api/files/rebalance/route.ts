import { NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';

export async function POST() {
  try {
    const { user, supabase } = await requireUser();

    const { data: accounts, error: accErr } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', user.id);

    if (accErr || !accounts || accounts.length < 2) {
      return NextResponse.json(
        { error: 'At least 2 connected Google accounts are required for storage rebalancing' },
        { status: 400 }
      );
    }

    const { data: files, error: fileErr } = await supabase
      .from('file_records')
      .select('*')
      .eq('user_id', user.id)
      .eq('in_trash', false);

    if (fileErr || !files) {
      return NextResponse.json({ error: 'Failed to fetch files for rebalance calculation' }, { status: 500 });
    }

    const accountStats = accounts.map((acc) => {
      const used = BigInt(acc.storage_used_bytes);
      const total = BigInt(acc.storage_total_bytes);
      const percent = total > BigInt(0) ? Number((used * BigInt(100)) / total) : 0;
      return {
        ...acc,
        used,
        total,
        percent,
      };
    });

    const fullAccounts = accountStats.filter((a) => a.percent >= 85);
    const healthyAccounts = accountStats.filter((a) => a.percent < 70);

    if (fullAccounts.length === 0) {
      return NextResponse.json({
        message: 'Storage distribution is balanced. No accounts exceeded 85% capacity threshold.',
        rebalancedCount: 0,
      });
    }

    return NextResponse.json({
      message: `Rebalance analysis complete: ${fullAccounts.length} full account(s) detected, ${healthyAccounts.length} candidate account(s) available.`,
      rebalancedCount: 0,
      fullAccountsCount: fullAccounts.length,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Storage rebalancing failed' }, { status: 500 });
  }
}

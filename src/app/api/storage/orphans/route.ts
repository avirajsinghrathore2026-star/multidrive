import { NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';
import { reclaimOrphanObjects } from '@/lib/storage-engine';

export async function POST() {
  try {
    const { supabase } = await requireUser();

    const result = await reclaimOrphanObjects(supabase);

    return NextResponse.json({
      success: true,
      message: `Identified and flagged ${result.orphanCount} orphaned storage objects.`,
      orphanCount: result.orphanCount,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Orphan object sweep error:', err);
    return NextResponse.json({ error: 'Failed to run orphan object sweep' }, { status: 500 });
  }
}

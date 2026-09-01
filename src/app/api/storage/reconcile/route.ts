import { NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';
import { reconcileExpiredReservations } from '@/lib/storage-engine';

export async function POST() {
  try {
    const { supabase } = await requireUser();

    const result = await reconcileExpiredReservations(supabase);

    return NextResponse.json({
      success: true,
      message: `Reconciled ${result.reclaimedCount} expired storage reservations.`,
      reclaimedCount: result.reclaimedCount,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Reservation reconciliation sweep error:', err);
    return NextResponse.json({ error: 'Failed to run reservation reconciliation sweep' }, { status: 500 });
  }
}

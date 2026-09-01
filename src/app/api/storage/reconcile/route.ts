import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { runReconciliationSweep } from '@/lib/jobs/reconciliation-sweep';
import { successResponse, handleApiError } from '@/lib/api-utils';

export async function POST(request: NextRequest) {
  try {
    await requireUser();
    const results = await runReconciliationSweep();
    return successResponse({ summary: results });
  } catch (err: any) {
    return handleApiError(err);
  }
}

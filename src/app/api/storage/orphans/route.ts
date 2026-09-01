import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { detectOrphanedObjects } from '@/lib/storage-engine';
import { successResponse, handleApiError } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();
    const count = await detectOrphanedObjects(supabase, user.id);
    return successResponse({ count, message: `Detected ${count} orphaned file record(s)` });
  } catch (err: any) {
    return handleApiError(err);
  }
}

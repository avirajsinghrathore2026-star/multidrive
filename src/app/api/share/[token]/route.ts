import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { successResponse, errorResponse, handleApiError } from '@/lib/api-utils';

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const admin = await createAdminClient();

    const { data: link, error } = await admin
      .from('shared_links')
      .select('*, file_records(*)')
      .eq('token', token)
      .maybeSingle();

    if (error || !link) {
      return errorResponse('NOT_FOUND', 'Shared link not found or expired', undefined, 404);
    }

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return errorResponse('GONE', 'Shared link has expired', undefined, 410);
    }

    return successResponse({ file: link.file_records, isPasswordProtected: Boolean(link.password_hash) });
  } catch (err: any) {
    return handleApiError(err);
  }
}

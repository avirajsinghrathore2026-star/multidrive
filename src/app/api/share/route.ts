import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile } from '@/lib/auth';
import { successResponse, errorResponse, handleApiError, parseAndValidateJson, checkRateLimit } from '@/lib/api-utils';
import { ShareLinkSchema } from '@/lib/schemas/api-schemas';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();

    // Rate Limiting Check
    const rateLimit = await checkRateLimit(`share_link:${user.id}`, 20, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Share link creation rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const validated = await parseAndValidateJson(request, ShareLinkSchema);

    // Fail Fast API Authorization Check (§7)
    await requireOwnedFile(adminSupabase, user.id, validated.fileId);

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = validated.expiresInHours
      ? new Date(Date.now() + validated.expiresInHours * 3600 * 1000).toISOString()
      : null;

    const { data, error } = await adminSupabase
      .from('shared_links')
      .insert({
        file_id: validated.fileId,
        token,
        password_hash: validated.password ? crypto.createHash('sha256').update(validated.password).digest('hex') : null,
        expires_at: expiresAt,
      })
      .select('*')
      .single();

    if (error) throw error;

    return successResponse({ shareLink: data, url: `${process.env.NEXT_PUBLIC_APP_URL || ''}/api/share/${token}` }, 201);
  } catch (err: any) {
    return handleApiError(err);
  }
}

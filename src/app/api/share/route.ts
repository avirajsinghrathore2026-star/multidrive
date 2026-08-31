import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireUser, requireOwnedFile, AuthError } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();
    const body = await request.json();
    const { fileId, durationHours = 24, password } = body;

    if (!fileId) {
      return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
    }

    // Verify file ownership strictly
    await requireOwnedFile(supabase, user.id, fileId);

    // Generate random secure token
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + durationHours * 3600 * 1000).toISOString();

    let passwordHash: string | null = null;
    if (password && password.trim()) {
      passwordHash = crypto.createHash('sha256').update(password.trim()).digest('hex');
    }

    const { error: linkErr } = await supabase
      .from('shared_links')
      .insert({
        file_id: fileId,
        token,
        expires_at: expiresAt,
        password_hash: passwordHash,
      });

    if (linkErr) {
      console.error('Failed to create shared link:', linkErr);
      return NextResponse.json({ error: 'Failed to create share link' }, { status: 500 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const publicUrl = `${appUrl}/api/share/${token}`;

    return NextResponse.json({
      success: true,
      token,
      publicUrl,
      expiresAt,
      hasPassword: !!passwordHash,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Create share link error:', err);
    return NextResponse.json({ error: 'Failed to create share link' }, { status: 500 });
  }
}

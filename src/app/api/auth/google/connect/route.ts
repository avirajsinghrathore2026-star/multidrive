import { NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';
import { generateAuthUrl } from '@/lib/google-drive';
import { encryptToken } from '@/lib/vault';
import { cookies } from 'next/headers';

export async function GET() {
  try {
    const { user } = await requireUser();

    // Generate cryptographic state payload bound to this user
    const statePayload = JSON.stringify({
      userId: user.id,
      nonce: crypto.randomUUID(),
      createdAt: Date.now(),
    });

    const encryptedState = encryptToken(statePayload);

    // Generate Google OAuth consent URL with state
    const authUrl = generateAuthUrl(encryptedState);

    const response = NextResponse.redirect(authUrl);

    // Store state in HTTP-Only secure cookie for 10-minute callback validation
    const cookieStore = await cookies();
    cookieStore.set('md_oauth_state', encryptedState, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/auth/google',
      maxAge: 600, // 10 minutes
    });

    return response;
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Failed to initiate Google OAuth:', err);
    return NextResponse.json({ error: 'Failed to initiate Google OAuth' }, { status: 500 });
  }
}

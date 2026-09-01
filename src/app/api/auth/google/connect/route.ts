import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { generateAuthUrl } from '@/lib/google-drive';
import { encryptToken } from '@/lib/vault';
import { getServerConfig } from '@/lib/config';
import crypto from 'crypto';

export async function GET() {
  let appUrl = 'http://localhost:3000';
  try {
    appUrl = getServerConfig().appUrl;
  } catch {
    // Fallback if config validation fails during error redirect
  }

  try {
    // 1. Enforce authenticated MultiDrive user session
    const { user } = await requireUser();

    // 2. Generate cryptographic state payload bound to this user
    const statePayload = JSON.stringify({
      userId: user.id,
      nonce: crypto.randomUUID(),
      createdAt: Date.now(),
    });

    const encryptedState = encryptToken(statePayload);

    // 3. Generate Google OAuth consent URL with state
    const authUrl = generateAuthUrl(encryptedState);

    // 4. Construct redirect response and attach state cookie directly to response
    const response = NextResponse.redirect(authUrl);

    response.cookies.set('md_oauth_state', encryptedState, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600, // 10 minutes
    });

    return response;
  } catch (err) {
    console.error('Failed to initiate Google OAuth:', err instanceof Error ? err.message : 'Unknown error');
    // Redirect cleanly to app homepage with error param instead of showing black JSON screen
    return NextResponse.redirect(`${appUrl}?error=unauthenticated`);
  }
}

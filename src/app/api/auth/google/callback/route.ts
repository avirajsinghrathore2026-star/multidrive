import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getOAuth2Client, fetchGoogleAccountDetails } from '@/lib/google-drive';
import { encryptToken, decryptToken } from '@/lib/vault';
import { cookies } from 'next/headers';

// In-memory cache for atomic single-use OAuth state replay protection during server lifecycle
const consumedOAuthStates = new Set<string>();

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const stateParam = searchParams.get('state');

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  if (error || !code || !stateParam) {
    console.error('Google OAuth error or missing parameters:', { error, hasCode: !!code, hasState: !!stateParam });
    return NextResponse.redirect(`${appUrl}?error=oauth_invalid_request`);
  }

  // Single-use Replay Protection: Check if state was already consumed
  if (consumedOAuthStates.has(stateParam)) {
    console.error('Replayed OAuth state detected in memory cache:', stateParam);
    return NextResponse.redirect(`${appUrl}?error=oauth_state_replayed`);
  }

  try {
    // 1. Enforce authenticated MultiDrive user session
    const { user, supabase } = await requireUser();

    // 2. Validate OAuth state cookie & match URL parameter
    const cookieStore = await cookies();
    const cookieState = cookieStore.get('md_oauth_state')?.value;

    if (!cookieState || cookieState !== stateParam) {
      console.error('OAuth state mismatch or missing state cookie');
      return NextResponse.redirect(`${appUrl}?error=oauth_state_mismatch`);
    }

    // Immediately delete state cookie to enforce single-use replay prevention
    cookieStore.delete('md_oauth_state');
    consumedOAuthStates.add(stateParam);

    // Limit memory cache size to prevent leak over long server uptimes
    if (consumedOAuthStates.size > 1000) {
      const firstItem = consumedOAuthStates.values().next().value;
      if (firstItem) consumedOAuthStates.delete(firstItem);
    }

    // Decrypt and verify state payload
    const decryptedPayload = decryptToken(stateParam);
    const parsedState = JSON.parse(decryptedPayload);

    if (parsedState.userId !== user.id) {
      console.error('OAuth state user_id mismatch:', { stateUser: parsedState.userId, currentUser: user.id });
      return NextResponse.redirect(`${appUrl}?error=oauth_user_mismatch`);
    }

    // Check state expiration (10 minutes max)
    if (Date.now() - parsedState.createdAt > 600000) {
      console.error('OAuth state expired');
      return NextResponse.redirect(`${appUrl}?error=oauth_state_expired`);
    }

    // 3. Exchange authorization code for Google tokens
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    const refreshToken = tokens.refresh_token || tokens.access_token || '';
    const details = await fetchGoogleAccountDetails(refreshToken);
    const encryptedSecret = encryptToken(refreshToken);

    // 4. Save or update connected account bound strictly to user.id
    const { data: existingAccounts } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('google_email', details.email)
      .eq('user_id', user.id);

    if (existingAccounts && existingAccounts.length > 0) {
      const { error: updateError } = await supabase
        .from('connected_accounts')
        .update({
          vault_secret_id: encryptedSecret,
          storage_used_bytes: details.storageUsedBytes,
          storage_total_bytes: details.storageTotalBytes,
          quota_last_checked_at: new Date().toISOString(),
        })
        .eq('id', existingAccounts[0].id)
        .eq('user_id', user.id);

      if (updateError) {
        console.error('Failed to update connected account in DB:', updateError);
        return NextResponse.redirect(`${appUrl}?error=db_update_failed`);
      }
    } else {
      const { error: dbError } = await supabase.from('connected_accounts').insert({
        user_id: user.id,
        google_email: details.email,
        vault_secret_id: encryptedSecret,
        storage_used_bytes: details.storageUsedBytes,
        storage_total_bytes: details.storageTotalBytes,
        quota_last_checked_at: new Date().toISOString(),
      });

      if (dbError) {
        console.error('Failed to insert connected account into DB:', dbError);
        return NextResponse.redirect(`${appUrl}?error=db_insert_failed`);
      }
    }

    return NextResponse.redirect(`${appUrl}?connected=true&email=${encodeURIComponent(details.email)}`);
  } catch (err) {
    console.error('Failed to process Google OAuth callback:', err);
    return NextResponse.redirect(`${appUrl}?error=oauth_failed`);
  }
}

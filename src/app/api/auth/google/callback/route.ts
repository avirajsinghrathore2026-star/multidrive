import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getOAuth2Client, fetchGoogleAccountDetails } from '@/lib/google-drive';
import { encryptToken, decryptToken } from '@/lib/vault';
import { getServerConfig } from '@/lib/config';
import { cookies } from 'next/headers';

// In-memory cache for atomic single-use OAuth state replay protection during server lifecycle
const consumedOAuthStates = new Set<string>();

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const stateParam = searchParams.get('state');

  let appUrl = request.nextUrl.origin || 'http://localhost:3000';
  try {
    appUrl = getServerConfig().appUrl;
  } catch {
    // Fallback if config validation fails during error redirect
  }
  const dashboardUrl = `${appUrl}/dashboard`;

  if (error || !code || !stateParam) {
    console.error('Google OAuth callback failed: Missing required parameters or OAuth consent error');
    return NextResponse.redirect(`${appUrl}?error=oauth_invalid_request`);
  }

  // Single-use Replay Protection: Check if state was already consumed
  if (consumedOAuthStates.has(stateParam)) {
    console.error('OAuth callback failed: Replayed OAuth state detected');
    return NextResponse.redirect(`${appUrl}?error=oauth_state_replayed`);
  }

  try {
    // 1. Enforce authenticated MultiDrive user session
    const { user, supabase } = await requireUser();

    // 2. Validate OAuth state cookie & match URL parameter
    const cookieStore = await cookies();
    const cookieState = cookieStore.get('md_oauth_state')?.value;

    if (!cookieState || cookieState !== stateParam) {
      console.error('OAuth callback failed: State cookie mismatch or state missing');
      return NextResponse.redirect(`${appUrl}?error=oauth_state_mismatch`);
    }

    // Immediately delete state cookie & register in consumed cache to enforce single-use replay prevention
    cookieStore.set('md_oauth_state', '', { path: '/', maxAge: 0 });
    consumedOAuthStates.add(stateParam);

    if (consumedOAuthStates.size > 1000) {
      const firstItem = consumedOAuthStates.values().next().value;
      if (firstItem) consumedOAuthStates.delete(firstItem);
    }

    // Decrypt and verify state payload
    const decryptedPayload = decryptToken(stateParam);
    const parsedState = JSON.parse(decryptedPayload);

    if (parsedState.userId !== user.id) {
      console.error('OAuth callback failed: Initiating user_id mismatch');
      return NextResponse.redirect(`${appUrl}?error=oauth_user_mismatch`);
    }

    // Check state expiration (10 minutes max)
    if (Date.now() - parsedState.createdAt > 600000) {
      console.error('OAuth callback failed: State expired');
      return NextResponse.redirect(`${appUrl}?error=oauth_state_expired`);
    }

    // 3. Exchange authorization code for Google tokens
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    const newRefreshToken = tokens.refresh_token || null;

    // Temporarily fetch account details using new refresh token or access token
    const tempToken = newRefreshToken || tokens.access_token || '';
    if (!tempToken) {
      console.error('OAuth callback failed: No valid tokens returned by Google');
      return NextResponse.redirect(`${appUrl}?error=oauth_token_error`);
    }

    const details = await fetchGoogleAccountDetails(tempToken);

    // 4. Query existing connected account for this user and email/googleAccountId
    const { data: existingAccounts } = await supabase
      .from('connected_accounts')
      .select('id, vault_secret_id')
      .eq('google_email', details.email)
      .eq('user_id', user.id);

    const existingAccount = existingAccounts && existingAccounts.length > 0 ? existingAccounts[0] : null;

    // Rule 3: Never substitute an access token for a refresh token!
    let targetVaultSecretId: string;

    if (newRefreshToken) {
      // Case A: Google supplied a new refresh token -> Encrypt and store it
      targetVaultSecretId = encryptToken(newRefreshToken);
    } else if (existingAccount) {
      // Case B: Google omitted refresh_token on re-authorization -> Retain existing valid refresh token!
      targetVaultSecretId = existingAccount.vault_secret_id;
    } else {
      // Case C: Initial connection and Google omitted refresh_token -> Fail safely!
      console.error('OAuth callback failed: Google omitted refresh_token on initial connection');
      return NextResponse.redirect(`${appUrl}?error=oauth_no_refresh_token`);
    }

    // 5. Save or update connected account bound strictly to user.id with google_account_id (ISSUE-06)
    if (existingAccount) {
      const { error: updateError } = await supabase
        .from('connected_accounts')
        .update({
          google_account_id: details.googleAccountId,
          vault_secret_id: targetVaultSecretId,
          storage_used_bytes: details.storageUsedBytes,
          storage_total_bytes: details.storageTotalBytes,
          quota_last_checked_at: new Date().toISOString(),
        })
        .eq('id', existingAccount.id)
        .eq('user_id', user.id);

      if (updateError) {
        console.error('Failed to update connected account in DB');
        return NextResponse.redirect(`${appUrl}?error=db_update_failed`);
      }
    } else {
      const { error: dbError } = await supabase.from('connected_accounts').insert({
        user_id: user.id,
        google_email: details.email,
        google_account_id: details.googleAccountId,
        vault_secret_id: targetVaultSecretId,
        storage_used_bytes: details.storageUsedBytes,
        storage_total_bytes: details.storageTotalBytes,
        quota_last_checked_at: new Date().toISOString(),
      });

      if (dbError) {
        console.error('Failed to insert connected account into DB:', dbError);
        return NextResponse.redirect(`${appUrl}?error=db_insert_failed`);
      }
    }

    return NextResponse.redirect(`${dashboardUrl}?connected=true&email=${encodeURIComponent(details.email)}`);
  } catch (err) {
    console.error('Failed to process Google OAuth callback:', err instanceof Error ? err.message : 'Unknown error');
    return NextResponse.redirect(`${dashboardUrl}?error=oauth_failed`);
  }
}

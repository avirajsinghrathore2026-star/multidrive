import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getOAuth2Client, fetchGoogleAccountDetails } from '@/lib/google-drive';
import { encryptToken, decryptToken } from '@/lib/vault';
import { getServerConfig } from '@/lib/config';
import { createAdminClient } from '@/lib/supabase/server';
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
    // 1. Decrypt and verify state payload cryptographically (AES-256-GCM authenticated)
    let parsedState: { userId: string; nonce: string; createdAt: number };
    try {
      const decryptedPayload = decryptToken(stateParam);
      parsedState = JSON.parse(decryptedPayload);
    } catch (decryptErr) {
      console.error('OAuth callback failed: Invalid or tampered state token:', decryptErr);
      return NextResponse.redirect(`${dashboardUrl}?error=oauth_state_invalid`);
    }

    if (!parsedState.userId) {
      console.error('OAuth callback failed: Missing userId in state payload');
      return NextResponse.redirect(`${dashboardUrl}?error=oauth_state_invalid`);
    }

    // Single-use Replay Protection
    consumedOAuthStates.add(stateParam);
    if (consumedOAuthStates.size > 1000) {
      const firstItem = consumedOAuthStates.values().next().value;
      if (firstItem) consumedOAuthStates.delete(firstItem);
    }

    // Check state expiration (10 minutes max)
    if (Date.now() - parsedState.createdAt > 600000) {
      console.error('OAuth callback failed: State expired');
      return NextResponse.redirect(`${dashboardUrl}?error=oauth_state_expired`);
    }

    const targetUserId = parsedState.userId;

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

    // 4. Query existing connected account for this user using admin client to prevent RLS cookie loss during cross-site redirect
    const adminSupabase = await createAdminClient();

    const { data: existingAccounts } = await adminSupabase
      .from('connected_accounts')
      .select('id, vault_secret_id')
      .eq('google_email', details.email)
      .eq('user_id', targetUserId);

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
      return NextResponse.redirect(`${dashboardUrl}?error=oauth_no_refresh_token`);
    }

    // 5. Save or update connected account bound strictly to user_id
    if (existingAccount) {
      const { error: updateError } = await adminSupabase
        .from('connected_accounts')
        .update({
          google_account_id: details.googleAccountId,
          vault_secret_id: targetVaultSecretId,
          storage_used_bytes: details.storageUsedBytes,
          storage_total_bytes: details.storageTotalBytes,
          quota_last_checked_at: new Date().toISOString(),
        })
        .eq('id', existingAccount.id)
        .eq('user_id', targetUserId);

      if (updateError) {
        console.error('Failed to update connected account in DB:', updateError);
        return NextResponse.redirect(`${dashboardUrl}?error=db_update_failed`);
      }
    } else {
      // Primary insert attempt (with google_account_id)
      let insertObj: Record<string, any> = {
        user_id: targetUserId,
        google_email: details.email,
        google_account_id: details.googleAccountId,
        vault_secret_id: targetVaultSecretId,
        storage_used_bytes: details.storageUsedBytes,
        storage_total_bytes: details.storageTotalBytes,
        quota_last_checked_at: new Date().toISOString(),
      };

      let { error: dbError } = await adminSupabase.from('connected_accounts').insert(insertObj);

      // Fallback insert attempt (without google_account_id if column does not exist in live schema)
      if (dbError && (dbError.message?.includes('google_account_id') || dbError.code === 'PGRST204')) {
        delete insertObj.google_account_id;
        const fallbackRes = await adminSupabase.from('connected_accounts').insert(insertObj);
        dbError = fallbackRes.error;
      }

      if (dbError) {
        console.error('Failed to insert connected account into DB:', dbError);
        return NextResponse.redirect(`${dashboardUrl}?error=${encodeURIComponent(`db_insert_failed: ${dbError.message || dbError.details || 'Schema conflict'}`)}`);
      }
    }

    return NextResponse.redirect(`${dashboardUrl}?connected=true&email=${encodeURIComponent(details.email)}`);
  } catch (err) {
    console.error('Failed to process Google OAuth callback:', err instanceof Error ? err.message : 'Unknown error');
    return NextResponse.redirect(`${dashboardUrl}?error=oauth_failed`);
  }
}

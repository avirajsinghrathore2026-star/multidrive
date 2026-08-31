import { NextRequest, NextResponse } from 'next/server';
import { getOAuth2Client, fetchGoogleAccountDetails } from '@/lib/google-drive';
import { encryptToken } from '@/lib/vault';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  if (error || !code) {
    console.error('Google OAuth error or missing code:', error);
    return NextResponse.redirect(`${appUrl}?error=oauth_cancelled`);
  }

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      // Re-prompt user if refresh token wasn't returned
      console.warn('No refresh token returned by Google OAuth');
    }

    const refreshToken = tokens.refresh_token || tokens.access_token || '';
    const details = await fetchGoogleAccountDetails(refreshToken);

    const encryptedSecret = encryptToken(refreshToken);

    // Save or update connected account
    const userId = user?.id || null;

    // Check if account already exists for this email
    let query = supabase.from('connected_accounts').select('id').eq('google_email', details.email);
    if (userId) {
      query = query.eq('user_id', userId);
    } else {
      query = query.is('user_id', null);
    }

    const { data: existingAccounts } = await query;

    if (existingAccounts && existingAccounts.length > 0) {
      // Update existing account details and refresh token
      await supabase
        .from('connected_accounts')
        .update({
          vault_secret_id: encryptedSecret,
          storage_used_bytes: details.storageUsedBytes,
          storage_total_bytes: details.storageTotalBytes,
          quota_last_checked_at: new Date().toISOString(),
        })
        .eq('id', existingAccounts[0].id);
    } else {
      // Insert new connected account
      const { error: dbError } = await supabase.from('connected_accounts').insert({
        user_id: userId,
        google_email: details.email,
        vault_secret_id: encryptedSecret,
        storage_used_bytes: details.storageUsedBytes,
        storage_total_bytes: details.storageTotalBytes,
        quota_last_checked_at: new Date().toISOString(),
      });

      if (dbError) {
        console.error('Failed to insert connected account into DB:', dbError);
      }
    }

    return NextResponse.redirect(`${appUrl}?connected=true&email=${encodeURIComponent(details.email)}`);
  } catch (err) {
    console.error('Failed to process Google OAuth callback:', err);
    return NextResponse.redirect(`${appUrl}?error=oauth_failed`);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/vault';
import { getDriveFileStream } from '@/lib/google-drive';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const searchParams = request.nextUrl.searchParams;
    const providedPassword = searchParams.get('pwd');

    const supabase = await createClient();

    // 1. Fetch shared link record
    const { data: link, error } = await supabase
      .from('shared_links')
      .select('*, file_records(*, connected_accounts(*))')
      .eq('token', token)
      .single();

    if (error || !link) {
      return new NextResponse('Shared link not found or invalid.', { status: 404 });
    }

    // 2. Check Expiration
    if (new Date(link.expires_at).getTime() < Date.now()) {
      return new NextResponse('This share link has expired.', { status: 410 });
    }

    // 3. Check Password Protection
    if (link.password_hash) {
      if (!providedPassword) {
        return new NextResponse(
          '<html><body style="font-family:sans-serif;background:#020617;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><form method="GET" style="background:#0f172a;padding:24px;border-radius:12px;border:1px solid #334155;text-align:center;"><h3 style="margin-top:0;">Protected File</h3><p style="font-size:12px;color:#94a3b8;">Password required to download this file</p><input type="password" name="pwd" placeholder="Enter Password" required style="padding:8px 12px;border-radius:6px;border:1px solid #334155;background:#020617;color:#fff;margin-bottom:12px;width:200px;"><br/><button type="submit" style="background:#4f46e5;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;">Download</button></form></body></html>',
          { headers: { 'Content-Type': 'text/html' } }
        );
      }

      const inputHash = crypto.createHash('sha256').update(providedPassword.trim()).digest('hex');
      if (inputHash !== link.password_hash) {
        return new NextResponse('Incorrect password for shared file.', { status: 403 });
      }
    }

    // 4. Stream file from Google Drive
    const file = link.file_records;
    const account = file.connected_accounts;
    const refreshToken = decryptToken(account.vault_secret_id);

    const stream = await getDriveFileStream(refreshToken, file.google_drive_file_id);

    // Increment view/download count
    await supabase.from('shared_links').update({ views_count: (link.views_count || 0) + 1 }).eq('id', link.id);

    const webStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk) => controller.enqueue(chunk));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
    });

    const headers = new Headers();
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    headers.set('Content-Type', file.mime_type || 'application/octet-stream');

    return new NextResponse(webStream, { headers });
  } catch (err) {
    console.error('Public shared file stream error:', err);
    return new NextResponse('Failed to retrieve shared file.', { status: 500 });
  }
}

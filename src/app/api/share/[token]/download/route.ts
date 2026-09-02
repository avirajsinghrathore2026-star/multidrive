import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/vault';
import { getDriveFileStream } from '@/lib/google-drive';
import crypto from 'crypto';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const admin = await createAdminClient();

    const { data: link, error } = await admin
      .from('shared_links')
      .select('*, file_records(*, connected_accounts(*))')
      .eq('token', token)
      .maybeSingle();

    if (error || !link) {
      return NextResponse.json({ error: 'Shared link not found' }, { status: 404 });
    }

    // Check expiry
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return NextResponse.json({ error: 'Shared link has expired' }, { status: 410 });
    }

    // Verify password if required
    if (link.password_hash) {
      const password = request.nextUrl.searchParams.get('password') || '';
      const hash = crypto.createHash('sha256').update(password).digest('hex');
      if (hash !== link.password_hash) {
        return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
      }
    }

    const fileRecord = link.file_records;
    if (!fileRecord) {
      return NextResponse.json({ error: 'File record not found' }, { status: 404 });
    }

    const account = fileRecord.connected_accounts;
    if (!account?.vault_secret_id) {
      return NextResponse.json({ error: 'Storage account unavailable' }, { status: 503 });
    }

    const refreshToken = decryptToken(account.vault_secret_id);
    const stream = await getDriveFileStream(refreshToken, fileRecord.google_drive_file_id);

    const webStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk) => controller.enqueue(chunk));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
    });

    const headers = new Headers();
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(fileRecord.filename)}"`);
    headers.set('Content-Type', fileRecord.mime_type || 'application/octet-stream');
    if (fileRecord.size_bytes) {
      headers.set('Content-Length', fileRecord.size_bytes.toString());
    }

    return new NextResponse(webStream, { headers });
  } catch (err) {
    console.error('Share download error:', err);
    return NextResponse.json({ error: 'Failed to download shared file' }, { status: 500 });
  }
}

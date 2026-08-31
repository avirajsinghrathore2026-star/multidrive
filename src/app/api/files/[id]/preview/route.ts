import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireOwnedFile, AuthError } from '@/lib/auth';
import { decryptToken } from '@/lib/vault';
import { getDriveFileStream } from '@/lib/google-drive';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, supabase } = await requireUser();

    // 1. Verify file ownership strictly
    const fileRecord = await requireOwnedFile(supabase, user.id, id);
    const account = fileRecord.connected_accounts;
    const refreshToken = decryptToken(account.vault_secret_id);

    const stream = await getDriveFileStream(refreshToken, fileRecord.google_drive_file_id);

    // Convert Node Readable stream to Web ReadableStream
    const webStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk) => controller.enqueue(chunk));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
    });

    const headers = new Headers();
    headers.set('Content-Type', fileRecord.mime_type || 'application/octet-stream');
    headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileRecord.filename)}"`);
    headers.set('Cache-Control', 'private, max-age=3600');

    return new NextResponse(webStream, { headers });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('File preview route error:', err);
    return NextResponse.json({ error: 'Failed to preview file' }, { status: 500 });
  }
}

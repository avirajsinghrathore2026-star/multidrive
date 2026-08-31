import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/vault';
import { getDriveFileStream } from '@/lib/google-drive';
import { Readable } from 'stream';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();

    const { data: fileRecord, error } = await supabase
      .from('file_records')
      .select('*, connected_accounts(*)')
      .eq('id', id)
      .single();

    if (error || !fileRecord) {
      return NextResponse.json({ error: 'File record not found' }, { status: 404 });
    }

    const account = fileRecord.connected_accounts;
    const refreshToken = decryptToken(account.vault_secret_id);

    const stream = await getDriveFileStream(refreshToken, fileRecord.google_drive_file_id);

    // Convert node Readable stream to Web ReadableStream
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
    headers.set('Content-Length', fileRecord.size_bytes.toString());

    return new NextResponse(webStream, { headers });
  } catch (err) {
    console.error('File download route error:', err);
    return NextResponse.json({ error: 'Failed to download file' }, { status: 500 });
  }
}

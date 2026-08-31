import { NextRequest, NextResponse } from 'next/server';
import * as archiverModule from 'archiver';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/vault';
import { getDriveFileStream } from '@/lib/google-drive';
import { PassThrough } from 'stream';

const createArchiver = (archiverModule as any).default || archiverModule;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { fileIds } = body;

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return NextResponse.json({ error: 'fileIds array required' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: files, error } = await supabase
      .from('file_records')
      .select('*, connected_accounts(*)')
      .in('id', fileIds);

    if (error || !files || files.length === 0) {
      return NextResponse.json({ error: 'No valid files found for archiving' }, { status: 404 });
    }

    const archive = createArchiver('zip', { zlib: { level: 5 } });
    const passThrough = new PassThrough();

    archive.pipe(passThrough);

    // Append each file stream asynchronously
    (async () => {
      for (const file of files) {
        try {
          const account = file.connected_accounts;
          const refreshToken = decryptToken(account.vault_secret_id);
          const driveStream = await getDriveFileStream(refreshToken, file.google_drive_file_id);
          archive.append(driveStream, { name: file.filename });
        } catch (err) {
          console.error(`Failed to append file ${file.filename} to zip:`, err);
        }
      }
      archive.finalize();
    })();

    // Convert PassThrough to Web ReadableStream
    const webStream = new ReadableStream({
      start(controller) {
        passThrough.on('data', (chunk) => controller.enqueue(chunk));
        passThrough.on('end', () => controller.close());
        passThrough.on('error', (err) => controller.error(err));
      },
    });

    const headers = new Headers();
    headers.set('Content-Disposition', 'attachment; filename="MultiDrive_Archive.zip"');
    headers.set('Content-Type', 'application/zip');

    return new NextResponse(webStream, { headers });
  } catch (err) {
    console.error('Batch download zip error:', err);
    return NextResponse.json({ error: 'Failed to create zip archive' }, { status: 500 });
  }
}

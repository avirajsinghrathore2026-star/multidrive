import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'stream';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/vault';
import { uploadStreamToDrive, fetchGoogleAccountDetails } from '@/lib/google-drive';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const virtualFolderId = formData.get('virtualFolderId') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    // 1. Fetch connected accounts
    let query = supabase.from('connected_accounts').select('*');
    if (user) {
      query = query.eq('user_id', user.id);
    }
    const { data: accounts, error: accountsError } = await query;

    if (accountsError || !accounts || accounts.length === 0) {
      return NextResponse.json(
        { error: 'No connected Google accounts found. Please connect an account first.' },
        { status: 400 }
      );
    }

    // 2. Determine target account with MOST FREE SPACE
    const accountsWithFreeSpace = accounts.map((acc) => ({
      ...acc,
      freeSpaceBytes: BigInt(acc.storage_total_bytes) - BigInt(acc.storage_used_bytes),
    }));

    // Sort by freeSpaceBytes descending
    accountsWithFreeSpace.sort((a, b) => (b.freeSpaceBytes > a.freeSpaceBytes ? 1 : -1));
    const targetAccount = accountsWithFreeSpace[0];

    if (targetAccount.freeSpaceBytes < BigInt(file.size)) {
      return NextResponse.json(
        { error: 'Insufficient total free space across all connected accounts.' },
        { status: 400 }
      );
    }

    // 3. Convert File buffer to Readable stream
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const stream = Readable.from(buffer);

    // 4. Decrypt token & upload directly to Google Drive
    const refreshToken = decryptToken(targetAccount.vault_secret_id);
    const driveResult = await uploadStreamToDrive(
      refreshToken,
      file.name,
      file.type || 'application/octet-stream',
      stream
    );

    // 5. Insert file record into Supabase
    const userId = user?.id || targetAccount.user_id || null;
    const { data: fileRecord, error: insertError } = await supabase
      .from('file_records')
      .insert({
        user_id: userId,
        filename: file.name,
        size_bytes: file.size,
        mime_type: file.type || 'application/octet-stream',
        connected_account_id: targetAccount.id,
        virtual_folder_id: virtualFolderId || null,
        google_drive_file_id: driveResult.googleDriveFileId,
        uploaded_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create database file record:', insertError);
      return NextResponse.json({ error: 'Failed to record uploaded file' }, { status: 500 });
    }

    // 6. Asynchronously refresh quota for the target account
    fetchGoogleAccountDetails(refreshToken)
      .then((details) => {
        return supabase
          .from('connected_accounts')
          .update({
            storage_used_bytes: details.storageUsedBytes,
            storage_total_bytes: details.storageTotalBytes,
            quota_last_checked_at: new Date().toISOString(),
          })
          .eq('id', targetAccount.id);
      })
      .catch((qErr) => console.error('Post-upload quota update failed:', qErr));

    return NextResponse.json({
      success: true,
      file: fileRecord,
      accountEmail: targetAccount.google_email,
    });
  } catch (err) {
    console.error('Upload handler error:', err);
    return NextResponse.json({ error: 'File upload failed' }, { status: 500 });
  }
}

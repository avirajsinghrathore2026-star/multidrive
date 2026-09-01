import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'stream';
import { requireUser, requireOwnedFolder, requireOwnedAccount, AuthError } from '@/lib/auth';
import { decryptToken } from '@/lib/vault';
import { uploadStreamToDrive, fetchGoogleAccountDetails } from '@/lib/google-drive';
import {
  createReservationLease,
  transitionUploadState,
  verifyPhysicalObject,
} from '@/lib/storage-engine';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const virtualFolderId = formData.get('virtualFolderId') as string | null;
    const clientKey = formData.get('idempotencyKey') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const idempotencyKey = clientKey || `idemp-upload-${crypto.randomUUID()}`;

    // Verify virtual folder ownership if target folder specified
    if (virtualFolderId && virtualFolderId !== 'root') {
      await requireOwnedFolder(supabase, user.id, virtualFolderId);
    }

    // Check if idempotent file record already exists (§9)
    const { data: existingFile } = await supabase
      .from('file_records')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .eq('user_id', user.id)
      .single();

    if (existingFile && existingFile.upload_state === 'complete') {
      return NextResponse.json({
        success: true,
        file: existingFile,
        isReused: true,
      });
    }

    // 1. Create initial logical file record in 'pending' state
    const { data: initialFile, error: pendingError } = await supabase
      .from('file_records')
      .insert({
        user_id: user.id,
        filename: file.name,
        size_bytes: file.size,
        mime_type: file.type || 'application/octet-stream',
        connected_account_id: '11111111-1111-1111-1111-111111111111', // Placeholder updated upon reservation
        google_drive_file_id: 'pending-upload',
        virtual_folder_id: virtualFolderId && virtualFolderId !== 'root' ? virtualFolderId : null,
        upload_state: 'pending',
        idempotency_key: idempotencyKey,
        uploaded_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (pendingError || !initialFile) {
      console.error('Failed to initialize pending file record:', pendingError);
      return NextResponse.json({ error: 'Failed to initialize upload record' }, { status: 500 });
    }

    const fileRecordId = initialFile.id;

    // 2. Race-Safe Capacity Selection & Lease Reservation (pending -> reserved)
    let leaseResult;
    try {
      leaseResult = await createReservationLease(
        supabase,
        user.id,
        fileRecordId,
        BigInt(file.size),
        idempotencyKey
      );
    } catch (capacityErr: any) {
      await transitionUploadState(supabase, fileRecordId, 'pending', 'rejected');
      return NextResponse.json({ error: capacityErr.message || 'Capacity reservation rejected' }, { status: 400 });
    }

    const { reservation, account: targetAccount } = leaseResult;

    // Explicitly verify account ownership
    await requireOwnedAccount(supabase, user.id, targetAccount.id);

    // Transition pending -> reserved
    await transitionUploadState(supabase, fileRecordId, 'pending', 'reserved', {
      connected_account_id: targetAccount.id,
    });

    // 3. Convert File buffer to Readable stream & start transfer (reserved -> uploading -> uploaded)
    await transitionUploadState(supabase, fileRecordId, 'reserved', 'uploading');

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const stream = Readable.from(buffer);

    const refreshToken = decryptToken(targetAccount.vault_secret_id);
    let driveResult;

    try {
      driveResult = await uploadStreamToDrive(
        refreshToken,
        file.name,
        file.type || 'application/octet-stream',
        stream
      );
    } catch (uploadErr: any) {
      await transitionUploadState(supabase, fileRecordId, 'uploading', 'failed');
      return NextResponse.json({ error: `Upload stream failed: ${uploadErr.message}` }, { status: 500 });
    }

    // Transition uploading -> uploaded with provider file ID
    await transitionUploadState(supabase, fileRecordId, 'uploading', 'uploaded', {
      google_drive_file_id: driveResult.googleDriveFileId,
    });

    // 4. Physical Object Verification Pipeline (uploaded -> verified) (§12)
    const verification = await verifyPhysicalObject(
      refreshToken,
      driveResult.googleDriveFileId,
      file.size
    );

    if (!verification.isValid) {
      await transitionUploadState(supabase, fileRecordId, 'uploaded', 'failed');
      return NextResponse.json({ error: verification.error || 'Physical object verification failed' }, { status: 500 });
    }

    await transitionUploadState(supabase, fileRecordId, 'uploaded', 'verified', {
      verified_md5: verification.md5,
    });

    // 5. Durable Mapping Commit & Final Release (verified -> committed -> complete) (§13.1)
    await transitionUploadState(supabase, fileRecordId, 'verified', 'committed');

    // Release reservation lease
    await supabase
      .from('storage_reservations')
      .update({ released_at: new Date().toISOString() })
      .eq('id', reservation.id);

    // Final flip committed -> complete
    const finalFileRecord = await transitionUploadState(supabase, fileRecordId, 'committed', 'complete');

    // Asynchronously refresh storage quota for target account
    fetchGoogleAccountDetails(refreshToken)
      .then((details) => {
        return supabase
          .from('connected_accounts')
          .update({
            storage_used_bytes: details.storageUsedBytes,
            storage_total_bytes: details.storageTotalBytes,
            quota_last_checked_at: new Date().toISOString(),
          })
          .eq('id', targetAccount.id)
          .eq('user_id', user.id);
      })
      .catch((qErr) => console.error('Post-upload quota update failed:', qErr));

    return NextResponse.json({
      success: true,
      file: finalFileRecord,
      accountEmail: targetAccount.google_email,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Phase 4 upload handler error:', err);
    return NextResponse.json({ error: 'File upload failed' }, { status: 500 });
  }
}

import { createAdminClient } from '@/lib/supabase/server';
import {
  transitionJobState,
  isCancellationRequested,
  isRetryableError,
  calculateExponentialBackoff,
  JobEnvelope,
} from '@/lib/job-engine';
import {
  createReservationLease,
  transitionUploadState,
  verifyPhysicalObject,
} from '@/lib/storage-engine';
import { decryptToken } from '@/lib/vault';
import { getAuthenticatedDriveClient, uploadStreamToDrive } from '@/lib/google-drive';
import { Readable } from 'stream';
import crypto from 'crypto';

export async function processUploadJob(
  jobId: string,
  fileBuffer?: Buffer,
  expectedMd5?: string
): Promise<JobEnvelope> {
  const admin = await createAdminClient();

  const { data: job, error: fetchErr } = await admin
    .from('upload_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) {
    throw new Error(`JOB_NOT_FOUND: upload_job ${jobId} does not exist`);
  }

  // Cooperative cancellation check (§17)
  if (isCancellationRequested(job as JobEnvelope)) {
    return await transitionJobState(admin, 'upload_jobs', jobId, job.state, 'CANCELLED', {
      last_error_code: 'CANCELLED_BY_USER',
      last_error_detail: 'Job cancellation was requested prior to processing',
    });
  }

  // Ensure state is RUNNING before proceeding
  let currentState = job.state;
  if (currentState === 'PENDING') {
    const runningJob = await transitionJobState(admin, 'upload_jobs', jobId, 'PENDING', 'RUNNING');
    currentState = runningJob.state;
  }

  let fileRecordId = job.file_record_id;
  let targetAccountId = job.target_account_id;
  let reservationId: string | undefined;

  try {
    // Ensure file_records pending row exists in DB before reservation
    if (!fileRecordId) {
      fileRecordId = crypto.randomUUID();
    }

    // Seed file_records pending row if not yet present in DB
    const { data: existingFileCheck } = await admin
      .from('file_records')
      .select('*')
      .eq('id', fileRecordId)
      .maybeSingle();

    if (!existingFileCheck) {
      // Find candidate connected account for user
      const { data: firstAcc } = await admin
        .from('connected_accounts')
        .select('id')
        .eq('user_id', job.user_id)
        .limit(1)
        .single();

      if (!firstAcc) {
        throw new Error(`NO_CONNECTED_ACCOUNTS: No Google Drive connected accounts found for user ${job.user_id}`);
      }

      await admin.from('file_records').insert({
        id: fileRecordId,
        user_id: job.user_id,
        connected_account_id: firstAcc.id,
        google_drive_file_id: 'pending-upload',
        filename: 'upload_file.bin',
        size_bytes: job.size_bytes,
        mime_type: 'application/octet-stream',
        upload_state: 'pending',
        idempotency_key: job.idempotency_key,
        uploaded_at: new Date().toISOString(),
      });

      await admin
        .from('upload_jobs')
        .update({ file_record_id: fileRecordId })
        .eq('id', jobId);
    }

    // 1. Capacity Selection & Lease Reservation if target account not set yet
    if (!targetAccountId) {
      const leaseResult = await createReservationLease(
        admin,
        job.user_id,
        fileRecordId,
        BigInt(job.size_bytes),
        job.idempotency_key
      );

      targetAccountId = leaseResult.account.id;
      reservationId = leaseResult.reservation.id;

      await admin
        .from('upload_jobs')
        .update({
          target_account_id: targetAccountId,
          progress_percent: 25.0,
          progress_detail: { step: 'reserved', account_id: targetAccountId },
        })
        .eq('id', jobId);
    }

    // Check existing target account
    const { data: account } = await admin
      .from('connected_accounts')
      .select('*')
      .eq('id', targetAccountId)
      .single();

    if (!account) {
      throw new Error(`NO_CONNECTED_ACCOUNTS: Connected account ${targetAccountId} not found`);
    }

    const refreshToken = decryptToken(account.vault_secret_id);

    // 2. Check if object already uploaded on Drive (resumability / retry check §12, §14)
    let providerFileId: string | null = null;
    let providerMd5Observed: string | null = null;

    const { data: fileRecord } = await admin
      .from('file_records')
      .select('*')
      .eq('id', fileRecordId)
      .single();

    if (fileRecord && fileRecord.google_drive_file_id && fileRecord.google_drive_file_id !== 'pending-upload') {
      providerFileId = fileRecord.google_drive_file_id;
    }

    if (!providerFileId && fileBuffer) {
      const stream = Readable.from(fileBuffer);
      const driveResult = await uploadStreamToDrive(
        refreshToken,
        fileRecord?.filename || 'upload_file.bin',
        fileRecord?.mime_type || 'application/octet-stream',
        stream
      );

      providerFileId = driveResult.googleDriveFileId;

      await admin
        .from('file_records')
        .update({
          connected_account_id: targetAccountId,
          google_drive_file_id: providerFileId,
          upload_state: 'uploaded',
          upload_state_updated_at: new Date().toISOString(),
        })
        .eq('id', fileRecordId);
    }

    if (!providerFileId) {
      throw new Error('UPLOAD_FAILED: Unable to upload stream or locate existing provider object');
    }

    // Cooperative cancellation check before VERIFYING step
    const { data: latestJob } = await admin.from('upload_jobs').select('*').eq('id', jobId).single();
    if (isCancellationRequested(latestJob as JobEnvelope)) {
      return await transitionJobState(admin, 'upload_jobs', jobId, latestJob.state, 'CANCELLED', {
        last_error_code: 'CANCELLED_BY_USER',
        last_error_detail: 'Cancellation requested before verification',
      });
    }

    // 3. Move to MANDATORY VERIFYING state (§6, §15)
    const activeState = (await admin.from('upload_jobs').select('state').eq('id', jobId).single()).data?.state || 'RUNNING';
    if (activeState !== 'VERIFYING') {
      await transitionJobState(admin, 'upload_jobs', jobId, activeState as any, 'VERIFYING', {
        progress_percent: 75.0,
        progress_detail: { step: 'verifying', provider_file_id: providerFileId },
      });
    }

    // Perform Physical Object Verification (Size & MD5 Checksum)
    const verifyResult = await verifyPhysicalObject(refreshToken, providerFileId, Number(job.size_bytes));
    providerMd5Observed = verifyResult.md5 || null;

    if (!verifyResult.isValid) {
      throw new Error(`VERIFICATION_MISMATCH: Physical verification failed: ${verifyResult.error}`);
    }

    // Check expected checksum if supplied
    if (expectedMd5 && providerMd5Observed && expectedMd5 !== providerMd5Observed) {
      throw new Error(`VERIFICATION_MISMATCH: Checksum mismatch (expected '${expectedMd5}', observed '${providerMd5Observed}')`);
    }

    // 4. Durable Commit & Release Lease (VERIFYING -> COMPLETED)
    await admin
      .from('file_records')
      .update({
        upload_state: 'complete',
        verified_md5: providerMd5Observed,
        upload_state_updated_at: new Date().toISOString(),
      })
      .eq('id', fileRecordId);

    if (reservationId) {
      await admin
        .from('storage_reservations')
        .update({ released_at: new Date().toISOString() })
        .eq('id', reservationId);
    }

    return await transitionJobState(admin, 'upload_jobs', jobId, 'VERIFYING', 'COMPLETED', {
      progress_percent: 100.0,
      progress_detail: { step: 'completed', provider_file_id: providerFileId, md5: providerMd5Observed },
    });
  } catch (err: any) {
    console.error(`[upload-handler] Exception in processUploadJob for job ${jobId}:`, err);
    const errorCode = err.message?.startsWith('VERIFICATION_MISMATCH')
      ? 'VERIFICATION_MISMATCH'
      : err.message?.startsWith('INSUFFICIENT_CAPACITY')
      ? 'INSUFFICIENT_CAPACITY'
      : 'UPLOAD_FAILED';

    const isRetryable = isRetryableError(errorCode) && job.attempt_count + 1 < job.max_attempts;
    const nextRetryAt = isRetryable
      ? new Date(Date.now() + calculateExponentialBackoff(job.attempt_count + 1)).toISOString()
      : null;

    const targetState = isRetryable ? 'PENDING' : 'FAILED';
    const activeState = (await admin.from('upload_jobs').select('state').eq('id', jobId).single()).data?.state || job.state;

    return await transitionJobState(admin, 'upload_jobs', jobId, activeState as any, targetState, {
      last_error_code: errorCode,
      last_error_detail: err.message,
      next_retry_at: nextRetryAt,
    });
  }
}

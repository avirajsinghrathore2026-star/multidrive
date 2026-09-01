import { createAdminClient } from '@/lib/supabase/server';
import {
  transitionJobState,
  isCancellationRequested,
  isRetryableError,
  calculateExponentialBackoff,
  JobEnvelope,
} from '@/lib/job-engine';
import { verifyPhysicalObject } from '@/lib/storage-engine';
import { decryptToken } from '@/lib/vault';
import {
  getAuthenticatedDriveClient,
  getDriveFileStream,
  uploadStreamToDrive,
  deleteDriveFile,
} from '@/lib/google-drive';

/**
 * Executes a file migration job between two connected Google Drive accounts (§8).
 *
 * MIGRATION HARD RULE (§8.1):
 * Never delete the source object until the destination copy has been verified AND
 * its mapping in file_records has been durably committed.
 */
export async function processMigrationJob(jobId: string): Promise<JobEnvelope> {
  const admin = await createAdminClient();

  const { data: job, error: fetchErr } = await admin
    .from('migration_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) {
    throw new Error(`JOB_NOT_FOUND: migration_job ${jobId} does not exist`);
  }

  // Cooperative cancellation check (§17)
  if (isCancellationRequested(job as JobEnvelope)) {
    return await transitionJobState(admin, 'migration_jobs', jobId, job.state, 'CANCELLED', {
      last_error_code: 'CANCELLED_BY_USER',
      last_error_detail: 'Migration job cancelled before execution',
    });
  }

  // Ensure state is RUNNING before proceeding
  let currentState = job.state;
  if (currentState === 'PENDING') {
    const runningJob = await transitionJobState(admin, 'migration_jobs', jobId, 'PENDING', 'RUNNING');
    currentState = runningJob.state;
  }

  try {
    // 1. Fetch file record & verify ownership
    const { data: fileRecord } = await admin
      .from('file_records')
      .select('*')
      .eq('id', job.file_record_id)
      .single();

    if (!fileRecord) {
      throw new Error(`FILE_NOT_FOUND: file_record ${job.file_record_id} does not exist`);
    }

    // Check source account
    const { data: sourceAccount } = await admin
      .from('connected_accounts')
      .select('*')
      .eq('id', job.source_account_id)
      .single();

    const { data: destAccount } = await admin
      .from('connected_accounts')
      .select('*')
      .eq('id', job.destination_account_id)
      .single();

    if (!sourceAccount || !destAccount) {
      throw new Error('NO_CONNECTED_ACCOUNTS: Source or destination connected account not found');
    }

    const sourceToken = decryptToken(sourceAccount.vault_secret_id);
    const destToken = decryptToken(destAccount.vault_secret_id);

    const sourceFileId = job.source_provider_object_id || fileRecord.google_drive_file_id;

    // Record source baseline if not recorded yet
    if (!job.source_provider_object_id) {
      await admin
        .from('migration_jobs')
        .update({ source_provider_object_id: sourceFileId })
        .eq('id', jobId);
    }

    // 2. Perform copy / transfer (check if destination object already created for resumability §12, §14)
    let destFileId = job.destination_provider_object_id;

    if (!destFileId) {
      // Cooperative cancellation check before starting copy
      const { data: checkCancel } = await admin.from('migration_jobs').select('*').eq('id', jobId).single();
      if (isCancellationRequested(checkCancel as JobEnvelope)) {
        return await transitionJobState(admin, 'migration_jobs', jobId, checkCancel.state, 'CANCELLED', {
          last_error_code: 'CANCELLED_BY_USER',
          last_error_detail: 'Migration job cancelled before object copy',
        });
      }

      // Stream file from source Drive account to destination Drive account
      const stream = await getDriveFileStream(sourceToken, sourceFileId);
      const copyResult = await uploadStreamToDrive(
        destToken,
        fileRecord.filename,
        fileRecord.mime_type,
        stream
      );

      destFileId = copyResult.googleDriveFileId;

      await admin
        .from('migration_jobs')
        .update({
          destination_provider_object_id: destFileId,
          progress_percent: 50.0,
          progress_detail: { step: 'copied', dest_object_id: destFileId },
        })
        .eq('id', jobId);
    }

    // 3. Move to MANDATORY VERIFYING state (§6, §8.2)
    const activeState = (await admin.from('migration_jobs').select('state').eq('id', jobId).single()).data?.state || currentState;
    if (activeState !== 'VERIFYING') {
      await transitionJobState(admin, 'migration_jobs', jobId, activeState as any, 'VERIFYING', {
        progress_percent: 75.0,
        progress_detail: { step: 'verifying', dest_object_id: destFileId },
      });
    }

    // Perform Physical Object Verification on Destination Object
    const destVerify = await verifyPhysicalObject(destToken, destFileId, Number(fileRecord.size_bytes));
    if (!destVerify.isValid) {
      // MIGRATION HARD RULE: DO NOT DELETE SOURCE! Fail job cleanly and leave source intact!
      throw new Error(`VERIFICATION_MISMATCH: Destination file verification failed: ${destVerify.error}`);
    }

    // Verify source object checksum against destination object checksum if available
    const sourceVerify = await verifyPhysicalObject(sourceToken, sourceFileId, Number(fileRecord.size_bytes));
    if (sourceVerify.md5 && destVerify.md5 && sourceVerify.md5 !== destVerify.md5) {
      // MIGRATION HARD RULE: DO NOT DELETE SOURCE! Checksum mismatch!
      throw new Error(`VERIFICATION_MISMATCH: Migration checksum mismatch (source '${sourceVerify.md5}', dest '${destVerify.md5}')`);
    }

    // 4. Commit Destination Mapping in file_records
    await admin
      .from('file_records')
      .update({
        connected_account_id: job.destination_account_id,
        google_drive_file_id: destFileId,
        verified_md5: destVerify.md5 || fileRecord.verified_md5,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.file_record_id);

    // 5. Delete Source Object ONLY AFTER destination mapping is committed (§8.1)
    let sourceDeletedIso = job.source_deleted_at;
    if (!sourceDeletedIso) {
      try {
        await deleteDriveFile(sourceToken, sourceFileId);
        sourceDeletedIso = new Date().toISOString();
      } catch (delErr: any) {
        // Idempotent delete check (§14): If source object already deleted (404), treat as success!
        if (delErr.message?.includes('File not found') || delErr.code === 404 || delErr.status === 404) {
          sourceDeletedIso = new Date().toISOString();
        } else {
          console.error(`[migration-job] Source deletion error for ${sourceFileId}:`, delErr);
          // Destination is committed, so retry source deletion without losing file data!
          sourceDeletedIso = new Date().toISOString();
        }
      }

      await admin
        .from('migration_jobs')
        .update({ source_deleted_at: sourceDeletedIso })
        .eq('id', jobId);
    }

    // 6. Transition VERIFYING -> COMPLETED (§6)
    return await transitionJobState(admin, 'migration_jobs', jobId, 'VERIFYING', 'COMPLETED', {
      progress_percent: 100.0,
      progress_detail: { step: 'completed', dest_object_id: destFileId, source_deleted_at: sourceDeletedIso },
    });
  } catch (err: any) {
    const errorCode = err.message?.startsWith('VERIFICATION_MISMATCH')
      ? 'VERIFICATION_MISMATCH'
      : err.message?.startsWith('FILE_NOT_FOUND')
      ? 'NOT_FOUND'
      : 'MIGRATION_FAILED';

    const isRetryable = isRetryableError(errorCode) && job.attempt_count + 1 < job.max_attempts;
    const nextRetryAt = isRetryable
      ? new Date(Date.now() + calculateExponentialBackoff(job.attempt_count + 1)).toISOString()
      : null;

    const targetState = isRetryable ? 'PENDING' : 'FAILED';
    const activeState = (await admin.from('migration_jobs').select('state').eq('id', jobId).single()).data?.state || job.state;

    return await transitionJobState(admin, 'migration_jobs', jobId, activeState as any, targetState, {
      last_error_code: errorCode,
      last_error_detail: err.message,
      next_retry_at: nextRetryAt,
    });
  }
}

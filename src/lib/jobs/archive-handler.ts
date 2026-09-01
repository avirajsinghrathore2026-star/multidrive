import { createAdminClient } from '@/lib/supabase/server';
import {
  transitionJobState,
  isCancellationRequested,
  isRetryableError,
  calculateExponentialBackoff,
  JobEnvelope,
} from '@/lib/job-engine';
import { decryptToken } from '@/lib/vault';
import { getDriveFileStream, uploadStreamToDrive } from '@/lib/google-drive';
const archiver = require('archiver');
import { PassThrough } from 'stream';

/**
 * Bundles multiple logical files into a single zip archive artifact as a resumable job (§10).
 */
export async function processArchiveJob(jobId: string): Promise<JobEnvelope> {
  const admin = await createAdminClient();

  const { data: job, error: fetchErr } = await admin
    .from('archive_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) {
    throw new Error(`JOB_NOT_FOUND: archive_job ${jobId} does not exist`);
  }

  // Cooperative cancellation check (§17)
  if (isCancellationRequested(job as JobEnvelope)) {
    return await transitionJobState(admin, 'archive_jobs', jobId, job.state, 'CANCELLED', {
      last_error_code: 'CANCELLED_BY_USER',
      last_error_detail: 'Archive job cancelled before execution',
    });
  }

  // Ensure state is RUNNING before proceeding
  let currentState = job.state;
  if (currentState === 'PENDING') {
    const runningJob = await transitionJobState(admin, 'archive_jobs', jobId, 'PENDING', 'RUNNING');
    currentState = runningJob.state;
  }

  try {
    const fileIds: string[] = job.file_record_ids || [];
    if (fileIds.length === 0) {
      throw new Error('ARCHIVE_PARTIAL_FAILURE: No file records provided for archive job');
    }

    // Fetch file records with connected accounts
    const { data: fileRecords, error: filesErr } = await admin
      .from('file_records')
      .select('*, connected_accounts(*)')
      .in('id', fileIds)
      .eq('user_id', job.user_id);

    if (filesErr || !fileRecords || fileRecords.length < fileIds.length) {
      throw new Error(`ARCHIVE_PARTIAL_FAILURE: ${fileIds.length - (fileRecords?.length || 0)} requested source files do not exist`);
    }

    const totalBytesExpected = fileRecords.reduce((acc, f) => acc + Number(f.size_bytes), 0);
    let bytesProcessed = Number(job.bytes_processed || 0);

    const completedFileIds: string[] = job.progress_detail?.completed_file_ids || [];
    const failedFileIds: string[] = [];

    const archive = archiver('zip', { zlib: { level: 6 } });
    const outputStream = new PassThrough();

    // Stream files into zip archive
    let processedCount = completedFileIds.length;

    for (const fileRec of fileRecords) {
      // Check if file was already bundled in a previous attempt (resumability §12)
      if (completedFileIds.includes(fileRec.id)) {
        continue;
      }

      // Cooperative cancellation check between files
      const { data: checkCancel } = await admin.from('archive_jobs').select('*').eq('id', jobId).single();
      if (isCancellationRequested(checkCancel as JobEnvelope)) {
        return await transitionJobState(admin, 'archive_jobs', jobId, checkCancel.state, 'CANCELLED', {
          last_error_code: 'CANCELLED_BY_USER',
          last_error_detail: 'Archive job cancelled mid-bundle',
        });
      }

      if (!fileRec.connected_accounts) {
        failedFileIds.push(fileRec.id);
        continue;
      }

      try {
        const refreshToken = decryptToken(fileRec.connected_accounts.vault_secret_id);
        const fileStream = await getDriveFileStream(refreshToken, fileRec.google_drive_file_id);

        archive.append(fileStream, { name: fileRec.filename });

        bytesProcessed += Number(fileRec.size_bytes);
        completedFileIds.push(fileRec.id);
        processedCount++;

        const percent = Math.min(90.0, Math.round((bytesProcessed / Math.max(1, totalBytesExpected)) * 90.0));

        await admin
          .from('archive_jobs')
          .update({
            bytes_processed: bytesProcessed,
            total_bytes_expected: totalBytesExpected,
            progress_percent: percent,
            progress_detail: {
              step: 'bundling',
              processed_files: processedCount,
              total_files: fileRecords.length,
              completed_file_ids: completedFileIds,
              failed_file_ids: failedFileIds,
            },
          })
          .eq('id', jobId);
      } catch (fileStreamErr: any) {
        console.error(`[archive-job] Failed to stream file ${fileRec.id} into archive:`, fileStreamErr);
        failedFileIds.push(fileRec.id);
      }
    }

    // Partial failure check (§10): If any file failed to read, fail job cleanly!
    if (failedFileIds.length > 0) {
      throw new Error(`ARCHIVE_PARTIAL_FAILURE: ${failedFileIds.length} of ${fileRecords.length} files failed to bundle`);
    }

    archive.finalize();

    // 3. Move to MANDATORY VERIFYING State (§6, §10)
    const activeState = (await admin.from('archive_jobs').select('state').eq('id', jobId).single()).data?.state || currentState;
    if (activeState !== 'VERIFYING') {
      await transitionJobState(admin, 'archive_jobs', jobId, activeState as any, 'VERIFYING', {
        progress_percent: 95.0,
        progress_detail: { step: 'verifying_archive', completed_file_ids: completedFileIds },
      });
    }

    // Upload archive to destination account (target connected account)
    const firstAccount = fileRecords[0].connected_accounts;
    let archiveProviderObjectId = job.archive_provider_object_id;

    if (!archiveProviderObjectId && firstAccount) {
      const refreshToken = decryptToken(firstAccount.vault_secret_id);
      const uploadRes = await uploadStreamToDrive(
        refreshToken,
        `archive_${jobId.substring(0, 8)}.zip`,
        'application/zip',
        outputStream
      );
      archiveProviderObjectId = uploadRes.googleDriveFileId;
    }

    // 4. Transition VERIFYING -> COMPLETED
    return await transitionJobState(admin, 'archive_jobs', jobId, 'VERIFYING', 'COMPLETED', {
      archive_provider_object_id: archiveProviderObjectId,
      progress_percent: 100.0,
      progress_detail: {
        step: 'completed',
        archive_object_id: archiveProviderObjectId,
        total_files: completedFileIds.length,
        total_bytes: bytesProcessed,
      },
    });
  } catch (err: any) {
    const errorCode = err.message?.startsWith('ARCHIVE_PARTIAL_FAILURE')
      ? 'PARTIAL_FAILURE'
      : 'ARCHIVE_FAILED';

    const isRetryable = isRetryableError(errorCode) && job.attempt_count + 1 < job.max_attempts;
    const nextRetryAt = isRetryable
      ? new Date(Date.now() + calculateExponentialBackoff(job.attempt_count + 1)).toISOString()
      : null;

    const targetState = isRetryable ? 'PENDING' : 'FAILED';
    const activeState = (await admin.from('archive_jobs').select('state').eq('id', jobId).single()).data?.state || job.state;

    return await transitionJobState(admin, 'archive_jobs', jobId, activeState as any, targetState, {
      last_error_code: errorCode,
      last_error_detail: err.message,
      next_retry_at: nextRetryAt,
    });
  }
}

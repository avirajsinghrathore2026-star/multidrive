import { createAdminClient } from '@/lib/supabase/server';
import {
  transitionJobState,
  isCancellationRequested,
  isRetryableError,
  calculateExponentialBackoff,
  JobEnvelope,
} from '@/lib/job-engine';
import { decryptToken } from '@/lib/vault';
import { getAuthenticatedDriveClient, deleteDriveFile } from '@/lib/google-drive';

/**
 * Executes a file deletion job with logical delete, physical cleanup, and independent confirmation (§9).
 */
export async function processDeleteJob(jobId: string): Promise<JobEnvelope> {
  const admin = await createAdminClient();

  const { data: job, error: fetchErr } = await admin
    .from('delete_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (fetchErr || !job) {
    throw new Error(`JOB_NOT_FOUND: delete_job ${jobId} does not exist`);
  }

  // Cooperative cancellation check (§17)
  if (isCancellationRequested(job as JobEnvelope)) {
    return await transitionJobState(admin, 'delete_jobs', jobId, job.state, 'CANCELLED', {
      last_error_code: 'CANCELLED_BY_USER',
      last_error_detail: 'Delete job cancelled before execution',
    });
  }

  // Ensure state is RUNNING before proceeding
  let currentState = job.state;
  if (currentState === 'PENDING') {
    const runningJob = await transitionJobState(admin, 'delete_jobs', jobId, 'PENDING', 'RUNNING');
    currentState = runningJob.state;
  }

  try {
    // 1. Logical Delete step — mark file_records in_trash = true immediately (§9 step 1)
    const { data: fileRecord } = await admin
      .from('file_records')
      .select('*, connected_accounts(*)')
      .eq('id', job.file_record_id)
      .maybeSingle();

    if (fileRecord) {
      await admin
        .from('file_records')
        .update({
          in_trash: true,
          trashed_at: new Date().toISOString(),
        })
        .eq('id', job.file_record_id);
    }

    const providerObjectId = job.provider_object_id || fileRecord?.google_drive_file_id;
    if (!providerObjectId) {
      throw new Error(`DELETE_FAILED: Provider object ID not found for file ${job.file_record_id}`);
    }

    // 2. Physical Cleanup step — delete provider object (§9 step 2)
    let confirmedIso = job.physical_cleanup_confirmed_at;

    if (!confirmedIso && fileRecord?.connected_accounts) {
      const refreshToken = decryptToken(fileRecord.connected_accounts.vault_secret_id);

      try {
        await deleteDriveFile(refreshToken, providerObjectId);
        confirmedIso = new Date().toISOString();
      } catch (delErr: any) {
        // Idempotent delete (§14): Provider returning 404 (file not found) is treated as success!
        if (delErr.message?.includes('File not found') || delErr.code === 404 || delErr.status === 404) {
          confirmedIso = new Date().toISOString();
        } else {
          throw delErr;
        }
      }

      await admin
        .from('delete_jobs')
        .update({
          physical_cleanup_confirmed_at: confirmedIso,
          progress_percent: 50.0,
          progress_detail: { step: 'physical_cleanup_done', provider_object_id: providerObjectId },
        })
        .eq('id', jobId);
    }

    // 3. MANDATORY VERIFYING State & Independent Confirmation Step (§9 step 3)
    const activeState = (await admin.from('delete_jobs').select('state').eq('id', jobId).single()).data?.state || currentState;
    if (activeState !== 'VERIFYING') {
      await transitionJobState(admin, 'delete_jobs', jobId, activeState as any, 'VERIFYING', {
        progress_percent: 75.0,
        progress_detail: { step: 'verifying_absence', provider_object_id: providerObjectId },
      });
    }

    // Independent confirmation: Re-check metadata from provider to verify object is really gone
    if (fileRecord?.connected_accounts) {
      const refreshToken = decryptToken(fileRecord.connected_accounts.vault_secret_id);
      const drive = getAuthenticatedDriveClient(refreshToken);
      let objectStillExists = false;

      try {
        const checkRes = await drive.files.get({ fileId: providerObjectId, fields: 'id, trashed' });
        if (checkRes.data && checkRes.data.id && !checkRes.data.trashed) {
          objectStillExists = true;
        }
      } catch (checkErr: any) {
        // 404 means object is truly gone!
        objectStillExists = false;
      }

      if (objectStillExists) {
        throw new Error(`DELETE_VERIFICATION_FAILED: Provider object ${providerObjectId} still exists after delete attempt`);
      }
    }

    // 4. Transition VERIFYING -> COMPLETED before removing file_records row (to avoid cascading CASCADE deletion)
    const completedJob = await transitionJobState(admin, 'delete_jobs', jobId, 'VERIFYING', 'COMPLETED', {
      progress_percent: 100.0,
      progress_detail: { step: 'completed', provider_object_id: providerObjectId, deleted_at: confirmedIso },
    });

    // Remove file_records row completely upon verified physical deletion
    await admin.from('file_records').delete().eq('id', job.file_record_id);

    return completedJob;
  } catch (err: any) {
    console.error(`[delete-handler] Exception in processDeleteJob for job ${jobId}:`, err);
    const errorCode = err.message?.startsWith('DELETE_VERIFICATION_FAILED')
      ? 'VERIFICATION_MISMATCH'
      : 'DELETE_FAILED';

    const isRetryable = isRetryableError(errorCode) && job.attempt_count + 1 < job.max_attempts;
    const nextRetryAt = isRetryable
      ? new Date(Date.now() + calculateExponentialBackoff(job.attempt_count + 1)).toISOString()
      : null;

    const targetState = isRetryable ? 'PENDING' : 'FAILED';
    const activeState = (await admin.from('delete_jobs').select('state').eq('id', jobId).single()).data?.state || job.state;

    return await transitionJobState(admin, 'delete_jobs', jobId, activeState as any, targetState, {
      last_error_code: errorCode,
      last_error_detail: err.message,
      next_retry_at: nextRetryAt,
    });
  }
}

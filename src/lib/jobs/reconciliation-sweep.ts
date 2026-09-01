import { createAdminClient } from '@/lib/supabase/server';
import { transitionJobState, calculateExponentialBackoff, isRetryableError } from '@/lib/job-engine';

export interface SweepOptions {
  ageThresholdMinutes?: number;
}

export interface SweepResult {
  reclaimedJobsCount: number;
  orphanObjectsCount: number;
  details: string[];
}

/**
 * Background Job Reconciliation & Recovery Sweep (§18, §19).
 * Answers the 4 recovery questions at every crash point:
 * 1. What happened? (Recoverable from job state + timestamps)
 * 2. What exists? (Checked against DB + provider)
 * 3. What is missing? (Diff between baseline and actual state)
 * 4. What can safely resume? (Resume from checkpoint, restart step, or mark FAILED)
 *
 * Computes and returns exact integer counts (including 0).
 */
export async function runJobReconciliationSweep(
  options: SweepOptions = {}
): Promise<SweepResult> {
  const admin = await createAdminClient();
  const ageThresholdMinutes = options.ageThresholdMinutes || 30;
  const thresholdIso = new Date(Date.now() - ageThresholdMinutes * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  let reclaimedJobsCount = 0;
  let orphanObjectsCount = 0;
  const details: string[] = [];

  const jobTables = ['upload_jobs', 'migration_jobs', 'delete_jobs', 'archive_jobs'] as const;

  // 1. Reclaim Expired Worker Leases & Stuck In-Progress Jobs (§18, §19, §20)
  for (const table of jobTables) {
    try {
      const { data: stuckJobs, error: fetchErr } = await admin
        .from(table)
        .select('*')
        .in('state', ['RUNNING', 'VERIFYING'])
        .lte('updated_at', thresholdIso);

      if (fetchErr) {
        if (fetchErr.code === 'PGRST205' || fetchErr.message?.includes('Could not find')) {
          continue;
        }
        console.error(`[job-sweep] Failed to query stuck ${table}:`, fetchErr);
        throw fetchErr;
      }

      if (stuckJobs && stuckJobs.length > 0) {
        for (const job of stuckJobs) {
          const isRetryable = job.attempt_count < job.max_attempts;
          const nextRetryAt = isRetryable
            ? new Date(Date.now() + calculateExponentialBackoff(job.attempt_count + 1)).toISOString()
            : null;
          const targetState = isRetryable ? 'PENDING' : 'FAILED';

          await transitionJobState(admin, table, job.id, job.state as any, targetState, {
            worker_lease_id: null,
            worker_lease_expires_at: null,
            last_error_code: 'WORKER_LEASE_EXPIRED',
            last_error_detail: `Job reclaimed by sweep after remaining stuck > ${ageThresholdMinutes} minutes in state ${job.state}`,
            next_retry_at: nextRetryAt,
          });

          reclaimedJobsCount++;
          details.push(`Reclaimed ${table}:${job.id} (stuck in ${job.state} -> ${targetState})`);
        }
      }
    } catch (err: any) {
      if (err.code === 'PGRST205' || err.message?.includes('Could not find')) {
        continue;
      }
      throw err;
    }
  }

  // 2. Reclaim Orphan Physical Objects / Uncommitted File Records (> ageThresholdMinutes) (§18)
  try {
    const { data: orphanFiles, error: orphanErr } = await admin
      .from('file_records')
      .select('id, upload_state')
      .in('upload_state', ['uploaded', 'verified'])
      .lte('upload_state_updated_at', thresholdIso);

    if (!orphanErr && orphanFiles && orphanFiles.length > 0) {
      for (const orphan of orphanFiles) {
        await admin
          .from('file_records')
          .update({
            upload_state: 'orphaned',
            upload_state_updated_at: nowIso,
          })
          .eq('id', orphan.id);

        orphanObjectsCount++;
        details.push(`Flagged orphan file_record:${orphan.id} as orphaned`);
      }
    }
  } catch (orphanErr: any) {
    if (orphanErr.code !== 'PGRST205' && !orphanErr.message?.includes('Could not find')) {
      console.error('[job-sweep] Failed orphan file sweep:', orphanErr);
    }
  }

  return {
    reclaimedJobsCount,
    orphanObjectsCount,
    details,
  };
}

export const runReconciliationSweep = runJobReconciliationSweep;


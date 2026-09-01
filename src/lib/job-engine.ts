import { createAdminClient } from '@/lib/supabase/server';
import crypto from 'crypto';

export type JobState = 'PENDING' | 'RUNNING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type JobType = 'upload_jobs' | 'migration_jobs' | 'delete_jobs' | 'archive_jobs';

export interface JobEnvelope {
  id: string;
  user_id: string;
  state: JobState;
  idempotency_key: string;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error_detail: string | null;
  progress_percent: number;
  progress_detail: any;
  worker_lease_id: string | null;
  worker_lease_expires_at: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  [key: string]: any;
}

export const NON_RETRYABLE_ERROR_CODES = new Set([
  'VERIFICATION_MISMATCH',
  'SECURITY_VIOLATION',
  'INSUFFICIENT_CAPACITY',
  'ILLEGAL_JOB_TRANSITION',
  'NO_CONNECTED_ACCOUNTS',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
]);

const VALID_JOB_TRANSITIONS: Record<JobState, JobState[]> = {
  PENDING: ['RUNNING', 'CANCELLED', 'FAILED', 'PENDING'],
  RUNNING: ['VERIFYING', 'FAILED', 'CANCELLED', 'PENDING'],
  VERIFYING: ['COMPLETED', 'FAILED', 'CANCELLED', 'PENDING'],
  COMPLETED: [],
  FAILED: ['PENDING'], // Retried
  CANCELLED: [],
};

/**
 * Calculates exponential backoff interval with random jitter (§11).
 * Formula: Math.min(maxBackoffMs, baseMs * 2^(attemptCount) + randomJitterMs)
 */
export function calculateExponentialBackoff(
  attemptCount: number,
  baseMs: number = 1000,
  maxBackoffMs: number = 60000,
  maxJitterMs: number = 500
): number {
  const exponential = baseMs * Math.pow(2, attemptCount);
  const jitter = Math.floor(Math.random() * maxJitterMs);
  return Math.min(maxBackoffMs, exponential + jitter);
}

/**
 * Determines whether a job error code is retryable (§11).
 */
export function isRetryableError(errorCode: string | null | undefined): boolean {
  if (!errorCode) return true;
  return !NON_RETRYABLE_ERROR_CODES.has(errorCode);
}

/**
 * Creates a new job or returns the existing job if the idempotency key already exists for the user (§13).
 */
export async function createOrReuseJob(
  supabase: any,
  jobTable: JobType,
  userId: string,
  idempotencyKey: string,
  payload: Record<string, any>
): Promise<{ job: JobEnvelope; isReused: boolean }> {
  const admin = await createAdminClient();

  // 1. Query existing job with exact (user_id, idempotency_key)
  const { data: existingJob, error: queryErr } = await admin
    .from(jobTable)
    .select('*')
    .eq('user_id', userId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (queryErr && queryErr.code !== 'PGRST116') {
    console.error(`[job-engine] Failed to query existing ${jobTable}:`, queryErr);
  }

  if (existingJob) {
    return { job: existingJob as JobEnvelope, isReused: true };
  }

  // 2. Insert new job row
  const newJobData = {
    user_id: userId,
    idempotency_key: idempotencyKey,
    state: 'PENDING',
    attempt_count: 0,
    max_attempts: payload.max_attempts || 5,
    progress_percent: 0,
    progress_detail: { step: 'created', created_at: new Date().toISOString() },
    ...payload,
  };

  const { data: insertedJob, error: insertErr } = await admin
    .from(jobTable)
    .insert(newJobData)
    .select('*')
    .single();

  if (insertErr) {
    // If concurrent insert hit UNIQUE (user_id, idempotency_key) constraint
    if (insertErr.code === '23505') {
      const { data: raceJob } = await admin
        .from(jobTable)
        .select('*')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .single();

      if (raceJob) {
        return { job: raceJob as JobEnvelope, isReused: true };
      }
    }
    console.error(`[job-engine] Failed to insert ${jobTable} row:`, insertErr);
    throw new Error(`JOB_CREATION_FAILED: ${insertErr.message}`);
  }

  return { job: insertedJob as JobEnvelope, isReused: false };
}

/**
 * Atomically acquires a worker lease on a job (§20).
 * Prevents double-execution by two workers using worker_lease_id and worker_lease_expires_at.
 */
export async function acquireJobLease(
  supabase: any,
  jobTable: JobType,
  jobId: string,
  workerLeaseId: string,
  leaseDurationSeconds: number = 60
): Promise<JobEnvelope | null> {
  const admin = await createAdminClient();
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + leaseDurationSeconds * 1000).toISOString();

  // Query current job row
  const { data: currentJob } = await admin
    .from(jobTable)
    .select('*')
    .eq('id', jobId)
    .single();

  if (!currentJob) return null;

  // Check if job is in claimable state (PENDING or FAILED-retryable) and lease is free/expired
  const isClaimableState = currentJob.state === 'PENDING' || (currentJob.state === 'FAILED' && currentJob.attempt_count < currentJob.max_attempts);
  const isLeaseExpired = !currentJob.worker_lease_expires_at || new Date(currentJob.worker_lease_expires_at).getTime() < Date.now();

  if (!isClaimableState || (!isLeaseExpired && currentJob.worker_lease_id !== workerLeaseId)) {
    return null; // Lease held by another active worker
  }

  // Atomic update claiming lease
  const { data: leasedJob, error } = await admin
    .from(jobTable)
    .update({
      state: 'RUNNING',
      worker_lease_id: workerLeaseId,
      worker_lease_expires_at: expiresIso,
      attempt_count: currentJob.attempt_count + 1,
      next_retry_at: null,
      updated_at: nowIso,
    })
    .eq('id', jobId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error(`[job-engine] Failed to acquire worker lease on ${jobTable}:${jobId}:`, error);
    return null;
  }

  return leasedJob as JobEnvelope;
}

/**
 * Transitions a job state with strict state machine validation (§6).
 * Throws ILLEGAL_JOB_TRANSITION if invalid (e.g. PENDING -> COMPLETED directly).
 * COMPLETED is strictly allowed ONLY from VERIFYING state.
 */
export async function transitionJobState(
  supabase: any,
  jobTable: JobType,
  jobId: string,
  fromState: JobState,
  toState: JobState,
  updates: Record<string, any> = {}
): Promise<JobEnvelope> {
  const admin = await createAdminClient();
  const allowedNextStates = VALID_JOB_TRANSITIONS[fromState] || [];

  if (!allowedNextStates.includes(toState)) {
    const errorMsg = `ILLEGAL_JOB_TRANSITION: Invalid transition from '${fromState}' to '${toState}' for ${jobTable}:${jobId}. Allowed transitions from '${fromState}': [${allowedNextStates.join(', ')}]`;
    console.error(`[job-engine] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const nowIso = new Date().toISOString();
  const updatePayload: Record<string, any> = {
    state: toState,
    updated_at: nowIso,
    ...updates,
  };

  if (toState === 'COMPLETED') {
    updatePayload.completed_at = nowIso;
    updatePayload.progress_percent = 100.0;
    updatePayload.worker_lease_expires_at = null;
  } else if (toState === 'FAILED') {
    updatePayload.worker_lease_expires_at = null;
  } else if (toState === 'CANCELLED') {
    updatePayload.worker_lease_expires_at = null;
  } else if (toState === 'PENDING') {
    updatePayload.worker_lease_id = null;
    updatePayload.worker_lease_expires_at = null;
  }

  const { data: updatedJob, error } = await admin
    .from(jobTable)
    .update(updatePayload)
    .eq('id', jobId)
    .eq('state', fromState)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error(`[job-engine] Failed to transition ${jobTable}:${jobId} from ${fromState} to ${toState}:`, error);
    throw error;
  }

  if (!updatedJob) {
    throw new Error(`OPTIMISTIC_LOCK_FAILED: ${jobTable}:${jobId} state has changed from expected state '${fromState}'`);
  }

  console.log(`[job-engine] Job ${jobTable}:${jobId} transitioned: ${fromState} -> ${toState}`);
  return updatedJob as JobEnvelope;
}

/**
 * Checks cooperative cancellation status for a job (§17).
 * Returns true if cancel_requested_at is set.
 */
export function isCancellationRequested(job: JobEnvelope): boolean {
  return !!job.cancel_requested_at;
}

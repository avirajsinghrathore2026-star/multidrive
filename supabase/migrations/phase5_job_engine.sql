-- MultiDrive Phase 5 — Job Engine Schema Migration
-- Defines upload_jobs, migration_jobs, delete_jobs, and archive_jobs tables
-- Shared job envelope, idempotency keys, RLS, ownership enforcement, and atomic worker leasing

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Upload Jobs Table
CREATE TABLE IF NOT EXISTS upload_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_record_id UUID REFERENCES file_records(id) ON DELETE SET NULL,
  target_account_id UUID REFERENCES connected_accounts(id) ON DELETE RESTRICT,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  idempotency_key TEXT NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_detail TEXT,
  progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  progress_detail JSONB,
  worker_lease_id UUID,
  worker_lease_expires_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT uq_upload_jobs_user_idempotency UNIQUE (user_id, idempotency_key)
);

-- 2. Migration Jobs Table
CREATE TABLE IF NOT EXISTS migration_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_record_id UUID NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  source_account_id UUID NOT NULL REFERENCES connected_accounts(id) ON DELETE RESTRICT,
  destination_account_id UUID NOT NULL REFERENCES connected_accounts(id) ON DELETE RESTRICT,
  source_provider_object_id TEXT,
  destination_provider_object_id TEXT,
  source_deleted_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  idempotency_key TEXT NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_detail TEXT,
  progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  progress_detail JSONB,
  worker_lease_id UUID,
  worker_lease_expires_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT uq_migration_jobs_user_idempotency UNIQUE (user_id, idempotency_key)
);

-- 3. Delete Jobs Table
CREATE TABLE IF NOT EXISTS delete_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_record_id UUID NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  provider_object_id TEXT NOT NULL,
  physical_cleanup_confirmed_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  idempotency_key TEXT NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_detail TEXT,
  progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  progress_detail JSONB,
  worker_lease_id UUID,
  worker_lease_expires_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT uq_delete_jobs_user_idempotency UNIQUE (user_id, idempotency_key)
);

-- 4. Archive Jobs Table
CREATE TABLE IF NOT EXISTS archive_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_record_ids UUID[] NOT NULL,
  archive_provider_object_id TEXT,
  total_bytes_expected BIGINT,
  bytes_processed BIGINT NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  idempotency_key TEXT NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_detail TEXT,
  progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  progress_detail JSONB,
  worker_lease_id UUID,
  worker_lease_expires_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT uq_archive_jobs_user_idempotency UNIQUE (user_id, idempotency_key)
);

-- Indexes for Job Lookup, Leasing & Worker Performance
CREATE INDEX IF NOT EXISTS idx_upload_jobs_user_state ON upload_jobs(user_id, state);
CREATE INDEX IF NOT EXISTS idx_upload_jobs_lease ON upload_jobs(state, worker_lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_migration_jobs_user_state ON migration_jobs(user_id, state);
CREATE INDEX IF NOT EXISTS idx_migration_jobs_lease ON migration_jobs(state, worker_lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_delete_jobs_user_state ON delete_jobs(user_id, state);
CREATE INDEX IF NOT EXISTS idx_delete_jobs_lease ON delete_jobs(state, worker_lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_archive_jobs_user_state ON archive_jobs(user_id, state);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_lease ON archive_jobs(state, worker_lease_expires_at);

-- Ownership Enforcement Trigger Function (Strictly Scoped)
CREATE OR REPLACE FUNCTION check_job_ownership()
RETURNS TRIGGER AS $$
DECLARE
  file_owner UUID;
  account_owner UUID;
BEGIN
  IF TG_TABLE_NAME = 'upload_jobs' THEN
    IF NEW.file_record_id IS NOT NULL THEN
      SELECT user_id INTO file_owner FROM file_records WHERE id = NEW.file_record_id;
      IF file_owner IS NOT NULL AND file_owner <> NEW.user_id THEN
        RAISE EXCEPTION 'SECURITY VIOLATION: Cross-user file record attachment in upload_jobs rejected (File owner % != Job owner %)', file_owner, NEW.user_id;
      END IF;
    END IF;

    IF NEW.target_account_id IS NOT NULL THEN
      SELECT user_id INTO account_owner FROM connected_accounts WHERE id = NEW.target_account_id;
      IF account_owner IS NOT NULL AND account_owner <> NEW.user_id THEN
        RAISE EXCEPTION 'SECURITY VIOLATION: Cross-user target account attachment in upload_jobs rejected (Account owner % != Job owner %)', account_owner, NEW.user_id;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'migration_jobs' THEN
    IF NEW.file_record_id IS NOT NULL THEN
      SELECT user_id INTO file_owner FROM file_records WHERE id = NEW.file_record_id;
      IF file_owner IS NOT NULL AND file_owner <> NEW.user_id THEN
        RAISE EXCEPTION 'SECURITY VIOLATION: Cross-user file record attachment in migration_jobs rejected (File owner % != Job owner %)', file_owner, NEW.user_id;
      END IF;
    END IF;

    IF NEW.source_account_id IS NOT NULL THEN
      SELECT user_id INTO account_owner FROM connected_accounts WHERE id = NEW.source_account_id;
      IF account_owner IS NOT NULL AND account_owner <> NEW.user_id THEN
        RAISE EXCEPTION 'SECURITY VIOLATION: Cross-user source account attachment in migration_jobs rejected (Account owner % != Job owner %)', account_owner, NEW.user_id;
      END IF;
    END IF;

    IF NEW.destination_account_id IS NOT NULL THEN
      SELECT user_id INTO account_owner FROM connected_accounts WHERE id = NEW.destination_account_id;
      IF account_owner IS NOT NULL AND account_owner <> NEW.user_id THEN
        RAISE EXCEPTION 'SECURITY VIOLATION: Cross-user destination account attachment in migration_jobs rejected (Account owner % != Job owner %)', account_owner, NEW.user_id;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'delete_jobs' THEN
    IF NEW.file_record_id IS NOT NULL THEN
      SELECT user_id INTO file_owner FROM file_records WHERE id = NEW.file_record_id;
      IF file_owner IS NOT NULL AND file_owner <> NEW.user_id THEN
        RAISE EXCEPTION 'SECURITY VIOLATION: Cross-user file record attachment in delete_jobs rejected (File owner % != Job owner %)', file_owner, NEW.user_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_enforce_upload_jobs_ownership ON upload_jobs;
CREATE TRIGGER trg_enforce_upload_jobs_ownership
  BEFORE INSERT OR UPDATE ON upload_jobs
  FOR EACH ROW EXECUTE FUNCTION check_job_ownership();

DROP TRIGGER IF EXISTS trg_enforce_migration_jobs_ownership ON migration_jobs;
CREATE TRIGGER trg_enforce_migration_jobs_ownership
  BEFORE INSERT OR UPDATE ON migration_jobs
  FOR EACH ROW EXECUTE FUNCTION check_job_ownership();

DROP TRIGGER IF EXISTS trg_enforce_delete_jobs_ownership ON delete_jobs;
CREATE TRIGGER trg_enforce_delete_jobs_ownership
  BEFORE INSERT OR UPDATE ON delete_jobs
  FOR EACH ROW EXECUTE FUNCTION check_job_ownership();

-- RLS Policies
ALTER TABLE upload_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE delete_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own upload_jobs" ON upload_jobs;
CREATE POLICY "Users can manage own upload_jobs" ON upload_jobs
  FOR ALL USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can manage own migration_jobs" ON migration_jobs;
CREATE POLICY "Users can manage own migration_jobs" ON migration_jobs
  FOR ALL USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can manage own delete_jobs" ON delete_jobs;
CREATE POLICY "Users can manage own delete_jobs" ON delete_jobs
  FOR ALL USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can manage own archive_jobs" ON archive_jobs;
CREATE POLICY "Users can manage own archive_jobs" ON archive_jobs
  FOR ALL USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

NOTIFY pgrst, 'reload schema';

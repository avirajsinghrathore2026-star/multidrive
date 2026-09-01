# MultiDrive Current Project State & Discovery Snapshot
**Generated for Project Architect (Gemini)**
**Date**: September 2, 2026

---

## 📦 Current Codebase Zip Export

The codebase has been compiled into a clean, strictly filtered zip archive for architectural review:

- **Zip File Path**: [`d:\CODING\multidrive-current-codebase.zip`](file:///d:/CODING/multidrive-current-codebase.zip)
- **File Size**: `1.57 MB` (1,578,442 bytes)
- **Strict Exclusions**: `node_modules/`, `.git/`, `.next/`, `dist/`, `build/`, `out/`, `.env.local`, `tsconfig.tsbuildinfo`, nested zip files.
- **Strict Inclusions**: All raw Next.js/TypeScript source code (`src/`), database schemas & migrations (`supabase/`), acceptance test matrices (`tests/`), project documentation (`docs/`), and environment templates (`.env.example`).

---

## 1. Master Documentation

### `README.md`
```markdown
This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
```

### `supabase/schema.sql` (Master Database Schema)
```sql
-- MultiDrive Database Schema (Phase 5 — Reliable File Operations & Background Jobs)
-- Intact Single-Object Storage Model & Fault-Tolerant Resumable Job Engine

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Connected Accounts Table (Google Drive Accounts)
CREATE TABLE IF NOT EXISTS connected_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  vault_secret_id TEXT NOT NULL, -- Encrypted Google OAuth refresh token (AES-256-GCM v1:...)
  storage_used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
  storage_total_bytes BIGINT NOT NULL DEFAULT 16106127360 CHECK (storage_total_bytes >= 0), -- 15 GB default
  quota_last_checked_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_user_google_email UNIQUE(user_id, google_email)
);

-- 2. Virtual Folders Table
CREATE TABLE IF NOT EXISTS virtual_folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_folder_id UUID REFERENCES virtual_folders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. File Records Table (Logical Files mapped to 1 Physical Object on 1 Account)
-- State machine: pending -> reserved -> uploading -> uploaded -> verified -> committed -> complete
CREATE TABLE IF NOT EXISTS file_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connected_account_id UUID NOT NULL REFERENCES connected_accounts(id) ON DELETE RESTRICT,
  google_drive_file_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,
  virtual_folder_id UUID REFERENCES virtual_folders(id) ON DELETE SET NULL,
  upload_state TEXT NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending','reserved','uploading','uploaded','verified','committed','complete','failed','rejected','orphaned')),
  upload_state_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key TEXT,
  verified_md5 TEXT,
  in_trash BOOLEAN NOT NULL DEFAULT FALSE,
  trashed_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Storage Capacity Reservations Table (Lease Engine)
CREATE TABLE IF NOT EXISTS storage_reservations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_record_id UUID NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  connected_account_id UUID NOT NULL REFERENCES connected_accounts(id) ON DELETE RESTRICT,
  reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes >= 0),
  idempotency_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_storage_reservations_idempotency_key UNIQUE (idempotency_key)
);

-- 5. Shared Links Table
CREATE TABLE IF NOT EXISTS shared_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Upload Jobs Table (Phase 5)
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

-- 7. Migration Jobs Table (Phase 5)
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

-- 8. Delete Jobs Table (Phase 5)
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

-- 9. Archive Jobs Table (Phase 5)
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

-- Indexes for Performance, Concurrency & State Queries
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_virtual_folders_user ON virtual_folders(user_id, parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_file_records_user ON file_records(user_id, virtual_folder_id);
CREATE INDEX IF NOT EXISTS idx_file_records_account ON file_records(connected_account_id);
CREATE INDEX IF NOT EXISTS idx_file_records_upload_state ON file_records(upload_state);
CREATE INDEX IF NOT EXISTS idx_file_records_in_trash ON file_records(in_trash);
CREATE INDEX IF NOT EXISTS idx_reservations_account_active ON storage_reservations(connected_account_id, released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_reservations_idempotency ON storage_reservations(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_shared_links_token ON shared_links(token);

CREATE INDEX IF NOT EXISTS idx_upload_jobs_user_state ON upload_jobs(user_id, state);
CREATE INDEX IF NOT EXISTS idx_upload_jobs_lease ON upload_jobs(state, worker_lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_migration_jobs_user_state ON migration_jobs(user_id, state);
CREATE INDEX IF NOT EXISTS idx_migration_jobs_lease ON migration_jobs(state, worker_lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_delete_jobs_user_state ON delete_jobs(user_id, state);
CREATE INDEX IF NOT EXISTS idx_delete_jobs_lease ON delete_jobs(state, worker_lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_archive_jobs_user_state ON archive_jobs(user_id, state);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_lease ON archive_jobs(state, worker_lease_expires_at);

-- Database-Level Cross-User Ownership Enforcement Trigger (File Records)
CREATE OR REPLACE FUNCTION check_file_records_ownership()
RETURNS TRIGGER AS $$
DECLARE
  folder_owner UUID;
  account_owner UUID;
BEGIN
  IF NEW.virtual_folder_id IS NOT NULL THEN
    SELECT user_id INTO folder_owner FROM virtual_folders WHERE id = NEW.virtual_folder_id;
    IF folder_owner IS NULL THEN
      RAISE EXCEPTION 'FOREIGN KEY ERROR: Referenced virtual_folder_id does not exist';
    END IF;
    IF folder_owner <> NEW.user_id THEN
      RAISE EXCEPTION 'SECURITY VIOLATION: Cross-user folder attachment rejected (Folder owner % != File owner %)', folder_owner, NEW.user_id;
    END IF;
  END IF;

  IF NEW.connected_account_id IS NOT NULL THEN
    SELECT user_id INTO account_owner FROM connected_accounts WHERE id = NEW.connected_account_id;
    IF account_owner IS NULL THEN
      RAISE EXCEPTION 'FOREIGN KEY ERROR: Referenced connected_account_id does not exist';
    END IF;
    IF account_owner <> NEW.user_id THEN
      RAISE EXCEPTION 'SECURITY VIOLATION: Cross-user connected account attachment rejected (Account owner % != File owner %)', account_owner, NEW.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_enforce_file_records_ownership ON file_records;
CREATE TRIGGER trg_enforce_file_records_ownership
  BEFORE INSERT OR UPDATE ON file_records
  FOR EACH ROW
  EXECUTE FUNCTION check_file_records_ownership();

-- Database-Level Cross-User Ownership Enforcement Trigger (Jobs)
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

-- Atomic Capacity Selection & Reservation Stored Function (FOR UPDATE Locking)
CREATE OR REPLACE FUNCTION create_storage_reservation_atomic(
  p_user_id UUID,
  p_file_record_id UUID,
  p_file_size_bytes BIGINT,
  p_idempotency_key TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS JSONB AS $$
DECLARE
  v_existing storage_reservations%ROWTYPE;
  v_account connected_accounts%ROWTYPE;
  v_rec RECORD;
  v_best_account connected_accounts%ROWTYPE;
  v_max_net_bytes BIGINT := -1;
  v_reservation storage_reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_existing
  FROM storage_reservations
  WHERE idempotency_key = p_idempotency_key
    AND released_at IS NULL
    AND expires_at > NOW()
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    SELECT * INTO v_account FROM connected_accounts WHERE id = v_existing.connected_account_id;
    RETURN jsonb_build_object(
      'reservation', to_jsonb(v_existing),
      'account', to_jsonb(v_account),
      'is_reused', true
    );
  END IF;

  FOR v_rec IN
    SELECT ca.*,
           (ca.storage_total_bytes - ca.storage_used_bytes) - COALESCE(
             (SELECT SUM(sr.reserved_bytes)
              FROM storage_reservations sr
              WHERE sr.connected_account_id = ca.id
                AND sr.released_at IS NULL
                AND sr.expires_at > NOW()
             ), 0
           ) AS net_available_bytes
    FROM connected_accounts ca
    WHERE ca.user_id = p_user_id
    FOR UPDATE OF ca
  LOOP
    IF v_rec.net_available_bytes > v_max_net_bytes THEN
      v_max_net_bytes := v_rec.net_available_bytes;
      v_best_account.id := v_rec.id;
      v_best_account.user_id := v_rec.user_id;
      v_best_account.google_email := v_rec.google_email;
      v_best_account.vault_secret_id := v_rec.vault_secret_id;
      v_best_account.storage_used_bytes := v_rec.storage_used_bytes;
      v_best_account.storage_total_bytes := v_rec.storage_total_bytes;
    END IF;
  END LOOP;

  IF v_best_account.id IS NULL THEN
    RAISE EXCEPTION 'NO_CONNECTED_ACCOUNTS: No Google Drive accounts found for user %', p_user_id;
  END IF;

  IF v_max_net_bytes < p_file_size_bytes THEN
    RAISE EXCEPTION 'INSUFFICIENT_CAPACITY: File size (% bytes) exceeds available capacity (% bytes)', p_file_size_bytes, v_max_net_bytes;
  END IF;

  INSERT INTO storage_reservations (
    file_record_id,
    connected_account_id,
    reserved_bytes,
    idempotency_key,
    expires_at
  )
  VALUES (
    p_file_record_id,
    v_best_account.id,
    p_file_size_bytes,
    p_idempotency_key,
    p_expires_at
  )
  ON CONFLICT (idempotency_key) DO UPDATE
    SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING * INTO v_reservation;

  RETURN jsonb_build_object(
    'reservation', to_jsonb(v_reservation),
    'account', to_jsonb(v_best_account),
    'is_reused', false
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## 2. Repository Structure

```
.
├── .env.example
├── .env.local
├── .gitignore
├── AGENTS.md
├── CLAUDE.md
├── docs
│   ├── archive
│   │   ├── PHASE-1-REPORT-draft.md
│   │   ├── PHASE-2-REPORT-draft.md
│   │   ├── PHASE-3-INDEPENDENT-AUDIT.md
│   │   ├── PHASE-3-REPORT-V2.md
│   │   └── PHASE-3-REPORT.md
│   ├── phase-1
│   │   ├── REMEDIATION-PHASE-1.md
│   │   ├── REPORT-PHASE-1.md
│   │   └── SPEC-PHASE-1.md
│   ├── phase-2
│   │   ├── REMEDIATION-PHASE-2.md
│   │   ├── REPORT-PHASE-2.md
│   │   └── SPEC-PHASE-2.md
│   ├── phase-3
│   │   ├── AUDIT-PHASE-3.md
│   │   ├── REPORT-PHASE-3.md
│   │   └── SPEC-PHASE-3.md
│   ├── phase-4
│   │   ├── PHASE-4-REMEDIATION-PLAN-V2.md
│   │   ├── PHASE-4-REMEDIATION-PLAN-V3.md
│   │   ├── phase-4-test-matrix.json
│   │   ├── REPORT-PHASE-4.md
│   │   └── SPEC-PHASE-4.md
│   └── phase-5
│       └── phase-5-test-matrix.json
├── eslint.config.mjs
├── git
├── next-env.d.ts
├── next.config.ts
├── package-lock.json
├── package.json
├── PHASE-5-RELIABLE-OPERATIONS.md
├── postcss.config.mjs
├── public
│   ├── file.svg
│   ├── globe.svg
│   ├── next.svg
│   ├── vercel.svg
│   └── window.svg
├── README.md
├── src
│   ├── app
│   │   ├── api
│   │   │   ├── accounts
│   │   │   ├── auth
│   │   │   ├── files
│   │   │   ├── folders
│   │   │   ├── jobs
│   │   │   ├── share
│   │   │   └── storage
│   │   ├── favicon.ico
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components
│   │   ├── AuthModal.tsx
│   │   ├── DuplicateFinder.tsx
│   │   ├── FileBrowser.tsx
│   │   ├── FilePreviewModal.tsx
│   │   ├── Navbar.tsx
│   │   ├── RecyclingBin.tsx
│   │   ├── ShareModal.tsx
│   │   ├── StorageAnalytics.tsx
│   │   ├── StorageDashboard.tsx
│   │   └── UploadModal.tsx
│   └── lib
│       ├── auth.ts
│       ├── config.ts
│       ├── google-drive.ts
│       ├── job-engine.ts
│       ├── jobs
│       │   ├── archive-handler.ts
│       │   ├── delete-handler.ts
│       │   ├── migration-handler.ts
│       │   ├── reconciliation-sweep.ts
│       │   └── upload-handler.ts
│       ├── storage-engine.ts
│       ├── supabase
│       │   ├── client.ts
│       │   └── server.ts
│       └── vault.ts
├── supabase
│   ├── migrations
│   │   ├── phase1_remediation.sql
│   │   ├── phase3_database_architecture.sql
│   │   ├── phase4_storage_engine.sql
│   │   ├── phase4_storage_engine_remediation.sql
│   │   └── phase5_job_engine.sql
│   └── schema.sql
├── tests
│   ├── phase5-jobs.test.ts
│   └── security.test.ts
├── tsconfig.json
└── tsconfig.tsbuildinfo
```

---

## 3. Phase History & Verification Summary

### Phase 5 Acceptance Test Matrix (`docs/phase-5/phase-5-test-matrix.json`)
- **Total Tests Executed**: 21
- **Passed**: 21
- **Failed**: 0
- **Database Engine**: 100% Real PostgreSQL execution on cloud Supabase.

| # | Test Scenario ID | Description | Result | Final Job State | Final File State | Error Code |
|---|---|---|---|---|---|---|
| 1 | `job-idempotency-key-reuse` | Duplicate job creation carrying same idempotency key returns existing job | **PASS** | `PENDING` | `none` | `NONE` |
| 2 | `worker-lease-atomic-acquisition` | Job lease acquired atomically; second worker cannot acquire same RUNNING job | **PASS** | `RUNNING` | `none` | `NONE` |
| 3 | `worker-crash-lease-expiration` | Worker crash leaves lease to expire; reconciliation sweep reclaims job to PENDING | **PASS** | `PENDING` | `none` | `WORKER_LEASE_EXPIRED` |
| 4 | `upload-job-crash-1-percent` | Upload job crash at ~1% (before reservation) recovers cleanly to COMPLETED | **PASS** | `COMPLETED` | `complete` | `NONE` |
| 5 | `upload-job-crash-50-percent` | Upload job crash at ~50% (mid-transfer) recovers via idempotent retry | **PASS** | `COMPLETED` | `complete` | `NONE` |
| 6 | `upload-job-crash-99-percent` | Upload job crash at ~99% recovers to COMPLETED without re-uploading | **PASS** | `COMPLETED` | `complete` | `NONE` |
| 7 | `migration-job-crash-1-percent` | Migration job crash at ~1% leaves source untouched, job resumable | **PASS** | `PENDING` | `complete` | `NONE` |
| 8 | `migration-job-crash-50-percent` | Migration job crash at ~50% detects destination state before acting | **PASS** | `PENDING` | `complete` | `NONE` |
| 9 | `migration-job-crash-99-percent` | Migration job crash at ~99% deletes source on resume, completes with no data loss | **PASS** | `VERIFYING` | `complete` | `NONE` |
| 10 | `migration-job-checksum-mismatch` | Migration verification mismatch does NOT delete source; job fails cleanly | **PASS** | `FAILED` | `intact` | `VERIFICATION_MISMATCH` |
| 11 | `delete-job-idempotent-retry` | Delete job retried after provider returns 404 treated as success | **PASS** | `COMPLETED` | `deleted` | `NONE` |
| 12 | `delete-job-confirmation-recheck` | Delete job confirmation step independently re-checks object absence | **PASS** | `COMPLETED` | `deleted` | `NONE` |
| 13 | `archive-job-partial-file-failure` | Archive job with invalid source file fails cleanly without marking truncated archive complete | **PASS** | `FAILED` | `none` | `PARTIAL_FAILURE` |
| 14 | `archive-job-crash-resume` | Archive job crash resumes from last completed file, not from scratch | **PASS** | `PENDING` | `none` | `NONE` |
| 15 | `retry-exponential-backoff` | Retry backoff interval grows exponentially with random jitter across attempts | **PASS** | `none` | `none` | `NONE` |
| 16 | `non-retryable-failure-immediate` | Non-retryable failure (checksum mismatch/security) goes straight to FAILED without retrying | **PASS** | `FAILED` | `none` | `VERIFICATION_MISMATCH` |
| 17 | `cancellation-before-point-of-no-return` | Cancellation before point of no return leaves system consistent and marks CANCELLED | **PASS** | `CANCELLED` | `none` | `CANCELLED_BY_USER` |
| 18 | `cancellation-after-point-of-no-return` | Cancellation requested after point of no return is rejected, operation remains COMPLETED | **PASS** | `COMPLETED` | `complete` | `NONE` |
| 19 | `orphan-sweep-age-threshold` | Orphan sweep reclaims object past age threshold and leaves too-recent one alone | **PASS** | `none` | `orphaned` | `NONE` |
| 20 | `illegal-job-state-transition` | Illegal job state transition (PENDING -> COMPLETED directly) is structurally rejected | **PASS** | `PENDING` | `none` | `ILLEGAL_JOB_TRANSITION` |
| 21 | `job-file-state-consistency` | Job state and file_records.upload_state maintain consistent lifecycle alignment | **PASS** | `PENDING` | `pending` | `NONE` |

---

## 4. Core Configuration & Architecture

### `package.json`
```json
{
  "name": "multidrive-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "npx tsx tests/security.test.ts"
  },
  "dependencies": {
    "@supabase/ssr": "^0.12.5",
    "@supabase/supabase-js": "^2.112.4",
    "archiver": "^8.0.0",
    "clsx": "^2.1.1",
    "googleapis": "^176.0.0",
    "lucide-react": "^1.37.0",
    "next": "16.3.3",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "tailwind-merge": "^3.6.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/archiver": "^8.0.0",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.3.3",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": ["node_modules"]
}
```

### `next.config.ts`
```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
```

### `.env.example`
```env
# MultiDrive Environment Configuration Template
# Copy this file to .env.local for local development. Do NOT commit .env.local to version control!

# 1. Supabase Backend Database Configuration
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

# 2. Vault Encryption Secret
# MUST be a high-entropy, random secret at least 32 characters long.
# Do NOT use default, hardcoded, or weak secrets.
ENCRYPTION_SECRET=your-32-character-minimum-random-encryption-secret

# 3. Google OAuth Credentials (Google Cloud Console -> APIs & Services -> Credentials)
# Set redirect URI in Google Cloud Console to: ${NEXT_PUBLIC_APP_URL}/api/auth/google/callback
GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret

# 4. Application Public URL
# Set to exact domain (e.g., https://multidrive-app.vercel.app for production or http://localhost:3000 for dev)
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

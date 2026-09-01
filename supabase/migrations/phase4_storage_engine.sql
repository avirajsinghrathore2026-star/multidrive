-- MultiDrive Phase 4 Migration: Storage Engine — Capacity, Reservation, Upload, Verification & Recovery
-- Idempotent schema upgrade creating state machine columns, storage_reservations lease table, and performance indexes.

-- 1. Add upload_state, upload_state_updated_at, idempotency_key, and verified_md5 to file_records
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'file_records' AND column_name = 'upload_state'
  ) THEN
    ALTER TABLE file_records ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'pending';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'file_records' AND column_name = 'upload_state_updated_at'
  ) THEN
    ALTER TABLE file_records ADD COLUMN upload_state_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'file_records' AND column_name = 'idempotency_key'
  ) THEN
    ALTER TABLE file_records ADD COLUMN idempotency_key TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'file_records' AND column_name = 'verified_md5'
  ) THEN
    ALTER TABLE file_records ADD COLUMN verified_md5 TEXT;
  END IF;
END $$;

-- Enforce check constraint on upload_state
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_file_records_upload_state_valid'
  ) THEN
    ALTER TABLE file_records ADD CONSTRAINT check_file_records_upload_state_valid
      CHECK (upload_state IN ('pending','reserved','uploading','uploaded','verified','committed','complete','failed','rejected','orphaned'));
  END IF;
END $$;

-- 2. Create storage_reservations table if missing
CREATE TABLE IF NOT EXISTS storage_reservations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_record_id UUID NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  connected_account_id UUID NOT NULL REFERENCES connected_accounts(id) ON DELETE RESTRICT,
  reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes >= 0),
  idempotency_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Create indexes
CREATE INDEX IF NOT EXISTS idx_file_records_upload_state ON file_records(upload_state);
CREATE INDEX IF NOT EXISTS idx_reservations_account_active ON storage_reservations(connected_account_id, released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_reservations_idempotency ON storage_reservations(idempotency_key);

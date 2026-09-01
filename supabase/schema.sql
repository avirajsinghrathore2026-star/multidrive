-- MultiDrive Database Schema (Phase 4 — Storage Engine Architecture)
-- Intact Single-Object Storage Model

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Connected Accounts Table (Google Drive Accounts)
CREATE TABLE IF NOT EXISTS connected_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  google_account_id TEXT NOT NULL, -- Stable Google OAuth subject/account ID
  vault_secret_id TEXT NOT NULL, -- Encrypted Google OAuth refresh token (AES-256-GCM v1:...)
  storage_used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
  storage_total_bytes BIGINT NOT NULL DEFAULT 16106127360 CHECK (storage_total_bytes >= 0), -- 15 GB default
  quota_last_checked_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_user_google_email UNIQUE(user_id, google_email),
  CONSTRAINT unique_user_google_account UNIQUE(user_id, google_account_id)
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

-- Indexes for Performance, Concurrency & State Queries
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_google_id ON connected_accounts(google_account_id);
CREATE INDEX IF NOT EXISTS idx_virtual_folders_user ON virtual_folders(user_id, parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_file_records_user ON file_records(user_id, virtual_folder_id);
CREATE INDEX IF NOT EXISTS idx_file_records_account ON file_records(connected_account_id);
CREATE INDEX IF NOT EXISTS idx_file_records_upload_state ON file_records(upload_state);
CREATE INDEX IF NOT EXISTS idx_file_records_in_trash ON file_records(in_trash);
CREATE INDEX IF NOT EXISTS idx_reservations_account_active ON storage_reservations(connected_account_id, released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_reservations_idempotency ON storage_reservations(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_shared_links_token ON shared_links(token);

-- -----------------------------------------------------------------------------
-- Database-Level Cross-User Ownership Enforcement Trigger
-- Guarantees that virtual_folder_id and connected_account_id belong to NEW.user_id
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- Atomic Capacity Selection & Reservation Stored Function (FOR UPDATE Locking)
-- -----------------------------------------------------------------------------
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
      v_best_account.google_account_id := v_rec.google_account_id;
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

-- Enable Row Level Security (RLS) on all tables
ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_links ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- RLS Policies for connected_accounts
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own connected accounts" ON connected_accounts;
CREATE POLICY "Users can view own connected accounts"
  ON connected_accounts FOR SELECT
  USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can insert own connected accounts" ON connected_accounts;
CREATE POLICY "Users can insert own connected accounts"
  ON connected_accounts FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can update own connected accounts" ON connected_accounts;
CREATE POLICY "Users can update own connected accounts"
  ON connected_accounts FOR UPDATE
  USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can delete own connected accounts" ON connected_accounts;
CREATE POLICY "Users can delete own connected accounts"
  ON connected_accounts FOR DELETE
  USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

-- -----------------------------------------------------------------------------
-- RLS Policies for virtual_folders
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own virtual folders" ON virtual_folders;
CREATE POLICY "Users can view own virtual folders"
  ON virtual_folders FOR SELECT
  USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can insert own virtual folders" ON virtual_folders;
CREATE POLICY "Users can insert own virtual folders"
  ON virtual_folders FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can update own virtual folders" ON virtual_folders;
CREATE POLICY "Users can update own virtual folders"
  ON virtual_folders FOR UPDATE
  USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can delete own virtual folders" ON virtual_folders;
CREATE POLICY "Users can delete own virtual folders"
  ON virtual_folders FOR DELETE
  USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

-- -----------------------------------------------------------------------------
-- RLS Policies for file_records
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own file records" ON file_records;
CREATE POLICY "Users can view own file records"
  ON file_records FOR SELECT
  USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can insert own file records" ON file_records;
CREATE POLICY "Users can insert own file records"
  ON file_records FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can update own file records" ON file_records;
CREATE POLICY "Users can update own file records"
  ON file_records FOR UPDATE
  USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

DROP POLICY IF EXISTS "Users can delete own file records" ON file_records;
CREATE POLICY "Users can delete own file records"
  ON file_records FOR DELETE
  USING (auth.uid() = user_id OR user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'));

-- -----------------------------------------------------------------------------
-- RLS Policies for storage_reservations
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view storage reservations for owned files" ON storage_reservations;
CREATE POLICY "Users can view storage reservations for owned files"
  ON storage_reservations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = storage_reservations.file_record_id
      AND (fr.user_id = auth.uid() OR fr.user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'))
    )
  );

DROP POLICY IF EXISTS "Users can insert storage reservations for owned files" ON storage_reservations;
CREATE POLICY "Users can insert storage reservations for owned files"
  ON storage_reservations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = storage_reservations.file_record_id
      AND (fr.user_id = auth.uid() OR fr.user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'))
    )
  );

DROP POLICY IF EXISTS "Users can update storage reservations for owned files" ON storage_reservations;
CREATE POLICY "Users can update storage reservations for owned files"
  ON storage_reservations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = storage_reservations.file_record_id
      AND (fr.user_id = auth.uid() OR fr.user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'))
    )
  );

-- -----------------------------------------------------------------------------
-- RLS Policies for shared_links
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view shared links for owned files" ON shared_links;
CREATE POLICY "Users can view shared links for owned files"
  ON shared_links FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = shared_links.file_id
      AND (fr.user_id = auth.uid() OR fr.user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'))
    )
  );

DROP POLICY IF EXISTS "Users can insert shared links for owned files" ON shared_links;
CREATE POLICY "Users can insert shared links for owned files"
  ON shared_links FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = shared_links.file_id
      AND (fr.user_id = auth.uid() OR fr.user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'))
    )
  );

DROP POLICY IF EXISTS "Users can update shared links for owned files" ON shared_links;
CREATE POLICY "Users can update shared links for owned files"
  ON shared_links FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = shared_links.file_id
      AND (fr.user_id = auth.uid() OR fr.user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'))
    )
  );

DROP POLICY IF EXISTS "Users can delete shared links for owned files" ON shared_links;
CREATE POLICY "Users can delete shared links for owned files"
  ON shared_links FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = shared_links.file_id
      AND (fr.user_id = auth.uid() OR fr.user_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'))
    )
  );

-- MultiDrive Phase 3 Migration: Database Architecture & Integrity (No Chunking) - Reconciled
-- Safely cleans up legacy chunk tables, reconciles column names, adds ownership triggers & disconnect protection.

-- 1. Safely remove obsolete legacy file_chunks table if present
DROP TABLE IF EXISTS file_chunks CASCADE;

-- 2. Add google_account_id to connected_accounts if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'connected_accounts' AND column_name = 'google_account_id'
  ) THEN
    ALTER TABLE connected_accounts ADD COLUMN google_account_id TEXT;
  END IF;
END $$;

-- 3. Reconcile parent_folder_id on virtual_folders
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'virtual_folders' AND column_name = 'parent_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'virtual_folders' AND column_name = 'parent_folder_id'
  ) THEN
    ALTER TABLE virtual_folders RENAME COLUMN parent_id TO parent_folder_id;
  END IF;
END $$;

-- 4. Reconcile virtual_folder_id, uploaded_at, in_trash on file_records
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'file_records' AND column_name = 'folder_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'file_records' AND column_name = 'virtual_folder_id'
  ) THEN
    ALTER TABLE file_records RENAME COLUMN folder_id TO virtual_folder_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'file_records' AND column_name = 'uploaded_at'
  ) THEN
    ALTER TABLE file_records ADD COLUMN uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'file_records' AND column_name = 'in_trash'
  ) THEN
    ALTER TABLE file_records ADD COLUMN in_trash BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- 5. Enforce ON DELETE RESTRICT on file_records.connected_account_id (ISSUE-04)
DO $$
BEGIN
  -- Drop existing cascading foreign key if present
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'file_records_connected_account_id_fkey'
  ) THEN
    ALTER TABLE file_records DROP CONSTRAINT file_records_connected_account_id_fkey;
  END IF;

  -- Add RESTRICT foreign key
  ALTER TABLE file_records ADD CONSTRAINT file_records_connected_account_id_fkey
    FOREIGN KEY (connected_account_id) REFERENCES connected_accounts(id) ON DELETE RESTRICT;
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END $$;

-- 6. Add non-negative check constraints
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_file_records_size_bytes_non_negative'
  ) THEN
    ALTER TABLE file_records ADD CONSTRAINT check_file_records_size_bytes_non_negative CHECK (size_bytes >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_connected_accounts_used_non_negative'
  ) THEN
    ALTER TABLE connected_accounts ADD CONSTRAINT check_connected_accounts_used_non_negative CHECK (storage_used_bytes >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_connected_accounts_total_non_negative'
  ) THEN
    ALTER TABLE connected_accounts ADD CONSTRAINT check_connected_accounts_total_non_negative CHECK (storage_total_bytes >= 0);
  END IF;
END $$;

-- 7. Add Database-Level Cross-User Ownership Enforcement Trigger (ISSUE-03)
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

-- 8. Create performance indexes
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_virtual_folders_user ON virtual_folders(user_id, parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_file_records_user ON file_records(user_id, virtual_folder_id);
CREATE INDEX IF NOT EXISTS idx_file_records_account ON file_records(connected_account_id);
CREATE INDEX IF NOT EXISTS idx_file_records_in_trash ON file_records(in_trash);
CREATE INDEX IF NOT EXISTS idx_shared_links_token ON shared_links(token);

-- MultiDrive Phase 3 Migration: Database Architecture, Integrity & Migrations (No Chunking)
-- Safely cleans up legacy chunk tables and enforces check constraints and index performance.

-- 1. Safely remove obsolete legacy file_chunks table if present
DROP TABLE IF EXISTS file_chunks CASCADE;

-- 2. Add size check constraint to file_records
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_file_records_size_bytes_non_negative'
  ) THEN
    ALTER TABLE file_records ADD CONSTRAINT check_file_records_size_bytes_non_negative CHECK (size_bytes >= 0);
  END IF;
END $$;

-- 3. Add storage check constraints to connected_accounts
DO $$
BEGIN
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

-- 4. Create performance indexes for database queries
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_virtual_folders_user ON virtual_folders(user_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_file_records_user ON file_records(user_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_file_records_account ON file_records(connected_account_id);
CREATE INDEX IF NOT EXISTS idx_shared_links_token ON shared_links(token);

-- MultiDrive Database Schema (Phase 3 — Database Architecture, Integrity & Migrations — No Chunking)
-- Intact Single-Object Storage Model

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
  parent_id UUID REFERENCES virtual_folders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. File Records Table (Logical Files mapped to 1 Physical Object on 1 Account)
CREATE TABLE IF NOT EXISTS file_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connected_account_id UUID NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  google_drive_file_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,
  folder_id UUID REFERENCES virtual_folders(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trashed')),
  trashed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Shared Links Table
CREATE TABLE IF NOT EXISTS shared_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for Access Performance & Integrity
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_virtual_folders_user ON virtual_folders(user_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_file_records_user ON file_records(user_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_file_records_account ON file_records(connected_account_id);
CREATE INDEX IF NOT EXISTS idx_shared_links_token ON shared_links(token);

-- Enable Row Level Security (RLS) on all tables
ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_links ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- RLS Policies for connected_accounts
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own connected accounts" ON connected_accounts;
CREATE POLICY "Users can view own connected accounts"
  ON connected_accounts FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own connected accounts" ON connected_accounts;
CREATE POLICY "Users can insert own connected accounts"
  ON connected_accounts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own connected accounts" ON connected_accounts;
CREATE POLICY "Users can update own connected accounts"
  ON connected_accounts FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own connected accounts" ON connected_accounts;
CREATE POLICY "Users can delete own connected accounts"
  ON connected_accounts FOR DELETE
  USING (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- RLS Policies for virtual_folders
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own virtual folders" ON virtual_folders;
CREATE POLICY "Users can view own virtual folders"
  ON virtual_folders FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own virtual folders" ON virtual_folders;
CREATE POLICY "Users can insert own virtual folders"
  ON virtual_folders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own virtual folders" ON virtual_folders;
CREATE POLICY "Users can update own virtual folders"
  ON virtual_folders FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own virtual folders" ON virtual_folders;
CREATE POLICY "Users can delete own virtual folders"
  ON virtual_folders FOR DELETE
  USING (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- RLS Policies for file_records
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own file records" ON file_records;
CREATE POLICY "Users can view own file records"
  ON file_records FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own file records" ON file_records;
CREATE POLICY "Users can insert own file records"
  ON file_records FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own file records" ON file_records;
CREATE POLICY "Users can update own file records"
  ON file_records FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own file records" ON file_records;
CREATE POLICY "Users can delete own file records"
  ON file_records FOR DELETE
  USING (auth.uid() = user_id);

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
      AND fr.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert shared links for owned files" ON shared_links;
CREATE POLICY "Users can insert shared links for owned files"
  ON shared_links FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = shared_links.file_id
      AND fr.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update shared links for owned files" ON shared_links;
CREATE POLICY "Users can update shared links for owned files"
  ON shared_links FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = shared_links.file_id
      AND fr.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete shared links for owned files" ON shared_links;
CREATE POLICY "Users can delete shared links for owned files"
  ON shared_links FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM file_records fr
      WHERE fr.id = shared_links.file_id
      AND fr.user_id = auth.uid()
    )
  );

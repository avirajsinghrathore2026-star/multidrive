-- MultiDrive Supabase Database Schema (Phase 1 Secure Architecture)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

--------------------------------------------------------------------------------
-- 1. Connected Accounts Table
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  google_email TEXT NOT NULL,
  vault_secret_id TEXT NOT NULL,
  storage_used_bytes BIGINT NOT NULL DEFAULT 0,
  storage_total_bytes BIGINT NOT NULL DEFAULT 16106127360, -- 15 GB default
  quota_last_checked_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE public.connected_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own connected accounts" ON public.connected_accounts;
CREATE POLICY "Users can manage their own connected accounts"
  ON public.connected_accounts
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

--------------------------------------------------------------------------------
-- 2. Virtual Folders Table
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.virtual_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  parent_folder_id UUID REFERENCES public.virtual_folders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE public.virtual_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own virtual folders" ON public.virtual_folders;
CREATE POLICY "Users can manage their own virtual folders"
  ON public.virtual_folders
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

--------------------------------------------------------------------------------
-- 3. File Records Table
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.file_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  filename TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  mime_type TEXT NOT NULL,
  connected_account_id UUID REFERENCES public.connected_accounts(id) ON DELETE CASCADE NOT NULL,
  virtual_folder_id UUID REFERENCES public.virtual_folders(id) ON DELETE SET NULL,
  google_drive_file_id TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  in_trash BOOLEAN DEFAULT FALSE NOT NULL,
  deleted_at TIMESTAMPTZ
);

ALTER TABLE public.file_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own file records" ON public.file_records;
CREATE POLICY "Users can manage their own file records"
  ON public.file_records
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

--------------------------------------------------------------------------------
-- 4. Shared Links Table
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shared_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID REFERENCES public.file_records(id) ON DELETE CASCADE NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  password_hash TEXT,
  views_count INT DEFAULT 0 NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE public.shared_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage shared links for their files" ON public.shared_links;
CREATE POLICY "Users can manage shared links for their files"
  ON public.shared_links
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.file_records fr
      WHERE fr.id = shared_links.file_id AND fr.user_id = auth.uid()
    )
  );

--------------------------------------------------------------------------------
-- 5. File Chunks Table
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.file_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_file_id UUID REFERENCES public.file_records(id) ON DELETE CASCADE NOT NULL,
  chunk_index INT NOT NULL,
  connected_account_id UUID REFERENCES public.connected_accounts(id) ON DELETE CASCADE NOT NULL,
  google_drive_file_id TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE public.file_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage file chunks for their files" ON public.file_chunks;
CREATE POLICY "Users can manage file chunks for their files"
  ON public.file_chunks
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.file_records fr
      WHERE fr.id = file_chunks.parent_file_id AND fr.user_id = auth.uid()
    )
  );

--------------------------------------------------------------------------------
-- Performance Indexes
--------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON public.connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_virtual_folders_user ON public.virtual_folders(user_id, parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_file_records_user_trash ON public.file_records(user_id, in_trash);
CREATE INDEX IF NOT EXISTS idx_file_records_account ON public.file_records(connected_account_id);
CREATE INDEX IF NOT EXISTS idx_shared_links_token ON public.shared_links(token);

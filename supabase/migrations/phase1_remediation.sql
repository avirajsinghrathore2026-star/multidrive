-- MultiDrive Phase 1 Security Migration: Identity, Authentication & Ownership Enforcements

-- 1. Remove orphaned test records created without user ownership during initial prototyping
DELETE FROM public.file_records WHERE user_id IS NULL;
DELETE FROM public.virtual_folders WHERE user_id IS NULL;
DELETE FROM public.connected_accounts WHERE user_id IS NULL;

-- 2. Enforce NOT NULL constraints on ownership columns
ALTER TABLE public.connected_accounts ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.virtual_folders ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.file_records ALTER COLUMN user_id SET NOT NULL;

-- 3. Replace RLS Policies to strictly enforce auth.uid() = user_id (Remove OR user_id IS NULL)
DROP POLICY IF EXISTS "Users can manage their own connected accounts" ON public.connected_accounts;
CREATE POLICY "Users can manage their own connected accounts"
  ON public.connected_accounts
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage their own virtual folders" ON public.virtual_folders;
CREATE POLICY "Users can manage their own virtual folders"
  ON public.virtual_folders
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage their own file records" ON public.file_records;
CREATE POLICY "Users can manage their own file records"
  ON public.file_records
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

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

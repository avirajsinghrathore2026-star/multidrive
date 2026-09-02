import { createClient, createAdminClient } from '@/lib/supabase/server';

export class AuthError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

export interface AuthenticatedContext {
  user: {
    id: string;
    email?: string;
  };
  supabase: Awaited<ReturnType<typeof createClient>>;
  adminSupabase: Awaited<ReturnType<typeof createAdminClient>>;
}

/**
 * Centralized authentication primitive for private routes.
 * Enforces that a valid authenticated Supabase session exists.
 * Throws AuthError(401) if unauthenticated. Never returns null for user.
 */
export async function requireUser(): Promise<AuthenticatedContext> {
  const supabase = await createClient();
  const adminSupabase = await createAdminClient();

  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    throw new AuthError('Authentication required. Invalid or missing session.', 401);
  }

  return {
    user: {
      id: user.id,
      email: user.email,
    },
    supabase,
    adminSupabase,
  };
}

/**
 * Verify that a file record belongs strictly to the authenticated user.
 * Returns file record if owned, throws AuthError(403 or 404) if unauthorized/not found.
 */
export async function requireOwnedFile(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  fileId: string
) {
  const { data: file, error } = await supabase
    .from('file_records')
    .select('*, connected_accounts(*)')
    .eq('id', fileId)
    .single();

  if (error || !file) {
    throw new AuthError('File non-existent or access denied.', 404);
  }

  if (file.user_id !== userId) {
    throw new AuthError('Access denied to requested file.', 403);
  }

  return file;
}

/**
 * Verify that a virtual folder belongs strictly to the authenticated user.
 */
export async function requireOwnedFolder(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  folderId: string
) {
  const { data: folder, error } = await supabase
    .from('virtual_folders')
    .select('*')
    .eq('id', folderId)
    .single();

  if (error || !folder) {
    throw new AuthError('Folder non-existent or access denied.', 404);
  }

  if (folder.user_id !== userId) {
    throw new AuthError('Access denied to requested folder.', 403);
  }

  return folder;
}

/**
 * Verify that a connected Google account belongs strictly to the authenticated user.
 */
export async function requireOwnedAccount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  accountId: string
) {
  const { data: account, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('id', accountId)
    .single();

  if (error || !account) {
    throw new AuthError('Account non-existent or access denied.', 404);
  }

  if (account.user_id !== userId) {
    throw new AuthError('Access denied to requested connected account.', 403);
  }

  return account;
}

import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { successResponse, handleApiError, parseAndValidateJson, checkRateLimit, errorResponse } from '@/lib/api-utils';
import { CreateFolderSchema } from '@/lib/schemas/api-schemas';

export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();

    const { data, error } = await supabase
      .from('virtual_folders')
      .select('*')
      .eq('user_id', user.id)
      .order('name', { ascending: true });

    if (error) throw error;

    return successResponse({ folders: data });
  } catch (err: any) {
    return handleApiError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();

    // Rate Limiting Check
    const rateLimit = await checkRateLimit(`folders_create:${user.id}`, 30, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Folder creation rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    const validated = await parseAndValidateJson(request, CreateFolderSchema);

    const { data, error } = await supabase
      .from('virtual_folders')
      .insert({
        user_id: user.id,
        name: validated.name,
        parent_folder_id: validated.parentFolderId || null,
      })
      .select('*')
      .single();

    if (error) throw error;

    return successResponse({ folder: data }, 201);
  } catch (err: any) {
    return handleApiError(err);
  }
}

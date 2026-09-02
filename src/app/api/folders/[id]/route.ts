import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFolder } from '@/lib/auth';
import { successResponse, errorResponse, handleApiError, parseAndValidateJson, checkRateLimit } from '@/lib/api-utils';
import { z } from 'zod';

const RenameFolderSchema = z.object({
  name: z.string().min(1, 'Folder name cannot be empty').max(255),
});

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, adminSupabase } = await requireUser();

    await requireOwnedFolder(adminSupabase, user.id, id);

    // Move all files in this folder back to root before deleting
    await adminSupabase
      .from('file_records')
      .update({ virtual_folder_id: null })
      .eq('virtual_folder_id', id)
      .eq('user_id', user.id);

    // Delete the folder itself
    const { error } = await adminSupabase
      .from('virtual_folders')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) throw error;

    return successResponse({ success: true, message: 'Folder deleted. Files moved to root.' });
  } catch (err: any) {
    return handleApiError(err);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, adminSupabase } = await requireUser();

    const rateLimit = await (await import('@/lib/api-utils')).checkRateLimit(`folder_rename:${user.id}`, 20, 60);
    if (!rateLimit.allowed) {
      return errorResponse('RATE_LIMIT_EXCEEDED', 'Folder rename rate limit exceeded.', { resetSeconds: rateLimit.resetSeconds }, 429);
    }

    await requireOwnedFolder(adminSupabase, user.id, id);
    const validated = await parseAndValidateJson(request, RenameFolderSchema);

    const { data, error } = await adminSupabase
      .from('virtual_folders')
      .update({ name: validated.name })
      .eq('id', id)
      .eq('user_id', user.id)
      .select('*')
      .single();

    if (error) throw error;

    return successResponse({ folder: data });
  } catch (err: any) {
    return handleApiError(err);
  }
}

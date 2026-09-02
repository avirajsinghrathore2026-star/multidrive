import { NextRequest } from 'next/server';
import { requireUser, requireOwnedFile } from '@/lib/auth';
import { deleteFileRecord } from '@/lib/storage-engine';
import { successResponse, handleApiError } from '@/lib/api-utils';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, adminSupabase } = await requireUser();
    const { id } = await params;

    const file = await requireOwnedFile(adminSupabase, user.id, id);
    return successResponse({ file });
  } catch (err: any) {
    return handleApiError(err);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, adminSupabase } = await requireUser();
    const { id } = await params;

    await requireOwnedFile(adminSupabase, user.id, id);
    await deleteFileRecord(adminSupabase, user.id, id);

    return successResponse({ success: true, message: 'File deleted successfully' });
  } catch (err: any) {
    return handleApiError(err);
  }
}

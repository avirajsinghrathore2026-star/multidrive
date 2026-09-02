import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { successResponse, handleApiError } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();
    const searchParams = request.nextUrl.searchParams;
    const folderId = searchParams.get('folderId');
    const inTrash = searchParams.get('inTrash') === 'true';

    let query = adminSupabase
      .from('file_records')
      .select('*')
      .eq('user_id', user.id)
      .eq('in_trash', inTrash);

    if (folderId) {
      query = query.eq('virtual_folder_id', folderId);
    } else if (folderId === 'null' || !folderId) {
      query = query.is('virtual_folder_id', null);
    }

    const { data, error } = await query.order('uploaded_at', { ascending: false });

    if (error) throw error;

    return successResponse({ files: data });
  } catch (err: any) {
    return handleApiError(err);
  }
}

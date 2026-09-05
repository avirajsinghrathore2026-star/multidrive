import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { successResponse, handleApiError } from '@/lib/api-utils';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { user, adminSupabase } = await requireUser();
    const searchParams = request.nextUrl.searchParams;
    const folderId = searchParams.get('folderId');
    const inTrash = searchParams.get('inTrash') === 'true';

    let query = adminSupabase
      .from('file_records')
      .select('*, connected_accounts(google_email)')
      .eq('user_id', user.id)
      .eq('in_trash', inTrash);

    // When viewing trash, skip folder filter — show all trashed files regardless of folder.
    // When folderId === 'all', skip folder filter to show all files.
    // Otherwise, filter by specific folder or root (null).
    if (!inTrash) {
      if (folderId === 'root' || !folderId) {
        query = query.is('virtual_folder_id', null);
      } else if (folderId !== 'all') {
        query = query.eq('virtual_folder_id', folderId);
      }
      // if folderId === 'all', no folder filter is applied
    }

    const { data, error } = await query.order('uploaded_at', { ascending: false });

    if (error) throw error;

    return successResponse({ files: data });
  } catch (err: any) {
    return handleApiError(err);
  }
}

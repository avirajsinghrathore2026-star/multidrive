import { NextRequest, NextResponse } from 'next/server';
import { requireUser, requireOwnedFolder, AuthError } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await requireUser();

    const searchParams = request.nextUrl.searchParams;
    const folderId = searchParams.get('folderId');

    // If a specific folder is requested, verify folder ownership first
    if (folderId && folderId !== 'root' && folderId !== 'all') {
      await requireOwnedFolder(supabase, user.id, folderId);
    }

    let query = supabase
      .from('file_records')
      .select(`
        *,
        connected_accounts (
          google_email
        )
      `)
      .eq('user_id', user.id)
      .eq('in_trash', false);

    if (folderId === 'root' || !folderId) {
      query = query.is('virtual_folder_id', null);
    } else if (folderId !== 'all') {
      query = query.eq('virtual_folder_id', folderId);
    }

    const { data: files, error } = await query.order('uploaded_at', { ascending: false });

    if (error) {
      console.error('Error fetching file records:', error);
      return NextResponse.json({ error: 'Failed to fetch files' }, { status: 500 });
    }

    return NextResponse.json({ files: files || [] });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    console.error('Files GET error:', err);
    return NextResponse.json({ error: 'Failed to fetch files' }, { status: 500 });
  }
}

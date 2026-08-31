import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const folderId = searchParams.get('folderId');

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    let query = supabase.from('file_records').select(`
      *,
      connected_accounts (
        google_email
      )
    `);

    if (user) {
      query = query.eq('user_id', user.id);
    }

    if (folderId === 'root' || !folderId) {
      query = query.is('virtual_folder_id', null);
    } else if (folderId !== 'all') {
      query = query.eq('virtual_folder_id', folderId);
    }

    const { data: files, error } = await query.order('uploaded_at', { ascending: false });

    if (error) {
      console.error('Error fetching file records:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ files: files || [] });
  } catch (err) {
    console.error('Files GET error:', err);
    return NextResponse.json({ error: 'Failed to fetch files' }, { status: 500 });
  }
}

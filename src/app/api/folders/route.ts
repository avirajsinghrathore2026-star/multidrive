import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// GET /api/folders - List virtual folders
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const parentId = searchParams.get('parentId');

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    let query = supabase.from('virtual_folders').select('*');

    if (user) {
      query = query.eq('user_id', user.id);
    }

    if (parentId === 'root' || !parentId) {
      query = query.is('parent_folder_id', null);
    } else if (parentId !== 'all') {
      query = query.eq('parent_folder_id', parentId);
    }

    const { data: folders, error } = await query.order('name', { ascending: true });

    if (error) {
      console.error('Folders GET error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ folders: folders || [] });
  } catch (err) {
    console.error('Folders GET route error:', err);
    return NextResponse.json({ error: 'Failed to fetch folders' }, { status: 500 });
  }
}

// POST /api/folders - Create new virtual folder
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, parentFolderId } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    const userId = user?.id || null;

    const { data: folder, error } = await supabase
      .from('virtual_folders')
      .insert({
        user_id: userId,
        name: name.trim(),
        parent_folder_id: parentFolderId || null,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to create folder:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, folder });
  } catch (err) {
    console.error('Folder create error:', err);
    return NextResponse.json({ error: 'Failed to create folder' }, { status: 500 });
  }
}

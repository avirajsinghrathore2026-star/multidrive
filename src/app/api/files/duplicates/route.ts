import { NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';

export async function GET() {
  try {
    const { user, adminSupabase } = await requireUser();

    const { data: files, error } = await adminSupabase
      .from('file_records')
      .select('*, connected_accounts(google_email)')
      .eq('user_id', user.id)
      .eq('in_trash', false);

    if (error || !files) {
      return NextResponse.json({ error: 'Failed to scan for duplicate files' }, { status: 500 });
    }

    const map = new Map<string, typeof files>();

    files.forEach((file) => {
      const key = `${file.filename.toLowerCase()}_${file.size_bytes}`;
      const existing = map.get(key) || [];
      existing.push(file);
      map.set(key, existing);
    });

    const duplicates = Array.from(map.values()).filter((group) => group.length > 1);

    return NextResponse.json({ duplicates });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Failed to scan for duplicates' }, { status: 500 });
  }
}

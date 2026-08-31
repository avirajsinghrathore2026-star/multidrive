import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    let query = supabase
      .from('file_records')
      .select('*, connected_accounts(google_email)')
      .eq('in_trash', false);

    if (user) {
      query = query.eq('user_id', user.id);
    }

    const { data: files, error } = await query;

    if (error || !files) {
      return NextResponse.json({ error: error?.message || 'Failed to fetch files' }, { status: 500 });
    }

    const categories: Record<string, { count: number; bytes: number }> = {
      Images: { count: 0, bytes: 0 },
      Videos: { count: 0, bytes: 0 },
      Audio: { count: 0, bytes: 0 },
      Documents: { count: 0, bytes: 0 },
      Archives: { count: 0, bytes: 0 },
      Other: { count: 0, bytes: 0 },
    };

    let totalStorageBytes = 0;

    for (const f of files) {
      const size = Number(f.size_bytes || 0);
      totalStorageBytes += size;
      const mime = f.mime_type.toLowerCase();

      if (mime.startsWith('image/')) {
        categories.Images.count++;
        categories.Images.bytes += size;
      } else if (mime.startsWith('video/')) {
        categories.Videos.count++;
        categories.Videos.bytes += size;
      } else if (mime.startsWith('audio/')) {
        categories.Audio.count++;
        categories.Audio.bytes += size;
      } else if (
        mime.includes('pdf') ||
        mime.includes('document') ||
        mime.includes('text/') ||
        mime.includes('msword') ||
        mime.includes('presentation') ||
        mime.includes('sheet')
      ) {
        categories.Documents.count++;
        categories.Documents.bytes += size;
      } else if (
        mime.includes('zip') ||
        mime.includes('tar') ||
        mime.includes('rar') ||
        mime.includes('7z') ||
        mime.includes('compressed')
      ) {
        categories.Archives.count++;
        categories.Archives.bytes += size;
      } else {
        categories.Other.count++;
        categories.Other.bytes += size;
      }
    }

    // Top 10 Largest Files
    const topFiles = [...files]
      .sort((a, b) => Number(b.size_bytes) - Number(a.size_bytes))
      .slice(0, 10);

    return NextResponse.json({
      categories,
      totalFiles: files.length,
      totalStorageBytes,
      topFiles,
    });
  } catch (err) {
    console.error('Analytics API error:', err);
    return NextResponse.json({ error: 'Failed to compute analytics' }, { status: 500 });
  }
}

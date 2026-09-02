import { NextResponse } from 'next/server';
import { requireUser, AuthError } from '@/lib/auth';

export async function GET() {
  try {
    const { user, adminSupabase } = await requireUser();

    const { data: files, error } = await adminSupabase
      .from('file_records')
      .select('id, filename, size_bytes, mime_type, uploaded_at')
      .eq('user_id', user.id)
      .eq('in_trash', false);

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch analytics data' }, { status: 500 });
    }

    const categories: Record<string, { count: number; bytes: number }> = {
      images: { count: 0, bytes: 0 },
      videos: { count: 0, bytes: 0 },
      audio: { count: 0, bytes: 0 },
      documents: { count: 0, bytes: 0 },
      archives: { count: 0, bytes: 0 },
      other: { count: 0, bytes: 0 },
    };

    files?.forEach((file) => {
      const mime = (file.mime_type || '').toLowerCase();
      const size = Number(file.size_bytes);

      if (mime.startsWith('image/')) {
        categories.images.count++;
        categories.images.bytes += size;
      } else if (mime.startsWith('video/')) {
        categories.videos.count++;
        categories.videos.bytes += size;
      } else if (mime.startsWith('audio/')) {
        categories.audio.count++;
        categories.audio.bytes += size;
      } else if (
        mime.includes('pdf') ||
        mime.includes('document') ||
        mime.includes('text') ||
        mime.includes('sheet')
      ) {
        categories.documents.count++;
        categories.documents.bytes += size;
      } else if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar') || mime.includes('rar')) {
        categories.archives.count++;
        categories.archives.bytes += size;
      } else {
        categories.other.count++;
        categories.other.bytes += size;
      }
    });

    const topFiles = [...(files || [])]
      .sort((a, b) => Number(b.size_bytes) - Number(a.size_bytes))
      .slice(0, 10);

    return NextResponse.json({ categories, topFiles });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Failed to compute analytics' }, { status: 500 });
  }
}

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

    // Group files by filename and size_bytes
    const map = new Map<string, typeof files>();
    for (const f of files) {
      const key = `${f.filename.toLowerCase()}_${f.size_bytes}`;
      const existing = map.get(key) || [];
      existing.push(f);
      map.set(key, existing);
    }

    // Filter groups with 2 or more files
    const duplicateGroups = Array.from(map.values())
      .filter((group) => group.length > 1)
      .map((group) => {
        // Sort by uploaded_at descending (newest first)
        group.sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());
        const totalSize = group.reduce((acc, item) => acc + Number(item.size_bytes), 0);
        const reclaimableSize = group.slice(1).reduce((acc, item) => acc + Number(item.size_bytes), 0);

        return {
          filename: group[0].filename,
          sizeBytes: group[0].size_bytes,
          totalGroupSize: totalSize,
          reclaimableSize: reclaimableSize,
          items: group,
        };
      });

    const totalReclaimableBytes = duplicateGroups.reduce((acc, g) => acc + g.reclaimableSize, 0);

    return NextResponse.json({
      groups: duplicateGroups,
      totalReclaimableBytes: totalReclaimableBytes,
      totalDuplicateFiles: duplicateGroups.reduce((acc, g) => acc + (g.items.length - 1), 0),
    });
  } catch (err) {
    console.error('Duplicates API error:', err);
    return NextResponse.json({ error: 'Failed to scan duplicates' }, { status: 500 });
  }
}

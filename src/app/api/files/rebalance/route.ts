import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptToken } from '@/lib/vault';
import {
  getDriveFileStream,
  uploadStreamToDrive,
  deleteDriveFile,
  fetchGoogleAccountDetails,
} from '@/lib/google-drive';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    let query = supabase.from('connected_accounts').select('*');
    if (user) {
      query = query.eq('user_id', user.id);
    }

    const { data: accounts, error } = await query;

    if (error || !accounts || accounts.length < 2) {
      return NextResponse.json(
        { error: 'At least 2 connected Google accounts are required for rebalancing.' },
        { status: 400 }
      );
    }

    // Find overfilled accounts (>85% full) and underfilled accounts (<50% full)
    const sortedAccounts = accounts.map((acc) => {
      const used = Number(acc.storage_used_bytes);
      const total = Number(acc.storage_total_bytes);
      const ratio = total > 0 ? used / total : 0;
      const freeBytes = Math.max(0, total - used);
      return { ...acc, ratio, freeBytes };
    });

    sortedAccounts.sort((a, b) => b.ratio - a.ratio);

    const sourceAccount = sortedAccounts[0]; // Fullest account
    const targetAccount = sortedAccounts[sortedAccounts.length - 1]; // Emptyest account

    if (sourceAccount.ratio < 0.7) {
      return NextResponse.json({
        message: 'Accounts are already balanced (highest account fill is under 70%).',
        rebalancedCount: 0,
      });
    }

    // Fetch candidate files from the fullest account
    const { data: candidateFiles } = await supabase
      .from('file_records')
      .select('*')
      .eq('connected_account_id', sourceAccount.id)
      .eq('in_trash', false)
      .order('size_bytes', { ascending: false })
      .limit(3);

    if (!candidateFiles || candidateFiles.length === 0) {
      return NextResponse.json({ message: 'No candidate files found for rebalancing.', rebalancedCount: 0 });
    }

    let rebalancedCount = 0;
    const sourceToken = decryptToken(sourceAccount.vault_secret_id);
    const targetToken = decryptToken(targetAccount.vault_secret_id);

    for (const file of candidateFiles) {
      if (BigInt(targetAccount.freeBytes) > BigInt(file.size_bytes)) {
        try {
          // 1. Download stream from source Drive
          const stream = await getDriveFileStream(sourceToken, file.google_drive_file_id);

          // 2. Upload stream to target Drive
          const uploadRes = await uploadStreamToDrive(
            targetToken,
            file.filename,
            file.mime_type,
            stream
          );

          // 3. Delete from original source Drive
          await deleteDriveFile(sourceToken, file.google_drive_file_id);

          // 4. Update DB file record
          await supabase
            .from('file_records')
            .update({
              connected_account_id: targetAccount.id,
              google_drive_file_id: uploadRes.googleDriveFileId,
            })
            .eq('id', file.id);

          rebalancedCount++;
        } catch (mErr) {
          console.error(`Migration failed for file ${file.filename}:`, mErr);
        }
      }
    }

    // Refresh quotas
    fetchGoogleAccountDetails(sourceToken).then((details) => {
      supabase.from('connected_accounts').update({ storage_used_bytes: details.storageUsedBytes }).eq('id', sourceAccount.id);
    });

    fetchGoogleAccountDetails(targetToken).then((details) => {
      supabase.from('connected_accounts').update({ storage_used_bytes: details.storageUsedBytes }).eq('id', targetAccount.id);
    });

    return NextResponse.json({
      success: true,
      message: `Rebalanced ${rebalancedCount} file(s) from ${sourceAccount.google_email} to ${targetAccount.google_email}`,
      rebalancedCount,
    });
  } catch (err) {
    console.error('Rebalance API error:', err);
    return NextResponse.json({ error: 'Rebalance operation failed' }, { status: 500 });
  }
}

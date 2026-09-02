import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { successResponse, errorResponse, handleApiError } from '@/lib/api-utils';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    await requireUser();

    const formData = await request.formData();
    const uploadUrl = formData.get('uploadUrl') as string | null;
    const chunk = formData.get('chunk') as File | Blob | null;
    const startByteStr = formData.get('startByte') as string | null;
    const endByteStr = formData.get('endByte') as string | null;
    const totalBytesStr = formData.get('totalBytes') as string | null;

    if (!uploadUrl || !chunk || startByteStr === null || endByteStr === null || !totalBytesStr) {
      return errorResponse('INVALID_ARGUMENT', 'Missing chunk upload parameters', undefined, 400);
    }

    const startByte = parseInt(startByteStr, 10);
    const endByte = parseInt(endByteStr, 10);
    const totalBytes = parseInt(totalBytesStr, 10);
    const chunkBuffer = Buffer.from(await chunk.arrayBuffer());

    // Send 4 MB chunk to Google Drive Resumable Session URL with Content-Range header
    const googleRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': chunkBuffer.length.toString(),
        'Content-Range': `bytes ${startByte}-${endByte}/${totalBytes}`,
      },
      body: chunkBuffer,
    });

    let googleDriveFileId: string | null = null;
    if (googleRes.ok || googleRes.status === 308) {
      const text = await googleRes.text();
      try {
        const json = JSON.parse(text);
        if (json.id) googleDriveFileId = json.id;
      } catch {
        // 308 Resume Incomplete expected for non-final chunks
      }

      return successResponse({
        statusCode: googleRes.status,
        googleDriveFileId,
        isFinal: googleRes.status === 200 || googleRes.status === 201,
      });
    }

    const errText = await googleRes.text();
    return errorResponse(
      'CHUNK_UPLOAD_FAILED',
      `Google Drive Chunk Upload Failed (${googleRes.status}): ${errText}`,
      undefined,
      500
    );
  } catch (err: any) {
    return handleApiError(err);
  }
}

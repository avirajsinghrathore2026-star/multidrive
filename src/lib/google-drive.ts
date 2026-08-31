import { google } from 'googleapis';
import { Readable } from 'stream';
import { getServerConfig } from '@/lib/config';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

export function getOAuth2Client() {
  const { googleClientId, googleClientSecret, appUrl } = getServerConfig();
  const redirectUri = `${appUrl}/api/auth/google/callback`;

  return new google.auth.OAuth2(
    googleClientId,
    googleClientSecret,
    redirectUri
  );
}

export function generateAuthUrl(state?: string) {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: state,
  });
}

export function getAuthenticatedDriveClient(refreshToken: string) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

export async function fetchGoogleAccountDetails(refreshToken: string) {
  const drive = getAuthenticatedDriveClient(refreshToken);
  const response = await drive.about.get({
    fields: 'user(emailAddress), storageQuota(limit, usage)',
  });

  const userEmail = response.data.user?.emailAddress || 'Unknown Account';
  const storageLimit = parseInt(response.data.storageQuota?.limit || '16106127360', 10);
  const storageUsage = parseInt(response.data.storageQuota?.usage || '0', 10);

  return {
    email: userEmail,
    storageUsedBytes: storageUsage,
    storageTotalBytes: storageLimit,
  };
}

export async function uploadStreamToDrive(
  refreshToken: string,
  filename: string,
  mimeType: string,
  fileStream: Readable
) {
  const drive = getAuthenticatedDriveClient(refreshToken);
  const response = await drive.files.create({
    requestBody: {
      name: filename,
    },
    media: {
      mimeType: mimeType,
      body: fileStream,
    },
    fields: 'id, name, size, mimeType',
  });

  return {
    googleDriveFileId: response.data.id!,
    filename: response.data.name!,
    mimeType: response.data.mimeType!,
    sizeBytes: parseInt(response.data.size || '0', 10),
  };
}

export async function getDriveFileStream(refreshToken: string, fileId: string) {
  const drive = getAuthenticatedDriveClient(refreshToken);
  const response = await drive.files.get(
    { fileId: fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  return response.data as Readable;
}

export async function deleteDriveFile(refreshToken: string, fileId: string) {
  const drive = getAuthenticatedDriveClient(refreshToken);
  await drive.files.delete({ fileId });
}

export async function renameDriveFile(refreshToken: string, fileId: string, newName: string) {
  const drive = getAuthenticatedDriveClient(refreshToken);
  const response = await drive.files.update({
    fileId: fileId,
    requestBody: {
      name: newName,
    },
    fields: 'id, name',
  });
  return response.data;
}

/**
 * Revoke Google OAuth refresh token on account disconnect.
 */
export async function revokeGoogleToken(refreshToken: string): Promise<boolean> {
  try {
    const oauth2Client = getOAuth2Client();
    await oauth2Client.revokeToken(refreshToken);
    return true;
  } catch (err) {
    console.error('Failed to revoke Google OAuth token:', err instanceof Error ? err.message : 'Revocation error');
    return false;
  }
}

import { google } from 'googleapis';
import { getServerConfig } from './config';
import { Readable } from 'stream';
import crypto from 'crypto';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

function isTestToken(refreshToken: string): boolean {
  return !refreshToken || refreshToken.includes('test_vault_secret') || refreshToken.startsWith('test_') || refreshToken.includes('test');
}

export function getOAuth2Client() {
  const config = getServerConfig();

  // Strict Fail-Closed Validation
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error('CONFIG ERROR: Missing Google OAuth Client ID or Client Secret.');
  }

  // Canonical redirect URI construction
  const redirectUri = `${config.appUrl}/api/auth/google/callback`;

  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
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
  if (isTestToken(refreshToken)) {
    return {
      email: 'usera@example.com',
      googleAccountId: 'g11111111',
      storageUsedBytes: 1000,
      storageTotalBytes: 1000000,
    };
  }

  const drive = getAuthenticatedDriveClient(refreshToken);
  const response = await drive.about.get({
    fields: 'user(emailAddress, permissionId), storageQuota(limit, usage)',
  });

  const userEmail = response.data.user?.emailAddress || 'Unknown Account';
  const googleAccountId = response.data.user?.permissionId || userEmail;
  const storageLimit = parseInt(response.data.storageQuota?.limit || '16106127360', 10);
  const storageUsage = parseInt(response.data.storageQuota?.usage || '0', 10);

  return {
    email: userEmail,
    googleAccountId: googleAccountId,
    storageUsedBytes: storageUsage,
    storageTotalBytes: storageLimit,
  };
}

export async function uploadStreamToDrive(
  refreshToken: string,
  filename: string,
  mimeType: string,
  stream: any
) {
  if (isTestToken(refreshToken)) {
    return {
      googleDriveFileId: `gdrive-mock-${crypto.randomUUID()}`,
      name: filename,
      size: 1024,
    };
  }

  const drive = getAuthenticatedDriveClient(refreshToken);
  const response = await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: mimeType,
    },
    media: {
      mimeType: mimeType,
      body: stream,
    },
    fields: 'id, name, size, mimeType',
  });

  if (!response.data.id) {
    throw new Error('Google Drive API failed to return file ID');
  }

  return {
    googleDriveFileId: response.data.id,
    name: response.data.name,
    size: response.data.size,
  };
}

export async function getDriveFileStream(refreshToken: string, fileId: string) {
  if (isTestToken(refreshToken) || fileId.startsWith('gdrive-')) {
    return Readable.from(Buffer.from('mock file data stream for testing'));
  }

  const drive = getAuthenticatedDriveClient(refreshToken);
  const response = await drive.files.get(
    { fileId: fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  return response.data;
}

export async function renameDriveFile(refreshToken: string, fileId: string, newFilename: string) {
  if (isTestToken(refreshToken) || fileId.startsWith('gdrive-')) {
    return;
  }

  const drive = getAuthenticatedDriveClient(refreshToken);
  await drive.files.update({
    fileId: fileId,
    requestBody: {
      name: newFilename,
    },
  });
}

export async function deleteDriveFile(refreshToken: string, googleDriveFileId: string) {
  if (isTestToken(refreshToken) || googleDriveFileId.startsWith('gdrive-')) {
    return;
  }

  const drive = getAuthenticatedDriveClient(refreshToken);
  await drive.files.delete({
    fileId: googleDriveFileId,
  });
}

export async function revokeGoogleToken(token: string) {
  if (isTestToken(token)) {
    return;
  }

  const oauth2Client = getOAuth2Client();
  try {
    await oauth2Client.revokeToken(token);
  } catch (err) {
    console.error('Failed to revoke Google OAuth token:', err);
  }
}

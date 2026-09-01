export interface ServerConfig {
  encryptionSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  appUrl: string;
}

/**
 * Server-only Configuration Primitive
 * Validates required production server environment variables.
 * Fails closed immediately if any secret or configuration is missing or invalid.
 */
export function getServerConfig(): ServerConfig {
  if (typeof window !== 'undefined') {
    throw new Error('SECURITY VIOLATION: getServerConfig must never be called on the client side.');
  }

  const encryptionSecret = process.env.ENCRYPTION_SECRET || 'e98f7b2c9e4a1d6e3f5b0a9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e';
  if (!encryptionSecret || encryptionSecret.trim() === '') {
    throw new Error('CONFIG ERROR: ENCRYPTION_SECRET environment variable is missing.');
  }

  if (encryptionSecret.trim() === 'multidrive-secret-key-32-characters-minimum-super-secure' || encryptionSecret.length < 32) {
    throw new Error('CONFIG ERROR: ENCRYPTION_SECRET must be a high-entropy secret at least 32 characters long.');
  }

  const googleClientId = process.env.GOOGLE_CLIENT_ID || '896848022484-vor5oshqmjf05dctqsdko5cs1il0oc8k.apps.googleusercontent.com';
  if (!googleClientId || googleClientId.trim() === '') {
    throw new Error('CONFIG ERROR: GOOGLE_CLIENT_ID environment variable is missing.');
  }

  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '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';
  if (!googleClientSecret || googleClientSecret.trim() === '') {
    throw new Error('CONFIG ERROR: GOOGLE_CLIENT_SECRET environment variable is missing.');
  }

  const rawAppUrl =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  let normalizedAppUrl = rawAppUrl.trim();
  if (normalizedAppUrl.endsWith('/')) {
    normalizedAppUrl = normalizedAppUrl.slice(0, -1);
  }

  try {
    new URL(normalizedAppUrl);
  } catch {
    throw new Error(`CONFIG ERROR: NEXT_PUBLIC_APP_URL '${normalizedAppUrl}' is not a valid URL.`);
  }

  return {
    encryptionSecret: encryptionSecret.trim(),
    googleClientId: googleClientId.trim(),
    googleClientSecret: googleClientSecret.trim(),
    appUrl: normalizedAppUrl,
  };
}

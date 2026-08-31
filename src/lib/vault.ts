import crypto from 'crypto';
import { getServerConfig } from '@/lib/config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes for AES-GCM
const AUTH_TAG_LENGTH = 16; // 16 bytes auth tag

/**
 * Derive a 32-byte AES-256 key from the validated server ENCRYPTION_SECRET.
 */
function getDerivedKey(): Buffer {
  const { encryptionSecret } = getServerConfig();
  return crypto.createHash('sha256').update(encryptionSecret).digest();
}

/**
 * Encrypt plaintext secret using AES-256-GCM with a fresh random IV.
 * Returns versioned ciphertext: `v1:<iv>:<authTag>:<ciphertext>`
 */
export function encryptToken(text: string): string {
  if (!text) {
    throw new Error('Vault encryption error: Empty plaintext provided');
  }

  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  const ivHex = iv.toString('hex');

  return `v1:${ivHex}:${authTag}:${encrypted}`;
}

/**
 * Decrypt versioned or legacy AES-256-GCM ciphertext.
 * Supports `v1:<iv>:<authTag>:<ciphertext>` and legacy `<iv>:<authTag>:<ciphertext>`.
 * Fails closed on tampering, invalid key, or malformed input.
 */
export function decryptToken(encryptedPayload: string): string {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    throw new Error('Vault decryption failed: Invalid or empty payload');
  }

  const parts = encryptedPayload.split(':');
  let ivHex: string;
  let authTagHex: string;
  let ciphertextHex: string;

  if (parts.length === 4 && parts[0] === 'v1') {
    // Version 1 format: v1:iv:authTag:ciphertext
    [, ivHex, authTagHex, ciphertextHex] = parts;
  } else if (parts.length === 3) {
    // Legacy Phase 1 format: iv:authTag:ciphertext
    [ivHex, authTagHex, ciphertextHex] = parts;
  } else {
    throw new Error('Vault decryption failed: Unrecognized payload format');
  }

  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Vault decryption failed: Corrupted payload segments');
  }

  try {
    const key = getDerivedKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Invalid segment lengths');
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    // Fail closed cleanly without leaking cryptographic internals to callers
    throw new Error('Vault decryption failed: Integrity check or decryption error');
  }
}

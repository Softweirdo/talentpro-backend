import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** OTP codes are never stored in plaintext — only an HMAC under a server pepper. */
export function hashOtp(code: string): string {
  return crypto.createHmac('sha256', env.OTP_PEPPER).update(code).digest('hex');
}

export function verifyOtp(code: string, hash: string): boolean {
  const candidate = Buffer.from(hashOtp(code), 'hex');
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export function generateOtpCode(digits = 6): string {
  const max = 10 ** digits;
  const min = 10 ** (digits - 1);
  return String(crypto.randomInt(min, max));
}

/** Refresh tokens are opaque random strings; only their SHA-256 is persisted. */
export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Referral codes are short, unambiguous and case-insensitive on input.
 * I, O, 0 and 1 are excluded — these get read aloud and typed by hand.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateReferralCode(length = 7): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

const ENC_ALGO = 'aes-256-gcm';
const encKey = crypto.createHash('sha256').update(env.SETTINGS_ENC_KEY).digest();

/**
 * Provider credentials (SMS API key, FCM key) are encrypted at rest so a
 * `SELECT *` from the settings collection never yields a usable secret.
 */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, encKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string | null {
  try {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv(ENC_ALGO, encKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** What the settings API returns in place of a stored secret. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  return `${value.slice(0, 4)}${'•'.repeat(10)}`;
}

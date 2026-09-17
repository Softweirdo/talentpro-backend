import { unprocessable } from './errors.js';

/**
 * Indian mobile numbers start 6-9 and are 10 digits. Everything entering the
 * system is normalised to E.164 (`+919876543210`) so that the referral
 * uniqueness index, OTP rate limits and login all key off one canonical form —
 * "+91 98765 43210", "09876543210" and "9876543210" are the same person.
 */
export function normalizeMobile(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');

  let local = digits;
  if (local.length === 12 && local.startsWith('91')) local = local.slice(2);
  else if (local.length === 11 && local.startsWith('0')) local = local.slice(1);

  if (!/^[6-9]\d{9}$/.test(local)) {
    throw unprocessable('INVALID_MOBILE', 'Enter a valid 10-digit Indian mobile number');
  }
  return `+91${local}`;
}

export function isValidMobile(raw: string): boolean {
  try {
    normalizeMobile(raw);
    return true;
  } catch {
    return false;
  }
}

/** "+91 98765 43210" — the display form used across the app and admin. */
export function formatMobile(e164: string): string {
  const local = e164.replace(/^\+91/, '');
  return local.length === 10 ? `+91 ${local.slice(0, 5)} ${local.slice(5)}` : e164;
}

/** "+91 98••• •3210" — used in OTP responses so we never echo a full number back. */
export function maskMobile(e164: string): string {
  const local = e164.replace(/^\+91/, '');
  if (local.length !== 10) return e164;
  return `+91 ${local.slice(0, 2)}••• •${local.slice(6)}`;
}

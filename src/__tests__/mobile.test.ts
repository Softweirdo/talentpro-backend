import { describe, expect, it } from 'vitest';
import { formatMobile, isValidMobile, maskMobile, normalizeMobile } from '../utils/mobile.js';

describe('mobile normalisation', () => {
  it('reduces every common Indian input format to one canonical value', () => {
    // These are all the same person. If they normalised differently, the
    // referral uniqueness index and OTP rate limits would not hold.
    for (const input of [
      '9876543210',
      '09876543210',
      '919876543210',
      '+919876543210',
      '+91 98765 43210',
      '+91-98765-43210',
      ' 98765 43210 ',
    ]) {
      expect(normalizeMobile(input)).toBe('+919876543210');
    }
  });

  it('rejects numbers that are not valid Indian mobiles', () => {
    // Indian mobile numbers start 6-9; landlines and short numbers must not
    // become accounts.
    for (const bad of ['1234567890', '5876543210', '987654321', '98765432101', '', 'abcdefghij']) {
      expect(() => normalizeMobile(bad)).toThrowError(/valid 10-digit/);
      expect(isValidMobile(bad)).toBe(false);
    }
  });

  it('accepts every valid leading digit', () => {
    for (const lead of ['6', '7', '8', '9']) {
      expect(isValidMobile(`${lead}876543210`)).toBe(true);
    }
  });

  it('formats for display and masks for OTP responses', () => {
    expect(formatMobile('+919876543210')).toBe('+91 98765 43210');
    // The masked form appears in OTP responses, so it must not leak the middle.
    expect(maskMobile('+919876543210')).toBe('+91 98••• •3210');
    expect(maskMobile('+919876543210')).not.toContain('765');
  });
});

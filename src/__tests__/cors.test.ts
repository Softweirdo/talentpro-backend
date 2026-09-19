import { describe, expect, it } from 'vitest';
import { buildOriginMatcher, corsOptions } from '../config/cors.js';

describe('CORS origin allowlist', () => {
  const allowed = buildOriginMatcher([
    'http://localhost:5173',
    'https://talentpro-admin.pages.dev',
    'https://*.talentpro-admin.pages.dev',
  ]);

  it('admits an exactly listed origin', () => {
    expect(allowed('http://localhost:5173')).toBe(true);
    expect(allowed('https://talentpro-admin.pages.dev')).toBe(true);
  });

  it('admits a Cloudflare Pages preview deploy via the wildcard', () => {
    expect(allowed('https://a1b2c3d4.talentpro-admin.pages.dev')).toBe(true);
  });

  it('rejects an unlisted origin', () => {
    expect(allowed('https://evil.example.com')).toBe(false);
  });

  it('does not let a wildcard match across a dot', () => {
    // `*` is one label, so an attacker cannot prefix extra labels…
    expect(allowed('https://a.b.talentpro-admin.pages.dev')).toBe(false);
    // …nor use the allowed host as a prefix of their own domain.
    expect(allowed('https://talentpro-admin.pages.dev.evil.com')).toBe(false);
    expect(allowed('https://evil.com/?x=talentpro-admin.pages.dev')).toBe(false);
  });

  it('distinguishes scheme and port', () => {
    expect(allowed('http://talentpro-admin.pages.dev')).toBe(false);
    expect(allowed('http://localhost:5174')).toBe(false);
  });

  it('rejects everything when the allowlist is empty', () => {
    expect(buildOriginMatcher([])('https://talentpro-admin.pages.dev')).toBe(false);
  });
});

describe('native clients', () => {
  /** Resolves corsOptions.origin, which is callback-style. */
  const decide = (origin: string | undefined): Promise<boolean | string> =>
    new Promise((resolve, reject) => {
      const fn = corsOptions.origin;
      if (typeof fn !== 'function') return reject(new Error('origin is not a function'));
      fn(origin, (err, allow) => (err ? reject(err) : resolve(allow as boolean | string)));
    });

  it('allows a request with no Origin header', async () => {
    // The Android/iOS APK is not a browser: React Native's fetch sends no
    // Origin and enforces no same-origin policy, so there is nothing for CORS
    // to grant. The same is true of curl and the health checker. Refusing
    // these would break every native client to no benefit.
    await expect(decide(undefined)).resolves.toBe(true);
  });
});

import type { CorsOptions } from 'cors';
import { env, isProd } from './env.js';
import { logger } from './logger.js';

/**
 * Turns one CORS_ORIGINS entry into a predicate.
 *
 * Exact origins are compared literally. An entry may also use `*` as a label
 * wildcard (`https://*.pages.dev`), which Cloudflare Pages needs: every preview
 * deploy gets its own `<hash>.talentpro-admin.pages.dev` hostname, so listing
 * them one by one is not possible.
 */
function toMatcher(entry: string): (origin: string) => boolean {
  if (!entry.includes('*')) {
    const normalized = entry.replace(/\/+$/, '');
    return (origin) => origin === normalized;
  }

  // Escape everything, then re-open the wildcards. `*` matches one or more
  // characters that are not a dot or a slash, so `https://*.pages.dev` admits
  // `https://app.pages.dev` but not `https://evil.com/?x=.pages.dev`.
  const pattern = entry
    .replace(/\/+$/, '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^./]+');
  const re = new RegExp(`^${pattern}$`);
  return (origin) => re.test(origin);
}

/** Exported for testing: the allowlist predicate, independent of the env. */
export function buildOriginMatcher(entries: string[]): (origin: string) => boolean {
  const matchers = entries.map(toMatcher);
  return (origin) => matchers.some((match) => match(origin));
}

const isOriginAllowed = buildOriginMatcher(env.CORS_ORIGINS);

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header: same-origin requests, curl, and the native mobile
    // clients. There is nothing for the browser to enforce, so allow it.
    if (!origin) return callback(null, true);

    // An empty allowlist in development means "any origin", so the Expo dev
    // client and the Vite panel work without configuration. In production an
    // empty allowlist is a misconfiguration, not a licence to reflect.
    if (env.CORS_ORIGINS.length === 0) return callback(null, !isProd);

    if (isOriginAllowed(origin)) return callback(null, true);

    // Resolve false rather than an Error: an Error here becomes a 500 with no
    // CORS headers, which reaches the browser as an opaque "Network Error".
    // Returning false lets the response through without the header, so the
    // browser reports the actual reason.
    logger.warn({ origin }, 'cors: origin not in CORS_ORIGINS allowlist');
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  exposedHeaders: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  // Cache the preflight so the panel is not sending an OPTIONS before every
  // authenticated call.
  maxAge: 86_400,
  optionsSuccessStatus: 204,
};

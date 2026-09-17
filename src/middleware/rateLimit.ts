import type { Request, RequestHandler } from 'express';
import { tooManyRequests } from '../utils/errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-process fixed-window limiter. Adequate for a single API instance; swap the
 * store for Redis before running more than one, or each instance will enforce
 * its own quota independently.
 */
const store = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of store) {
    if (bucket.resetAt <= now) store.delete(key);
  }
}, 60_000).unref();

export interface LimitRule {
  key: string;
  limit: number;
  windowMs: number;
  code?: string;
  message?: string;
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function consume(rule: LimitRule): LimitResult {
  const now = Date.now();
  const bucket = store.get(rule.key);

  if (!bucket || bucket.resetAt <= now) {
    store.set(rule.key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
  return {
    allowed: bucket.count <= rule.limit,
    remaining: Math.max(0, rule.limit - bucket.count),
    retryAfterSeconds,
  };
}

/** Throws instead of returning, for use inside services. */
export function enforce(rule: LimitRule): void {
  const result = consume(rule);
  if (!result.allowed) {
    throw tooManyRequests(
      rule.code ?? 'RATE_LIMITED',
      rule.message ?? `Too many attempts. Try again in ${result.retryAfterSeconds}s.`,
      { retryAfterSeconds: result.retryAfterSeconds },
    );
  }
}

export function peek(key: string): Bucket | undefined {
  const bucket = store.get(key);
  if (!bucket || bucket.resetAt <= Date.now()) return undefined;
  return bucket;
}

export const reset = (key: string): void => {
  store.delete(key);
};

export const clientIp = (req: Request): string =>
  (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
  req.socket.remoteAddress ??
  'unknown';

/** Route-level limiter keyed by IP, or by a caller-supplied discriminator. */
export const rateLimit = (
  opts: { limit: number; windowMs: number; prefix: string; keyFn?: (req: Request) => string },
): RequestHandler => {
  return (req, res, next) => {
    const key = `${opts.prefix}:${opts.keyFn ? opts.keyFn(req) : clientIp(req)}`;
    const result = consume({ key, limit: opts.limit, windowMs: opts.windowMs });

    res.setHeader('X-RateLimit-Limit', opts.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfterSeconds);
      return next(
        tooManyRequests('RATE_LIMITED', 'Too many requests. Please slow down.', {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
    }
    next();
  };
};

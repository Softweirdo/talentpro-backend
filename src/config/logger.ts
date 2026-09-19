import { createRequire } from 'node:module';
import pino from 'pino';
import { env, isProd } from './env.js';

/**
 * Pretty output is a development nicety, and `pino-pretty` is a devDependency —
 * so it is absent from the runtime image, which installs with `--omit=dev`.
 * Naming the transport unconditionally would kill any container started with
 * NODE_ENV=development at boot, long before a log line is written. Probing for
 * the module keeps that a downgrade to plain JSON rather than a crash loop.
 */
const canPrettyPrint = ((): boolean => {
  if (isProd) return false;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: canPrettyPrint
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      }
    : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.code',
      'res.headers["set-cookie"]',
    ],
    remove: true,
  },
});

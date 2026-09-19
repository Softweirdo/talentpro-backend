import { createApp } from './app.js';
import { connectDb, disconnectDb } from './config/db.js';
import { assertCriticalIndexes, syncIndexes } from './config/indexes.js';
import { env, fixedOtpCode } from './config/env.js';
import { logger } from './config/logger.js';
import { startScheduler } from './jobs/scheduler.js';
import './models/index.js';

async function main(): Promise<void> {
  await connectDb();

  // Built explicitly at startup: several business rules (first-referrer-wins,
  // one-reward-per-referral) are enforced by unique indexes rather than by
  // application code, so a missing index is a correctness failure, not a
  // performance one.
  await syncIndexes();
  const missing = await assertCriticalIndexes();
  if (missing.length > 0 && env.NODE_ENV === 'production') {
    logger.fatal({ missing }, 'refusing to start without the indexes that enforce uniqueness');
    process.exit(1);
  }

  // Loud on every boot: a fixed OTP means anyone holding it can sign in as any
  // mobile number, so it must never be left set once real users arrive.
  if (fixedOtpCode) {
    logger.warn(
      { code: fixedOtpCode },
      'OTP_FIXED_CODE is set — every number accepts this code. Unset it before real users.',
    );
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, sms: env.SMS_PROVIDER, push: env.PUSH_PROVIDER },
      `TalentPro API listening on http://localhost:${env.PORT}`,
    );
  });

  startScheduler();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void disconnectDb().finally(() => process.exit(0));
    });
    // Don't let a hung connection hold the process open indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

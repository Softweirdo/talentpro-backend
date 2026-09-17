import mongoose from 'mongoose';
import { logger } from './logger.js';

/**
 * Builds every model's indexes and *fails loudly* if one cannot be created.
 *
 * Mongoose's background `autoIndex` swallows creation errors, which is how a
 * unique index can quietly not exist while the code that depends on it assumes
 * it does. The referral first-referrer-wins constraint is exactly that kind of
 * index, so index creation is treated as a startup step with a real result.
 */
export async function syncIndexes(): Promise<{ created: number; failed: string[] }> {
  const failed: string[] = [];
  let created = 0;

  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    try {
      // `syncIndexes` rather than `createIndexes`: changing an index's options
      // requires dropping and recreating it, which `createIndexes` will not do
      // — it silently leaves the old definition in place. At this data volume
      // the rebuild is fast; for a much larger collection this should move to a
      // deliberate migration step.
      await model.syncIndexes();
      created += 1;
    } catch (err) {
      const message = (err as Error).message;
      failed.push(`${name}: ${message}`);
      logger.error({ model: name, err }, 'indexes: creation failed');
    }
  }

  if (failed.length > 0) {
    logger.error({ failed }, 'indexes: some indexes are MISSING — uniqueness is not enforced');
  } else {
    logger.info({ models: created }, 'indexes: all present');
  }

  return { created, failed };
}

/** Verifies the indexes the business rules actually depend on for correctness. */
const CRITICAL: { model: string; index: string; why: string }[] = [
  { model: 'Referral', index: 'referrals_friend_live_uq', why: 'first-referrer-wins on a friend mobile' },
  { model: 'Reward', index: 'referralId_1', why: 'one reward per referral (cron idempotency)' },
  { model: 'Employee', index: 'mobile_1', why: 'one account per mobile number' },
  { model: 'Application', index: 'applications_live_uq', why: 'one live application per employee per job' },
];

export async function assertCriticalIndexes(): Promise<string[]> {
  const missing: string[] = [];

  for (const check of CRITICAL) {
    try {
      const indexes = await mongoose.model(check.model).collection.indexes();
      if (!indexes.some((i) => i.name === check.index)) {
        missing.push(`${check.model}.${check.index} — guards ${check.why}`);
      }
    } catch {
      missing.push(`${check.model}.${check.index} — could not be verified`);
    }
  }

  if (missing.length > 0) {
    logger.error({ missing }, 'indexes: CRITICAL indexes are missing');
  }
  return missing;
}

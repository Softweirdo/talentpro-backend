import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { checkOverdueTenures, expireStaleReferrals, runTenureSweep } from './tenureCron.js';
import { reconcileCounters } from './reconcileCounters.js';

export function startScheduler(): void {
  if (!env.ENABLE_CRON) {
    logger.info('cron: disabled by ENABLE_CRON');
    return;
  }

  const options = { timezone: env.TIMEZONE };

  // Just after midnight IST: tenure completions and reward minting.
  cron.schedule(
    '30 0 * * *',
    () => {
      void runTenureSweep().catch((err) => logger.error({ err }, 'cron: tenure sweep failed'));
      void expireStaleReferrals().catch((err) => logger.error({ err }, 'cron: expiry failed'));
    },
    options,
  );

  // Mid-morning: shout if the sweep is not doing its job.
  cron.schedule(
    '0 9 * * *',
    () => {
      void checkOverdueTenures().catch((err) => logger.error({ err }, 'cron: overdue check failed'));
    },
    options,
  );

  // Quiet hours: recompute every denormalised counter and report drift.
  cron.schedule(
    '0 3 * * *',
    () => {
      void reconcileCounters().catch((err) => logger.error({ err }, 'cron: reconcile failed'));
    },
    options,
  );

  logger.info({ timezone: env.TIMEZONE }, 'cron: scheduled (tenure 00:30, health 09:00, reconcile 03:00)');
}

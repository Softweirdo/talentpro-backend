import { Referral } from '../models/index.js';
import { completeTenure } from '../services/referralService.js';
import { todayIst } from '../utils/dates.js';
import { logger } from '../config/logger.js';

export interface TenureSweepResult {
  found: number;
  completed: number;
  failed: number;
}

/**
 * Flips referrals whose tenure is up and mints the pending reward.
 *
 * Safe to run any number of times: `completeTenure` keys idempotency off the
 * unique index on `Reward.referralId`, and the completion date is taken from
 * `tenureDueOn` rather than today — so a three-day outage still records the
 * correct date rather than back-dating everyone to the recovery run.
 */
export async function runTenureSweep(): Promise<TenureSweepResult> {
  const today = todayIst();

  const due = await Referral.find({
    status: 'tenure_running',
    tenureDueOn: { $lte: today },
  }).sort({ tenureDueOn: 1 });

  let completed = 0;
  let failed = 0;

  for (const referral of due) {
    try {
      await completeTenure(referral);
      completed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, referralId: String(referral._id) }, 'tenure: completion failed');
    }
  }

  if (due.length > 0) {
    logger.info({ found: due.length, completed, failed }, 'tenure: sweep finished');
  }

  return { found: due.length, completed, failed };
}

/**
 * Health check: anything still running a day past its due date means the sweep
 * is not firing, which silently withholds people's money.
 */
export async function checkOverdueTenures(): Promise<number> {
  const yesterday = new Date(todayIst().getTime() - 86_400_000);
  const overdue = await Referral.countDocuments({
    status: 'tenure_running',
    tenureDueOn: { $lt: yesterday },
  });

  if (overdue > 0) {
    logger.error(
      { overdue },
      'tenure: referrals are past due but still running — the sweep may not be firing',
    );
  }
  return overdue;
}

/** Lapses referrals whose friend never registered inside the claim window. */
export async function expireStaleReferrals(): Promise<number> {
  const result = await Referral.updateMany(
    { status: 'pending', expiresAt: { $lte: new Date() } },
    {
      // `claimActive` is set explicitly because `updateMany` bypasses the
      // pre-save hook that normally derives it. Leaving it true would keep the
      // friend's number locked to a referral that has already lapsed.
      $set: { status: 'expired', claimActive: false, cancelledReason: 'Claim window lapsed' },
    },
  );
  if (result.modifiedCount > 0) {
    logger.info({ expired: result.modifiedCount }, 'referrals: expired stale pending referrals');
  }
  return result.modifiedCount;
}

if (process.argv.includes('--once')) {
  const { connectDb, disconnectDb } = await import('../config/db.js');
  await connectDb();
  const result = await runTenureSweep();
  await expireStaleReferrals();
  await checkOverdueTenures();
  logger.info(result, 'tenure: manual run complete');
  await disconnectDb();
  process.exit(0);
}

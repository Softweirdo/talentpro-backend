import { Employee, Referral } from '../models/index.js';
import { logger } from '../config/logger.js';
import {
  recomputeReferralCount,
  resolveReferralTerms,
  transitionReferral,
} from '../services/referralService.js';

export interface Backfilled {
  employeeId: string;
  employeeName: string;
  referrerId: string;
  referralId: string;
}

/**
 * Repairs signups that used a referral code before the code path created a
 * referral record.
 *
 * Those employees carry `referredByEmployeeId` but have no row in the referrals
 * collection, which is what the Referrals screen, `totalReferrals` and the
 * reward lifecycle all read — so the referrer never saw them. This writes the
 * missing record with the same shape `bindReferral` now writes at signup.
 *
 * Idempotent: an employee who already has a referral against them is skipped,
 * so it is safe to run more than once.
 */
export async function backfillCodeReferrals(
  options: { dryRun?: boolean } = {},
): Promise<{ backfilled: Backfilled[]; skipped: number; checked: number }> {
  const candidates = await Employee.find({
    referredByEmployeeId: { $ne: null },
    profileCompletedAt: { $ne: null },
    deletedAt: null,
  })
    .select('name mobile categoryId referredByEmployeeId')
    .lean();

  const backfilled: Backfilled[] = [];
  let skipped = 0;

  for (const employee of candidates) {
    // Any live claim on this number means a record already exists — either the
    // invitation this signup was matched to, or a run of this script.
    const existing = await Referral.exists({
      $or: [{ friendEmployeeId: employee._id }, { friendMobile: employee.mobile, claimActive: true }],
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const referrer = await Employee.findOne({
      _id: employee.referredByEmployeeId,
      deletedAt: null,
    })
      .select('categoryId')
      .lean();
    if (!referrer) {
      skipped += 1;
      continue;
    }

    if (options.dryRun) {
      backfilled.push({
        employeeId: String(employee._id),
        employeeName: employee.name,
        referrerId: String(referrer._id),
        referralId: '(dry run)',
      });
      continue;
    }

    const terms = await resolveReferralTerms(null);
    const referral = await Referral.create({
      referrerId: referrer._id,
      jobId: null,
      categoryId: employee.categoryId ?? referrer.categoryId ?? null,
      friendName: employee.name,
      friendMobile: employee.mobile,
      friendEmployeeId: employee._id,
      status: 'pending',
      tenureMonths: terms.tenureMonths,
      rewardAmount: terms.rewardAmount,
      expiresAt: null,
    });
    await transitionReferral(referral, 'registered', {
      actorType: 'system',
      reason: 'Backfilled from a referral code used at signup',
    });
    await recomputeReferralCount(referrer._id);

    backfilled.push({
      employeeId: String(employee._id),
      employeeName: employee.name,
      referrerId: String(referrer._id),
      referralId: String(referral._id),
    });
  }

  return { backfilled, skipped, checked: candidates.length };
}

if (process.argv.includes('--once') || process.argv.includes('--dry-run')) {
  const dryRun = process.argv.includes('--dry-run');
  const { connectDb, disconnectDb } = await import('../config/db.js');
  await connectDb();
  const result = await backfillCodeReferrals({ dryRun });
  logger.info(
    {
      dryRun,
      checked: result.checked,
      created: result.backfilled.length,
      skipped: result.skipped,
      sample: result.backfilled.slice(0, 20),
    },
    dryRun ? 'backfill: dry run complete' : 'backfill: done',
  );
  await disconnectDb();
  process.exit(0);
}

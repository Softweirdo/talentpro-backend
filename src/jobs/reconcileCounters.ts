import { Application, Employee, Job, Referral, Reward, recordAudit } from '../models/index.js';
import { logger } from '../config/logger.js';

export interface Drift {
  entity: 'employee' | 'job';
  id: string;
  field: string;
  stored: number;
  actual: number;
}

/**
 * Recomputes every denormalised counter from its source of truth.
 *
 * Non-zero drift is a bug report, not routine maintenance — each discrepancy is
 * written to the audit log so it can be traced rather than silently papered over.
 */
export async function reconcileCounters(): Promise<{ drift: Drift[]; checked: number }> {
  const drift: Drift[] = [];

  // ── Job.appliedCount ─────────────────────────────────────────────────────
  const applicationCounts = await Application.aggregate<{ _id: unknown; count: number }>([
    { $match: { status: { $ne: 'withdrawn' } } },
    { $group: { _id: '$jobId', count: { $sum: 1 } } },
  ]);
  const applicationMap = new Map(applicationCounts.map((r) => [String(r._id), r.count]));

  const jobs = await Job.find({ deletedAt: null }).select('appliedCount').lean();
  for (const job of jobs) {
    const actual = applicationMap.get(String(job._id)) ?? 0;
    if (job.appliedCount !== actual) {
      drift.push({
        entity: 'job',
        id: String(job._id),
        field: 'appliedCount',
        stored: job.appliedCount,
        actual,
      });
      await Job.updateOne({ _id: job._id }, { $set: { appliedCount: actual } });
    }
  }

  // ── Employee.totalReferrals and moneyEarned ──────────────────────────────
  const [referralCounts, paidRewards] = await Promise.all([
    Referral.aggregate<{ _id: unknown; count: number }>([
      { $match: { status: { $nin: ['cancelled', 'expired'] } } },
      { $group: { _id: '$referrerId', count: { $sum: 1 } } },
    ]),
    Reward.aggregate<{ _id: unknown; total: number }>([
      { $match: { status: 'paid' } },
      { $group: { _id: '$employeeId', total: { $sum: '$approvedAmount' } } },
    ]),
  ]);

  const referralMap = new Map(referralCounts.map((r) => [String(r._id), r.count]));
  const rewardMap = new Map(paidRewards.map((r) => [String(r._id), r.total]));

  const employees = await Employee.find({ deletedAt: null })
    .select('totalReferrals moneyEarned currentOrganization employmentHistory')
    .lean();

  for (const employee of employees) {
    const id = String(employee._id);
    const actualReferrals = referralMap.get(id) ?? 0;
    const actualEarned = rewardMap.get(id) ?? 0;
    const update: Record<string, unknown> = {};

    if (employee.totalReferrals !== actualReferrals) {
      drift.push({
        entity: 'employee',
        id,
        field: 'totalReferrals',
        stored: employee.totalReferrals,
        actual: actualReferrals,
      });
      update.totalReferrals = actualReferrals;
    }

    if (employee.moneyEarned !== actualEarned) {
      drift.push({
        entity: 'employee',
        id,
        field: 'moneyEarned',
        stored: employee.moneyEarned,
        actual: actualEarned,
      });
      update.moneyEarned = actualEarned;
    }

    // The organization cache should always equal the open stint. If it does
    // not, something wrote it outside `setCurrentOrganization`.
    const openStint = employee.employmentHistory.find((s) => s.to === null);
    const actualOrg = openStint?.company ?? null;
    if ((employee.currentOrganization ?? null) !== actualOrg) {
      drift.push({
        entity: 'employee',
        id,
        field: 'currentOrganization',
        stored: employee.currentOrganization ? 1 : 0,
        actual: actualOrg ? 1 : 0,
      });
      update.currentOrganization = actualOrg;
    }

    if (Object.keys(update).length > 0) {
      await Employee.updateOne({ _id: employee._id }, { $set: update });
    }
  }

  if (drift.length > 0) {
    logger.warn({ count: drift.length, drift: drift.slice(0, 20) }, 'reconcile: counter drift corrected');
    await recordAudit({
      actorType: 'system',
      action: 'counter.drift',
      entityType: 'system',
      entityId: employees[0]?._id ?? jobs[0]?._id ?? undefined!,
      after: { corrections: drift.length, sample: drift.slice(0, 20) },
    });
  } else {
    logger.info({ checked: jobs.length + employees.length }, 'reconcile: no drift');
  }

  return { drift, checked: jobs.length + employees.length };
}

if (process.argv.includes('--once')) {
  const { connectDb, disconnectDb } = await import('../config/db.js');
  await connectDb();
  const result = await reconcileCounters();
  logger.info({ corrections: result.drift.length, checked: result.checked }, 'reconcile: done');
  await disconnectDb();
  process.exit(0);
}

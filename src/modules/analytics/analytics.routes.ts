import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import {
  Application,
  ApplicationStatusEvent,
  Category,
  Employee,
  Job,
  Referral,
  Reward,
} from '../../models/index.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAdmin } from '../../middleware/auth.js';
import { daysAgo, istRangeStart } from '../../utils/dates.js';

export const adminAnalyticsRouter: Router = Router();

adminAnalyticsRouter.use(requireAdmin);

const periodQuery = z.object({
  period: z.enum(['7d', '30d', 'this_month', 'last_3m']).default('30d'),
  categoryId: z.string().length(24).optional(),
});

function periodStart(period: string): Date {
  switch (period) {
    case '7d':
      return daysAgo(7);
    case 'this_month':
      return istRangeStart('month');
    case 'last_3m':
      return daysAgo(90);
    default:
      return daysAgo(30);
  }
}

/**
 * Dashboard aggregations are computed on read with a short cache rather than
 * maintained incrementally. At this data volume a `$group` is microseconds, and
 * precomputed totals only invite drift.
 */
const cache = new Map<string, { value: unknown; expiresAt: number }>();
const CACHE_MS = 60_000;

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await fn();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}

export const invalidateAnalyticsCache = (): void => cache.clear();

/** The eight KPI tiles at the top of the dashboard. */
adminAnalyticsRouter.get(
  '/overview',
  validate({ query: periodQuery }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<z.infer<typeof periodQuery>>(res);
    const since = periodStart(q.period);
    const prevSince = new Date(since.getTime() - (Date.now() - since.getTime()));

    const data = await cached(`overview:${q.period}:${q.categoryId ?? 'all'}`, async () => {
      const employeeFilter: Record<string, unknown> = { deletedAt: null };
      const jobFilter: Record<string, unknown> = { deletedAt: null };
      if (q.categoryId) {
        const categoryId = new Types.ObjectId(q.categoryId);
        employeeFilter.categoryId = categoryId;
        jobFilter.categoryId = categoryId;
      }

      const [
        employees,
        employeesPrev,
        activeJobs,
        newJobsThisWeek,
        applications,
        applicationsPrev,
        referrals,
        referralsPrev,
        referralsHired,
        rewardsPending,
        rewardsPaid,
        hiredCount,
      ] = await Promise.all([
        Employee.countDocuments(employeeFilter),
        Employee.countDocuments({ ...employeeFilter, createdAt: { $lt: since } }),
        Job.countDocuments({ ...jobFilter, status: 'active' }),
        Job.countDocuments({ ...jobFilter, postedAt: { $gte: daysAgo(7) } }),
        Application.countDocuments({ appliedAt: { $gte: since } }),
        Application.countDocuments({ appliedAt: { $gte: prevSince, $lt: since } }),
        Referral.countDocuments({ createdAt: { $gte: since } }),
        Referral.countDocuments({ createdAt: { $gte: prevSince, $lt: since } }),
        Referral.countDocuments({
          status: { $in: ['hired', 'tenure_running', 'tenure_complete', 'reward_approved', 'rewarded'] },
        }),
        Reward.countDocuments({ status: 'pending_approval' }),
        Reward.aggregate<{ total: number }>([
          { $match: { status: 'paid' } },
          { $group: { _id: null, total: { $sum: '$approvedAmount' } } },
        ]),
        Application.countDocuments({ status: 'hired' }),
      ]);

      const totalApplications = await Application.countDocuments();
      const totalReferrals = await Referral.countDocuments();

      const growth = (current: number, previous: number) =>
        previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

      return {
        registeredEmployees: { value: employees, changePct: growth(employees, employeesPrev) },
        activeJobs: { value: activeJobs, newThisWeek: newJobsThisWeek },
        totalApplications: {
          value: totalApplications,
          changePct: growth(applications, applicationsPrev),
        },
        totalReferrals: { value: totalReferrals, changePct: growth(referrals, referralsPrev) },
        referralsHired: {
          value: referralsHired,
          conversionPct: totalReferrals > 0 ? Math.round((referralsHired / totalReferrals) * 100) : 0,
        },
        rewardsPending: { value: rewardsPending },
        totalRewardsPaid: { value: rewardsPaid[0]?.total ?? 0 },
        hireRate: {
          value:
            totalApplications > 0
              ? Math.round((hiredCount / totalApplications) * 1000) / 10
              : 0,
        },
      };
    });

    res.json({ data });
  }),
);

/** The three Quick Action cards. */
adminAnalyticsRouter.get(
  '/action-items',
  asyncHandler(async (_req, res) => {
    const [pendingShortlisting, rewardsToApprove, codesToAssign] = await Promise.all([
      Application.countDocuments({ status: 'applied' }),
      Reward.countDocuments({ status: 'pending_approval' }),
      Employee.countDocuments({
        deletedAt: null,
        employeeCode: null,
        profileCompletedAt: { $ne: null },
      }),
    ]);

    res.json({ data: { pendingShortlisting, rewardsToApprove, codesToAssign } });
  }),
);

adminAnalyticsRouter.get(
  '/jobs-by-category',
  validate({ query: z.object({ metric: z.enum(['count', 'applications']).default('count') }) }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<{ metric: 'count' | 'applications' }>(res);

    const rows = await Job.aggregate<{ _id: Types.ObjectId; count: number; applications: number }>([
      { $match: { deletedAt: null, status: { $in: ['active', 'closing'] } } },
      {
        $group: {
          _id: '$categoryId',
          count: { $sum: 1 },
          applications: { $sum: '$appliedCount' },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const categories = await Category.find({ _id: { $in: rows.map((r) => r._id) } })
      .select('name')
      .lean();
    const nameMap = new Map(categories.map((c) => [String(c._id), c.name]));

    res.json({
      data: rows.map((r) => ({
        categoryId: String(r._id),
        label: nameMap.get(String(r._id)) ?? 'Other',
        value: q.metric === 'applications' ? r.applications : r.count,
        jobCount: r.count,
        applicationCount: r.applications,
      })),
    });
  }),
);

adminAnalyticsRouter.get(
  '/employees-by-category',
  asyncHandler(async (_req, res) => {
    const rows = await Employee.aggregate<{ _id: Types.ObjectId | null; count: number }>([
      { $match: { deletedAt: null } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const categories = await Category.find({
      _id: { $in: rows.map((r) => r._id).filter(Boolean) },
    })
      .select('name')
      .lean();
    const nameMap = new Map(categories.map((c) => [String(c._id), c.name]));
    const total = rows.reduce((n, r) => n + r.count, 0);

    res.json({
      data: rows.map((r) => ({
        categoryId: r._id ? String(r._id) : null,
        label: r._id ? (nameMap.get(String(r._id)) ?? 'Other') : 'Uncategorised',
        value: r.count,
        pct: total > 0 ? Math.round((r.count / total) * 100) : 0,
      })),
      meta: { total },
    });
  }),
);

/**
 * The application funnel.
 *
 * Counted from the status-event log, not from current status: once a candidate
 * moves from shortlisted to hired, "how many were ever shortlisted" is
 * unanswerable from `applications.status` alone.
 */
adminAnalyticsRouter.get(
  '/funnel',
  asyncHandler(async (_req, res) => {
    const data = await cached('funnel', async () => {
      const [applied, reached, tenureDone] = await Promise.all([
        Application.countDocuments(),
        ApplicationStatusEvent.aggregate<{ _id: string; count: number }>([
          { $match: { to: { $in: ['shortlisted', 'interview', 'hired'] } } },
          // One application may be moved into a stage more than once; count
          // distinct applications, not events.
          { $group: { _id: { to: '$to', app: '$applicationId' } } },
          { $group: { _id: '$_id.to', count: { $sum: 1 } } },
        ]),
        Referral.countDocuments({
          status: { $in: ['tenure_complete', 'reward_approved', 'rewarded'] },
        }),
      ]);

      const byStage = Object.fromEntries(reached.map((r) => [r._id, r.count]));
      const pct = (n: number) => (applied > 0 ? Math.round((n / applied) * 100) : 0);

      return [
        { stage: 'Applied', count: applied, pct: 100 },
        { stage: 'Shortlisted', count: byStage.shortlisted ?? 0, pct: pct(byStage.shortlisted ?? 0) },
        { stage: 'Interviewed', count: byStage.interview ?? 0, pct: pct(byStage.interview ?? 0) },
        { stage: 'Hired', count: byStage.hired ?? 0, pct: pct(byStage.hired ?? 0) },
        { stage: 'Tenure Done', count: tenureDone, pct: pct(tenureDone) },
      ];
    });

    res.json({ data });
  }),
);

/**
 * Top referrers for the selected period.
 *
 * Aggregated from the referrals collection rather than read from
 * `employee.totalReferrals` — that column is all-time, and this widget is
 * explicitly period-scoped.
 */
adminAnalyticsRouter.get(
  '/top-referrers',
  validate({ query: periodQuery.extend({ limit: z.coerce.number().int().min(1).max(50).default(5) }) }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<z.infer<typeof periodQuery> & { limit: number }>(res);
    const since = periodStart(q.period);

    const rows = await Referral.aggregate<{ _id: Types.ObjectId; shares: number }>([
      { $match: { createdAt: { $gte: since }, status: { $nin: ['cancelled', 'expired'] } } },
      { $group: { _id: '$referrerId', shares: { $sum: 1 } } },
      { $sort: { shares: -1 } },
      { $limit: q.limit },
    ]);

    const employees = await Employee.find({ _id: { $in: rows.map((r) => r._id) } })
      .select('name employeeCode currentOrganization moneyEarned')
      .lean();
    const map = new Map(employees.map((e) => [String(e._id), e]));

    res.json({
      data: rows.map((r) => {
        const e = map.get(String(r._id));
        return {
          employeeId: String(r._id),
          name: e?.name ?? 'Unknown',
          employeeCode: e?.employeeCode ?? null,
          currentOrganization: e?.currentOrganization ?? null,
          shares: r.shares,
          moneyEarned: e?.moneyEarned ?? 0,
        };
      }),
    });
  }),
);

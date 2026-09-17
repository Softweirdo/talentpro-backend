import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Employee, Referral, Reward, recordAudit } from '../../models/index.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAdmin, requireEmployee, requirePermission } from '../../middleware/auth.js';
import {
  cursorFilter,
  cursorQuerySchema,
  pageQuerySchema,
  skipFor,
  toCursorPage,
  toOffsetPage,
} from '../../utils/paginate.js';
import { conflict, notFound } from '../../utils/errors.js';
import { formatCivilDate, istRangeStart } from '../../utils/dates.js';
import { REWARD_STATUSES } from '../../utils/constants.js';
import { recomputeMoneyEarned, transitionReferral } from '../../services/referralService.js';
import { notifyEmployee } from '../../services/notify.js';
import { sendSms, smsTemplates } from '../../services/sms/index.js';

function rewardRow(r: any, extra: { referral?: any; employee?: any; friend?: any } = {}) {
  return {
    id: String(r._id),
    referralId: String(r.referralId),
    status: r.status,
    suggestedAmount: r.suggestedAmount,
    approvedAmount: r.approvedAmount,
    eligibleAt: r.eligibleAt,
    eligibleDate: formatCivilDate(r.eligibleAt),
    approvedAt: r.approvedAt,
    paidAt: r.paidAt,
    paymentMethod: r.paymentMethod,
    paymentReference: r.paymentReference,
    holdReason: r.holdReason,
    voidReason: r.voidReason,
    referral: extra.referral
      ? {
          id: String(extra.referral._id),
          friendName: extra.referral.friendName,
          tenureMonths: extra.referral.tenureMonths,
          tenureCompletedDate: formatCivilDate(extra.referral.tenureCompletedOn),
        }
      : null,
    referrer: extra.employee
      ? {
          id: String(extra.employee._id),
          name: extra.employee.name,
          employeeCode: extra.employee.employeeCode,
          mobile: extra.employee.mobile,
          currentOrganization: extra.employee.currentOrganization,
        }
      : null,
    friend: extra.friend
      ? { id: String(extra.friend._id), name: extra.friend.name, currentOrganization: extra.friend.currentOrganization }
      : null,
  };
}

async function hydrateRewards(rows: any[]) {
  const referralIds = [...new Set(rows.map((r) => String(r.referralId)))];
  const employeeIds = [...new Set(rows.map((r) => String(r.employeeId)))];

  const referrals = await Referral.find({ _id: { $in: referralIds } })
    .select('friendName friendEmployeeId tenureMonths tenureCompletedOn jobId')
    .lean();

  const friendIds = referrals.map((r) => r.friendEmployeeId).filter(Boolean).map(String);
  const [employees, friends] = await Promise.all([
    Employee.find({ _id: { $in: employeeIds } })
      .select('name employeeCode mobile currentOrganization')
      .lean(),
    friendIds.length
      ? Employee.find({ _id: { $in: friendIds } }).select('name currentOrganization').lean()
      : [],
  ]);

  return {
    referrals: new Map(referrals.map((r) => [String(r._id), r])),
    employees: new Map(employees.map((e) => [String(e._id), e])),
    friends: new Map(friends.map((e) => [String(e._id), e])),
  };
}

// ─── Mobile ────────────────────────────────────────────────────────────────

export const rewardsRouter: Router = Router();

rewardsRouter.use(requireEmployee);

rewardsRouter.get(
  '/',
  validate({ query: cursorQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = validatedQuery<{ limit: number; cursor?: string }>(res);
    const rows = await Reward.find({
      employeeId: new Types.ObjectId(req.employee!.id),
      status: { $in: ['approved', 'paid'] },
      ...cursorFilter(q.cursor),
    })
      .sort({ _id: -1 })
      .limit(q.limit + 1)
      .lean();

    const page = toCursorPage(rows, q.limit);
    const { referrals } = await hydrateRewards(page.data);

    res.json({
      data: page.data.map((r) => rewardRow(r, { referral: referrals.get(String(r.referralId)) })),
      page: page.page,
    });
  }),
);

// ─── Admin ─────────────────────────────────────────────────────────────────

export const adminRewardsRouter: Router = Router();

adminRewardsRouter.use(requireAdmin);

const listQuery = pageQuerySchema.extend({
  status: z.enum(REWARD_STATUSES).optional(),
  employeeId: z.string().length(24).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

adminRewardsRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<z.infer<typeof listQuery>>(res);

    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.employeeId) filter.employeeId = new Types.ObjectId(q.employeeId);
    if (q.dateFrom || q.dateTo) {
      filter.eligibleAt = {
        ...(q.dateFrom ? { $gte: q.dateFrom } : {}),
        ...(q.dateTo ? { $lte: q.dateTo } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      Reward.find(filter).sort({ eligibleAt: 1 }).skip(skipFor(q.page, q.perPage)).limit(q.perPage).lean(),
      Reward.countDocuments(filter),
    ]);

    const { referrals, employees, friends } = await hydrateRewards(rows);

    res.json(
      toOffsetPage(
        rows.map((r) => {
          const referral = referrals.get(String(r.referralId));
          return rewardRow(r, {
            referral,
            employee: employees.get(String(r.employeeId)),
            friend: referral?.friendEmployeeId
              ? friends.get(String(referral.friendEmployeeId))
              : undefined,
          });
        }),
        total,
        q.page,
        q.perPage,
      ),
    );
  }),
);

/** The four tiles on the Rewards page. */
adminRewardsRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const monthStart = istRangeStart('month');

    const [pending, approvedThisMonth, allTimePaid] = await Promise.all([
      Reward.countDocuments({ status: 'pending_approval' }),
      Reward.aggregate<{ count: number; total: number }>([
        { $match: { status: { $in: ['approved', 'paid'] }, approvedAt: { $gte: monthStart } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$approvedAmount' } } },
      ]),
      Reward.aggregate<{ count: number; total: number }>([
        { $match: { status: 'paid' } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$approvedAmount' } } },
      ]),
    ]);

    const paid = allTimePaid[0] ?? { count: 0, total: 0 };

    res.json({
      data: {
        pendingApproval: pending,
        approvedThisMonth: {
          count: approvedThisMonth[0]?.count ?? 0,
          total: approvedThisMonth[0]?.total ?? 0,
        },
        totalPaid: paid.total,
        averageReward: paid.count > 0 ? Math.round(paid.total / paid.count) : 0,
      },
    });
  }),
);

adminRewardsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const reward = await Reward.findById(req.params.id).lean();
    if (!reward) throw notFound('REWARD_NOT_FOUND', 'Reward not found');
    const { referrals, employees, friends } = await hydrateRewards([reward]);
    const referral = referrals.get(String(reward.referralId));
    res.json({
      data: rewardRow(reward, {
        referral,
        employee: employees.get(String(reward.employeeId)),
        friend: referral?.friendEmployeeId ? friends.get(String(referral.friendEmployeeId)) : undefined,
      }),
    });
  }),
);

/** Edits the amount before approval — the inline input on the pending table. */
adminRewardsRouter.patch(
  '/:id',
  requirePermission('rewards:approve'),
  validate({ body: z.object({ approvedAmount: z.number().int().min(0) }) }),
  asyncHandler(async (req, res) => {
    const reward = await Reward.findById(req.params.id);
    if (!reward) throw notFound('REWARD_NOT_FOUND', 'Reward not found');
    if (!['pending_approval', 'on_hold'].includes(reward.status)) {
      throw conflict('REWARD_LOCKED', 'This reward has already been approved');
    }

    const before = reward.approvedAmount;
    reward.approvedAmount = req.body.approvedAmount;
    await reward.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'reward.amount.update',
      entityType: 'reward',
      entityId: reward._id,
      before: { approvedAmount: before, suggestedAmount: reward.suggestedAmount },
      after: { approvedAmount: reward.approvedAmount },
    });

    res.json({ data: rewardRow(reward) });
  }),
);

const approveSchema = z.object({
  amount: z.number().int().min(0).optional(),
  paymentMethod: z.enum(['upi', 'cash', 'bank']).optional(),
  paymentReference: z.string().max(120).optional(),
  markPaid: z.boolean().default(true),
});

/**
 * Approves a reward and, by default, records it as paid.
 *
 * `moneyEarned` is recomputed as a full re-sum of the ledger rather than
 * incremented, so the cached figure on the employee cannot drift away from
 * what was actually paid.
 */
async function approveOne(
  rewardId: Types.ObjectId | string,
  input: z.infer<typeof approveSchema>,
  adminId: string,
  idempotencyKey?: string,
) {
  const reward = await Reward.findById(rewardId);
  if (!reward) throw notFound('REWARD_NOT_FOUND', 'Reward not found');

  if (reward.status === 'paid') {
    // Already settled — replaying the request is a no-op, not an error.
    return { reward, alreadyPaid: true };
  }
  if (reward.status === 'void') {
    throw conflict('REWARD_VOID', 'This reward was voided and cannot be approved');
  }

  const amount = input.amount ?? reward.approvedAmount ?? reward.suggestedAmount;
  const before = { status: reward.status, approvedAmount: reward.approvedAmount };

  reward.approvedAmount = amount;
  reward.status = input.markPaid ? 'paid' : 'approved';
  reward.approvedAt = new Date();
  reward.approvedByAdminId = new Types.ObjectId(adminId);
  reward.holdReason = null;
  if (idempotencyKey) reward.idempotencyKey = idempotencyKey;
  if (input.markPaid) {
    reward.paidAt = new Date();
    reward.paymentMethod = input.paymentMethod ?? null;
    reward.paymentReference = input.paymentReference ?? null;
  }
  await reward.save();

  const referral = await Referral.findById(reward.referralId);
  if (referral) {
    if (referral.status === 'tenure_complete') {
      await transitionReferral(referral, 'reward_approved', {
        actorType: 'admin',
        actorId: adminId,
      });
    }
    if (input.markPaid && referral.status === 'reward_approved') {
      await transitionReferral(referral, 'rewarded', { actorType: 'admin', actorId: adminId });
    }
  }

  if (input.markPaid) {
    await recomputeMoneyEarned(reward.employeeId);

    const employee = await Employee.findById(reward.employeeId).select('mobile').lean();
    void notifyEmployee({
      employeeId: reward.employeeId,
      kind: 'reward_paid',
      title: 'Reward credited 💰',
      body: `Your referral reward of ₹${amount.toLocaleString('en-IN')} has been approved.`,
      data: { screen: 'Referrals', rewardId: String(reward._id) },
    });
    if (employee?.mobile) void sendSms(employee.mobile, smsTemplates.rewardPaid(amount));
  }

  await recordAudit({
    actorType: 'admin',
    actorId: adminId,
    action: input.markPaid ? 'reward.paid' : 'reward.approve',
    entityType: 'reward',
    entityId: reward._id,
    before,
    after: { status: reward.status, approvedAmount: amount },
  });

  return { reward, alreadyPaid: false };
}

adminRewardsRouter.post(
  '/:id/approve',
  requirePermission('rewards:approve'),
  validate({ body: approveSchema }),
  asyncHandler(async (req, res) => {
    const { reward, alreadyPaid } = await approveOne(
      String(req.params.id),
      req.body,
      req.admin!.id,
      req.headers['idempotency-key'] as string | undefined,
    );
    res.json({ data: rewardRow(reward), meta: { alreadyPaid } });
  }),
);

adminRewardsRouter.post(
  '/:id/hold',
  requirePermission('rewards:approve'),
  validate({ body: z.object({ reason: z.string().min(3).max(500) }) }),
  asyncHandler(async (req, res) => {
    const reward = await Reward.findById(req.params.id);
    if (!reward) throw notFound('REWARD_NOT_FOUND', 'Reward not found');
    if (reward.status === 'paid') throw conflict('REWARD_PAID', 'This reward has already been paid');

    reward.status = 'on_hold';
    reward.holdReason = req.body.reason;
    await reward.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'reward.hold',
      entityType: 'reward',
      entityId: reward._id,
      after: { reason: req.body.reason },
    });

    res.json({ data: rewardRow(reward) });
  }),
);

adminRewardsRouter.post(
  '/:id/void',
  requirePermission('rewards:approve'),
  validate({ body: z.object({ reason: z.string().min(3).max(500) }) }),
  asyncHandler(async (req, res) => {
    const reward = await Reward.findById(req.params.id);
    if (!reward) throw notFound('REWARD_NOT_FOUND', 'Reward not found');
    if (reward.status === 'paid') {
      throw conflict('REWARD_PAID', 'A paid reward cannot be voided. Record a reversal instead.');
    }

    reward.status = 'void';
    reward.voidReason = req.body.reason;
    await reward.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'reward.void',
      entityType: 'reward',
      entityId: reward._id,
      after: { reason: req.body.reason },
    });

    res.json({ data: rewardRow(reward) });
  }),
);

/**
 * "Approve All Eligible".
 *
 * Deliberately per-item: one bad row in a batch of eighty must not roll back
 * seventy-nine legitimate payouts. The response says exactly which failed.
 */
adminRewardsRouter.post(
  '/bulk-approve',
  requirePermission('rewards:approve'),
  validate({
    body: z.object({
      ids: z.array(z.string().length(24)).min(1).max(100).optional(),
      markPaid: z.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const ids: string[] =
      req.body.ids ??
      (await Reward.find({ status: 'pending_approval' }).select('_id').limit(100).lean()).map((r) =>
        String(r._id),
      );

    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const { reward } = await approveOne(id, { markPaid: req.body.markPaid }, req.admin!.id);
          return { id, ok: true as const, amount: reward.approvedAmount };
        } catch (err) {
          return { id, ok: false as const, error: (err as Error).message };
        }
      }),
    );

    const succeeded = results.filter((r) => r.ok);
    res.json({
      data: results,
      meta: {
        succeeded: succeeded.length,
        failed: results.length - succeeded.length,
        totalAmount: succeeded.reduce((n, r) => n + ((r as { amount?: number }).amount ?? 0), 0),
      },
    });
  }),
);

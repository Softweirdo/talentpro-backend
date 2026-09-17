import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import {
  Application,
  Category,
  Employee,
  Job,
  Referral,
  ReferralStatusEvent,
  recordAudit,
} from '../../models/index.js';
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
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { normalizeMobile } from '../../utils/mobile.js';
import { formatCivilDate, fromNow, tenureProgress } from '../../utils/dates.js';
import { REFERRAL_STATUSES } from '../../utils/constants.js';
import {
  recomputeReferralCount,
  resolveReferralTerms,
  transitionReferral,
} from '../../services/referralService.js';
import {
  REFERRAL_STATUS_BADGE,
  REFERRAL_STATUS_LABELS,
} from '../../services/referralStateMachine.js';
import { markTenureBroken } from '../applications/applications.service.js';
import { sendSms, smsTemplates } from '../../services/sms/index.js';

function referralCard(r: any, extra: { referrer?: any; friend?: any; job?: any } = {}) {
  const progress = tenureProgress(r.hiredOn, r.tenureDueOn);
  return {
    id: String(r._id),
    friendName: r.friendName,
    friendMobile: r.friendMobile,
    friendEmployeeId: r.friendEmployeeId ? String(r.friendEmployeeId) : null,
    status: r.status,
    statusLabel: REFERRAL_STATUS_LABELS[r.status as keyof typeof REFERRAL_STATUS_LABELS],
    statusBadge: REFERRAL_STATUS_BADGE[r.status as keyof typeof REFERRAL_STATUS_BADGE],
    tenureMonths: r.tenureMonths,
    rewardAmount: r.rewardAmount,
    hiredOn: r.hiredOn,
    hiredDate: formatCivilDate(r.hiredOn),
    tenureDueOn: r.tenureDueOn,
    tenureDueDate: formatCivilDate(r.tenureDueOn),
    tenureCompletedDate: formatCivilDate(r.tenureCompletedOn),
    // Derived on every read — never stored, so it stays correct through any
    // outage of the tenure cron.
    tenure: progress,
    sharedAt: r.createdAt,
    sharedAgo: r.createdAt ? fromNow(r.createdAt) : null,
    expiresAt: r.expiresAt,
    job: extra.job
      ? { id: String(extra.job._id), title: extra.job.title, company: extra.job.company }
      : null,
    referrer: extra.referrer
      ? {
          id: String(extra.referrer._id),
          name: extra.referrer.name,
          employeeCode: extra.referrer.employeeCode,
          currentOrganization: extra.referrer.currentOrganization,
        }
      : null,
    friend: extra.friend
      ? {
          id: String(extra.friend._id),
          name: extra.friend.name,
          employeeCode: extra.friend.employeeCode,
          currentOrganization: extra.friend.currentOrganization,
        }
      : null,
  };
}

async function hydrateReferrals(rows: any[]) {
  const referrerIds = [...new Set(rows.map((r) => String(r.referrerId)))];
  const friendIds = [...new Set(rows.map((r) => r.friendEmployeeId).filter(Boolean).map(String))];
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter(Boolean).map(String))];

  const [referrers, friends, jobs] = await Promise.all([
    Employee.find({ _id: { $in: referrerIds } })
      .select('name employeeCode currentOrganization')
      .lean(),
    friendIds.length
      ? Employee.find({ _id: { $in: friendIds } })
          .select('name employeeCode currentOrganization')
          .lean()
      : [],
    jobIds.length ? Job.find({ _id: { $in: jobIds } }).select('title company').lean() : [],
  ]);

  return {
    referrers: new Map(referrers.map((e) => [String(e._id), e])),
    friends: new Map(friends.map((e) => [String(e._id), e])),
    jobs: new Map(jobs.map((j) => [String(j._id), j])),
  };
}

// ─── Mobile ────────────────────────────────────────────────────────────────

export const referralsRouter: Router = Router();

referralsRouter.use(requireEmployee);

const createSchema = z.object({
  friendName: z.string().min(2).max(120),
  friendMobile: z.string().min(10).max(20),
  categoryId: z.string().length(24).optional().nullable(),
  jobId: z.string().length(24).optional().nullable(),
});

/**
 * Refer a friend.
 *
 * The reward terms are read from the job and *copied onto this referral*. The
 * app has just promised the employee a specific amount and tenure; editing the
 * job later must not change what was promised here.
 */
referralsRouter.post(
  '/',
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const referrer = await Employee.findById(req.employee!.id);
    if (!referrer) throw notFound('EMPLOYEE_NOT_FOUND', 'Account not found');

    const friendMobile = normalizeMobile(req.body.friendMobile);

    if (friendMobile === referrer.mobile) {
      throw unprocessable('SELF_REFERRAL', 'You cannot refer yourself');
    }

    const existingFriend = await Employee.findOne({ mobile: friendMobile, deletedAt: null });

    if (existingFriend?.isBlocked) {
      throw unprocessable('FRIEND_BLOCKED', 'This number cannot be referred');
    }

    // Someone already active on the platform is not a referral. Without this,
    // farming rewards by "referring" existing users is trivial.
    if (existingFriend?.profileCompletedAt) {
      const hasActivity = await Application.exists({ employeeId: existingFriend._id });
      if (hasActivity) {
        throw conflict(
          'FRIEND_ALREADY_ACTIVE',
          'This person is already an active TalentPro user and cannot be referred',
        );
      }
    }

    // Checked here for a clear error message, and enforced again by the unique
    // partial index below — two referrers submitting the same number at once
    // would both pass this check, and only the index settles that race.
    const liveClaim = await Referral.exists({ friendMobile, claimActive: true });
    if (liveClaim) {
      throw conflict(
        'FRIEND_ALREADY_REFERRED',
        'This mobile number has already been referred by someone else',
      );
    }

    const job = req.body.jobId
      ? await Job.findOne({ _id: req.body.jobId, deletedAt: null })
      : null;
    if (req.body.jobId && !job) throw notFound('JOB_NOT_FOUND', 'This job is no longer available');

    const terms = await resolveReferralTerms(job);
    const referral = await Referral.create({
      referrerId: referrer._id,
      jobId: job?._id ?? null,
      categoryId: req.body.categoryId
        ? new Types.ObjectId(req.body.categoryId)
        : (job?.categoryId ?? referrer.categoryId),
      friendName: req.body.friendName.trim(),
      friendMobile,
      friendEmployeeId: existingFriend?._id ?? null,
      status: 'pending',
      tenureMonths: terms.tenureMonths,
      rewardAmount: terms.rewardAmount,
      expiresAt: new Date(Date.now() + terms.claimWindowDays * 86_400_000),
    });

    const sms = await sendSms(
      friendMobile,
      smsTemplates.referralInvite(req.body.friendName, referrer.name, job?.title ?? null),
    );
    referral.smsStatus = sms.ok ? 'sent' : 'failed';
    referral.smsProviderMessageId = sms.providerMessageId ?? null;
    await referral.save();

    await recomputeReferralCount(referrer._id);

    res.status(201).json({ data: referralCard(referral, { job }) });
  }),
);

referralsRouter.get(
  '/',
  validate({ query: cursorQuerySchema.extend({ status: z.enum(REFERRAL_STATUSES).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = validatedQuery<{ limit: number; cursor?: string; status?: string }>(res);

    const filter: Record<string, unknown> = {
      referrerId: new Types.ObjectId(req.employee!.id),
      ...cursorFilter(q.cursor),
    };
    if (q.status) filter.status = q.status;

    const rows = await Referral.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
    const page = toCursorPage(rows, q.limit);
    const { friends, jobs } = await hydrateReferrals(page.data);

    res.json({
      data: page.data.map((r) =>
        referralCard(r, {
          friend: r.friendEmployeeId ? friends.get(String(r.friendEmployeeId)) : undefined,
          job: r.jobId ? jobs.get(String(r.jobId)) : undefined,
        }),
      ),
      page: page.page,
    });
  }),
);

/** The two tiles on the Referrals screen: Total Referrals and Total Earned. */
referralsRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const employeeId = new Types.ObjectId(req.employee!.id);
    const employee = await Employee.findById(employeeId).select('totalReferrals moneyEarned').lean();

    const byStatus = await Referral.aggregate<{ _id: string; count: number }>([
      { $match: { referrerId: employeeId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    res.json({
      data: {
        totalReferrals: employee?.totalReferrals ?? 0,
        moneyEarned: employee?.moneyEarned ?? 0,
        byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.count])),
      },
    });
  }),
);

referralsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const referral = await Referral.findOne({
      _id: req.params.id,
      referrerId: new Types.ObjectId(req.employee!.id),
    }).lean();
    if (!referral) throw notFound('REFERRAL_NOT_FOUND', 'Referral not found');

    const { friends, jobs } = await hydrateReferrals([referral]);
    const events = await ReferralStatusEvent.find({ referralId: referral._id })
      .sort({ createdAt: 1 })
      .select('from to createdAt')
      .lean();

    res.json({
      data: {
        ...referralCard(referral, {
          friend: referral.friendEmployeeId
            ? friends.get(String(referral.friendEmployeeId))
            : undefined,
          job: referral.jobId ? jobs.get(String(referral.jobId)) : undefined,
        }),
        timeline: events.map((e) => ({ from: e.from, to: e.to, at: e.createdAt })),
      },
    });
  }),
);

// ─── Admin ─────────────────────────────────────────────────────────────────

export const adminReferralsRouter: Router = Router();

adminReferralsRouter.use(requireAdmin);

const adminListQuery = pageQuerySchema.extend({
  q: z.string().max(120).optional(),
  status: z.enum(REFERRAL_STATUSES).optional(),
  categoryId: z.string().length(24).optional(),
  referrerId: z.string().length(24).optional(),
  jobId: z.string().length(24).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

adminReferralsRouter.get(
  '/',
  validate({ query: adminListQuery }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<z.infer<typeof adminListQuery>>(res);

    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.categoryId) filter.categoryId = new Types.ObjectId(q.categoryId);
    if (q.referrerId) filter.referrerId = new Types.ObjectId(q.referrerId);
    if (q.jobId) filter.jobId = new Types.ObjectId(q.jobId);
    if (q.dateFrom || q.dateTo) {
      filter.createdAt = {
        ...(q.dateFrom ? { $gte: q.dateFrom } : {}),
        ...(q.dateTo ? { $lte: q.dateTo } : {}),
      };
    }
    if (q.q) {
      const referrers = await Employee.find({
        $or: [
          { name: { $regex: q.q, $options: 'i' } },
          { employeeCode: { $regex: q.q, $options: 'i' } },
        ],
      })
        .select('_id')
        .limit(200)
        .lean();
      filter.$or = [
        { friendName: { $regex: q.q, $options: 'i' } },
        { friendMobile: { $regex: q.q, $options: 'i' } },
        { referrerId: { $in: referrers.map((e) => e._id) } },
      ];
    }

    const [rows, total] = await Promise.all([
      Referral.find(filter).sort({ createdAt: -1 }).skip(skipFor(q.page, q.perPage)).limit(q.perPage).lean(),
      Referral.countDocuments(filter),
    ]);

    const { referrers, friends, jobs } = await hydrateReferrals(rows);

    res.json(
      toOffsetPage(
        rows.map((r) =>
          referralCard(r, {
            referrer: referrers.get(String(r.referrerId)),
            friend: r.friendEmployeeId ? friends.get(String(r.friendEmployeeId)) : undefined,
            job: r.jobId ? jobs.get(String(r.jobId)) : undefined,
          }),
        ),
        total,
        q.page,
        q.perPage,
      ),
    );
  }),
);

/** The five funnel tiles on the admin Referrals page. */
adminReferralsRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const byStatus = await Referral.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const counts = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));
    const sum = (...keys: string[]) => keys.reduce((n, k) => n + (counts[k] ?? 0), 0);

    // Each tile counts everyone who reached that stage *or beyond*, which is
    // what makes the conversion percentages read correctly.
    const totalShares = Object.values(counts).reduce((a, b) => a + b, 0);
    const registered = sum(
      'registered', 'applied', 'shortlisted', 'hired',
      'tenure_running', 'tenure_complete', 'reward_approved', 'rewarded', 'tenure_broken',
    );
    const applied = sum(
      'applied', 'shortlisted', 'hired',
      'tenure_running', 'tenure_complete', 'reward_approved', 'rewarded', 'tenure_broken',
    );
    const hired = sum(
      'hired', 'tenure_running', 'tenure_complete', 'reward_approved', 'rewarded', 'tenure_broken',
    );
    const tenureDone = sum('tenure_complete', 'reward_approved', 'rewarded');

    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

    res.json({
      data: {
        totalShares,
        registered: { count: registered, rate: pct(registered, totalShares) },
        applied: { count: applied, rate: pct(applied, registered) },
        hired: { count: hired, rate: pct(hired, totalShares) },
        tenureDone: { count: tenureDone, rate: pct(tenureDone, hired) },
        byStatus: counts,
      },
    });
  }),
);

adminReferralsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const referral = await Referral.findById(req.params.id).lean();
    if (!referral) throw notFound('REFERRAL_NOT_FOUND', 'Referral not found');

    const { referrers, friends, jobs } = await hydrateReferrals([referral]);
    const events = await ReferralStatusEvent.find({ referralId: referral._id })
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      data: {
        ...referralCard(referral, {
          referrer: referrers.get(String(referral.referrerId)),
          friend: referral.friendEmployeeId
            ? friends.get(String(referral.friendEmployeeId))
            : undefined,
          job: referral.jobId ? jobs.get(String(referral.jobId)) : undefined,
        }),
        smsStatus: referral.smsStatus,
        timeline: events.map((e) => ({
          from: e.from,
          to: e.to,
          reason: e.reason,
          actorType: e.actorType,
          at: e.createdAt,
        })),
      },
    });
  }),
);

/** Terms are editable only before a hire — after that the amount is committed. */
adminReferralsRouter.patch(
  '/:id',
  requirePermission('referrals:write'),
  validate({
    body: z.object({
      friendName: z.string().min(2).max(120).optional(),
      tenureMonths: z.union([z.literal(3), z.literal(6)]).optional(),
      rewardAmount: z.number().int().min(0).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const referral = await Referral.findById(req.params.id);
    if (!referral) throw notFound('REFERRAL_NOT_FOUND', 'Referral not found');

    const termsChanged = req.body.tenureMonths !== undefined || req.body.rewardAmount !== undefined;
    if (termsChanged && referral.hiredOn) {
      throw conflict(
        'TERMS_LOCKED',
        'Tenure and reward cannot change after the referral has been hired',
      );
    }

    const before = {
      friendName: referral.friendName,
      tenureMonths: referral.tenureMonths,
      rewardAmount: referral.rewardAmount,
    };

    if (req.body.friendName) referral.friendName = req.body.friendName.trim();
    if (req.body.tenureMonths) referral.tenureMonths = req.body.tenureMonths;
    if (req.body.rewardAmount !== undefined) referral.rewardAmount = req.body.rewardAmount;
    await referral.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'referral.update',
      entityType: 'referral',
      entityId: referral._id,
      before,
      after: {
        friendName: referral.friendName,
        tenureMonths: referral.tenureMonths,
        rewardAmount: referral.rewardAmount,
      },
    });

    res.json({ data: referralCard(referral) });
  }),
);

adminReferralsRouter.post(
  '/:id/cancel',
  requirePermission('referrals:write'),
  validate({ body: z.object({ reason: z.string().min(3).max(500) }) }),
  asyncHandler(async (req, res) => {
    const referral = await Referral.findById(req.params.id);
    if (!referral) throw notFound('REFERRAL_NOT_FOUND', 'Referral not found');

    await transitionReferral(referral, 'cancelled', {
      reason: req.body.reason,
      actorType: 'admin',
      actorId: req.admin!.id,
    });
    referral.cancelledReason = req.body.reason;
    await referral.save();
    await recomputeReferralCount(referral.referrerId);

    res.json({ data: referralCard(referral) });
  }),
);

adminReferralsRouter.post(
  '/:id/break-tenure',
  requirePermission('referrals:write'),
  validate({
    body: z.object({ reason: z.string().min(3).max(500), leftOn: z.coerce.date().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const referral = await markTenureBroken(String(req.params.id), {
      reason: req.body.reason,
      leftOn: req.body.leftOn,
      actorId: req.admin!.id,
    });
    res.json({ data: referralCard(referral) });
  }),
);

/** Manually binds an existing employee as the friend, when SMS matching failed. */
adminReferralsRouter.post(
  '/:id/link-employee',
  requirePermission('referrals:write'),
  validate({ body: z.object({ employeeId: z.string().length(24) }) }),
  asyncHandler(async (req, res) => {
    const referral = await Referral.findById(req.params.id);
    if (!referral) throw notFound('REFERRAL_NOT_FOUND', 'Referral not found');

    const employee = await Employee.findById(req.body.employeeId);
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');
    if (String(employee._id) === String(referral.referrerId)) {
      throw unprocessable('SELF_REFERRAL', 'An employee cannot be their own referral');
    }

    referral.friendEmployeeId = employee._id;
    await referral.save();
    if (referral.status === 'pending') {
      await transitionReferral(referral, 'registered', {
        actorType: 'admin',
        actorId: req.admin!.id,
        reason: 'Manually linked by admin',
      });
    }

    res.json({ data: referralCard(referral) });
  }),
);

adminReferralsRouter.post(
  '/:id/resend-sms',
  requirePermission('referrals:write'),
  asyncHandler(async (req, res) => {
    const referral = await Referral.findById(req.params.id);
    if (!referral) throw notFound('REFERRAL_NOT_FOUND', 'Referral not found');

    const [referrer, job] = await Promise.all([
      Employee.findById(referral.referrerId).select('name').lean(),
      referral.jobId ? Job.findById(referral.jobId).select('title').lean() : null,
    ]);

    const sms = await sendSms(
      referral.friendMobile,
      smsTemplates.referralInvite(referral.friendName, referrer?.name ?? 'A friend', job?.title ?? null),
    );
    referral.smsStatus = sms.ok ? 'sent' : 'failed';
    referral.smsProviderMessageId = sms.providerMessageId ?? null;
    await referral.save();

    res.json({ data: { sent: sms.ok, error: sms.error ?? null } });
  }),
);

export { Category };

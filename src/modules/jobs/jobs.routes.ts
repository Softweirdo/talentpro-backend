import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import {
  Application,
  ApplicationStatusEvent,
  Employee,
  Job,
  Referral,
  getSettings,
  recordAudit,
} from '../../models/index.js';
import { applicationCard } from '../applications/applications.service.js';
import { transitionReferral } from '../../services/referralService.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAdmin, requireEmployee, requirePermission } from '../../middleware/auth.js';
import { cursorFilter, cursorQuerySchema, pageQuerySchema, skipFor, toCursorPage, toOffsetPage } from '../../utils/paginate.js';
import { conflict, notFound } from '../../utils/errors.js';
import {
  EXPERIENCE_BANDS,
  JOB_STATUSES,
  JOINING_URGENCIES,
  NOTIFY_CASES,
  TENURE_MONTH_OPTIONS,
} from '../../utils/constants.js';
import { broadcastJob } from '../../services/notify.js';
import {
  adminJob,
  appliedJobIds,
  attachCategoryNames,
  buildJobFilter,
  publicJob,
} from './jobs.service.js';

const listQuerySchema = cursorQuerySchema.extend({
  q: z.string().max(120).optional(),
  categoryId: z.string().length(24).optional(),
  location: z.string().max(120).optional(),
  experienceBand: z.enum(EXPERIENCE_BANDS).optional(),
  urgency: z.enum(JOINING_URGENCIES).optional(),
  sort: z.enum(['newest', 'salary']).default('newest'),
});

const adminListQuerySchema = pageQuerySchema.extend({
  q: z.string().max(120).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  categoryId: z.string().length(24).optional(),
  company: z.string().max(120).optional(),
  location: z.string().max(120).optional(),
});

const jobFields = z.object({
  title: z.string().min(2).max(140),
  company: z.string().min(2).max(140),
  location: z.string().min(2).max(140),
  categoryId: z.string().length(24),
  experienceBand: z.enum(EXPERIENCE_BANDS),
  joiningUrgency: z.enum(JOINING_URGENCIES),
  salaryMin: z.number().int().min(0),
  salaryMax: z.number().int().min(0),
  description: z.string().max(5000).nullable().optional(),
  requirements: z.array(z.string().max(300)).max(20).optional(),
  referralReward: z.number().int().min(0).optional(),
  tenureMonths: z.union([z.literal(3), z.literal(6)]).optional(),
  notifyCase: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  closesAt: z.coerce.date().nullable().optional(),
});

// The salary check is attached after `.partial()` rather than before, because a
// refined schema cannot be made partial.
const salaryOrder = (v: { salaryMin?: number; salaryMax?: number }) =>
  v.salaryMin === undefined || v.salaryMax === undefined || v.salaryMax >= v.salaryMin;
const salaryMessage = {
  message: 'Maximum salary must be at least the minimum',
  path: ['salaryMax'],
};

const jobBodySchema = jobFields.refine(salaryOrder, salaryMessage);
const jobPatchSchema = jobFields.partial().refine(salaryOrder, salaryMessage);

// ─── Mobile ────────────────────────────────────────────────────────────────

export const jobsRouter: Router = Router();

jobsRouter.use(requireEmployee);

jobsRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = validatedQuery<z.infer<typeof listQuerySchema>>(res);

    const filter = { ...buildJobFilter(q, { publicOnly: true }), ...cursorFilter(q.cursor) };
    // Sorting by salary abandons keyset pagination's stability guarantee, so it
    // falls back to _id as a tiebreaker to at least stay deterministic.
    const sort: Record<string, 1 | -1> =
      q.sort === 'salary' ? { salaryMax: -1, _id: -1 } : { _id: -1 };

    const rows = await Job.find(filter).sort(sort).limit(q.limit + 1).lean();
    const page = toCursorPage(rows, q.limit);

    const [categoryNames, applied] = await Promise.all([
      attachCategoryNames(page.data),
      appliedJobIds(req.employee!.id, page.data.map((j) => j._id)),
    ]);

    res.json({
      data: page.data.map((j) =>
        publicJob(j, {
          categoryName: categoryNames.get(String(j.categoryId)) ?? null,
          hasApplied: applied.has(String(j._id)),
        }),
      ),
      page: page.page,
    });
  }),
);

/**
 * "Recommended for You" — the employee's own category and experience band.
 * Falls back to the plain feed for a profile that has neither set, so the
 * section is never empty.
 */
jobsRouter.get(
  '/recommended',
  validate({ query: cursorQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = validatedQuery<z.infer<typeof cursorQuerySchema>>(res);
    const employee = await Employee.findById(req.employee!.id).select('categoryId experienceBand').lean();

    const filter: Record<string, unknown> = {
      deletedAt: null,
      status: { $in: ['active', 'closing'] },
      ...cursorFilter(q.cursor),
    };
    if (employee?.categoryId) filter.categoryId = employee.categoryId;
    if (employee?.experienceBand) filter.experienceBand = employee.experienceBand;

    let rows = await Job.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();

    if (rows.length === 0 && employee?.experienceBand) {
      delete filter.experienceBand;
      rows = await Job.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
    }

    const page = toCursorPage(rows, q.limit);
    const [categoryNames, applied] = await Promise.all([
      attachCategoryNames(page.data),
      appliedJobIds(req.employee!.id, page.data.map((j) => j._id)),
    ]);

    res.json({
      data: page.data.map((j) =>
        publicJob(j, {
          categoryName: categoryNames.get(String(j.categoryId)) ?? null,
          hasApplied: applied.has(String(j._id)),
        }),
      ),
      page: page.page,
    });
  }),
);

jobsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, deletedAt: null }).lean();
    if (!job || job.status === 'draft') throw notFound('JOB_NOT_FOUND', 'This job is no longer available');

    const [categoryNames, applied] = await Promise.all([
      attachCategoryNames([job]),
      appliedJobIds(req.employee!.id, [job._id]),
    ]);

    res.json({
      data: publicJob(job, {
        categoryName: categoryNames.get(String(job.categoryId)) ?? null,
        hasApplied: applied.has(String(job._id)),
      }),
    });
  }),
);

/**
 * Apply to a job.
 *
 * A double-tap on a flaky connection returns the existing application rather
 * than an error — from the worker's side that is the same outcome, and a 409
 * on the apply button reads as a broken app.
 */
jobsRouter.post(
  '/:id/apply',
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, deletedAt: null });
    if (!job) throw notFound('JOB_NOT_FOUND', 'This job is no longer available');
    if (job.status !== 'active' && job.status !== 'closing') {
      throw conflict('JOB_CLOSED', 'This job is no longer accepting applications');
    }

    const employee = await Employee.findById(req.employee!.id);
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Account not found');

    const existing = await Application.findOne({
      employeeId: employee._id,
      jobId: job._id,
      status: { $ne: 'withdrawn' },
    }).lean();

    if (existing) {
      res.status(200).json({ data: applicationCard(existing, job), meta: { alreadyApplied: true } });
      return;
    }

    // Did someone refer this employee to this job? If so the application is
    // "referred", and moving it through the pipeline drives that referral too.
    const referral = await Referral.findOne({
      friendEmployeeId: employee._id,
      status: { $in: ['registered', 'applied'] },
      ...(job._id ? { $or: [{ jobId: job._id }, { jobId: null }] } : {}),
    });

    const application = await Application.create({
      employeeId: employee._id,
      jobId: job._id,
      status: 'applied',
      source: referral ? 'referred' : 'direct',
      referralId: referral?._id ?? null,
      appliedAt: new Date(),
      // What HR sees is what was submitted, not whatever the profile says later.
      snapshot: {
        name: employee.name,
        mobile: employee.mobile,
        employeeCode: employee.employeeCode,
        age: employee.age,
        experienceBand: employee.experienceBand,
        categoryId: employee.categoryId ? String(employee.categoryId) : null,
        presentSalary: employee.presentSalary,
        expectedSalary: employee.expectedSalary,
        currentOrganization: employee.currentOrganization,
      },
    });

    await Job.updateOne({ _id: job._id }, { $inc: { appliedCount: 1 } });

    await ApplicationStatusEvent.create({
      applicationId: application._id,
      employeeId: employee._id,
      jobId: job._id,
      from: null,
      to: 'applied',
      actorType: 'employee',
      actorId: employee._id,
    });

    if (referral) {
      referral.friendApplicationId = application._id;
      referral.jobId ??= job._id;
      await referral.save();
      if (referral.status !== 'applied') {
        await transitionReferral(referral, 'applied', {
          actorType: 'employee',
          actorId: employee._id,
          metadata: { applicationId: String(application._id) },
        });
      }
    }

    res.status(201).json({ data: applicationCard(application, job) });
  }),
);

// ─── Admin ─────────────────────────────────────────────────────────────────

export const adminJobsRouter: Router = Router();

adminJobsRouter.use(requireAdmin);

adminJobsRouter.get(
  '/',
  validate({ query: adminListQuerySchema }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<z.infer<typeof adminListQuerySchema>>(res);
    const filter = buildJobFilter(q);

    const [rows, total] = await Promise.all([
      Job.find(filter).sort({ createdAt: -1 }).skip(skipFor(q.page, q.perPage)).limit(q.perPage).lean(),
      Job.countDocuments(filter),
    ]);

    const categoryNames = await attachCategoryNames(rows);
    const page = toOffsetPage(
      rows.map((j) => adminJob(j, categoryNames.get(String(j.categoryId)) ?? null)),
      total,
      q.page,
      q.perPage,
    );

    res.json(page);
  }),
);

adminJobsRouter.post(
  '/',
  requirePermission('jobs:write'),
  validate({ body: jobBodySchema }),
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const status = req.body.status ?? 'draft';

    const job = await Job.create({
      ...req.body,
      categoryId: new Types.ObjectId(req.body.categoryId),
      // Terms default from platform settings, then get snapshotted onto every
      // referral this job produces.
      referralReward: req.body.referralReward ?? settings.defaultRewardAmount,
      tenureMonths: req.body.tenureMonths ?? settings.defaultTenureMonths,
      notifyCase: req.body.notifyCase ?? 2,
      status,
      postedAt: status === 'active' ? new Date() : null,
      createdByAdminId: new Types.ObjectId(req.admin!.id),
    });

    if (status === 'active') {
      const recipients = await broadcastJob(job);
      job.notifiedAt = new Date();
      await job.save();
      res.status(201).json({ data: adminJob(job), meta: { notified: recipients } });
      return;
    }

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'job.create',
      entityType: 'job',
      entityId: job._id,
      after: { title: job.title, company: job.company, status: job.status },
    });

    res.status(201).json({ data: adminJob(job) });
  }),
);

adminJobsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, deletedAt: null }).lean();
    if (!job) throw notFound('JOB_NOT_FOUND', 'Job not found');
    const categoryNames = await attachCategoryNames([job]);
    res.json({ data: adminJob(job, categoryNames.get(String(job.categoryId)) ?? null) });
  }),
);

adminJobsRouter.patch(
  '/:id',
  requirePermission('jobs:write'),
  validate({ body: jobPatchSchema }),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, deletedAt: null });
    if (!job) throw notFound('JOB_NOT_FOUND', 'Job not found');

    const before = {
      title: job.title,
      status: job.status,
      referralReward: job.referralReward,
      tenureMonths: job.tenureMonths,
    };

    Object.assign(job, {
      ...req.body,
      ...(req.body.categoryId ? { categoryId: new Types.ObjectId(req.body.categoryId) } : {}),
    });

    if (req.body.status === 'active' && !job.postedAt) job.postedAt = new Date();
    await job.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'job.update',
      entityType: 'job',
      entityId: job._id,
      before,
      after: {
        title: job.title,
        status: job.status,
        referralReward: job.referralReward,
        tenureMonths: job.tenureMonths,
      },
    });

    res.json({ data: adminJob(job) });
  }),
);

adminJobsRouter.post(
  '/:id/status',
  requirePermission('jobs:write'),
  validate({ body: z.object({ status: z.enum(JOB_STATUSES) }) }),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, deletedAt: null });
    if (!job) throw notFound('JOB_NOT_FOUND', 'Job not found');

    const from = job.status;
    const to = req.body.status as (typeof JOB_STATUSES)[number];
    let notified = 0;

    job.status = to;
    // First publication sets postedAt and fires the audience blast; re-opening
    // a closed job does neither, so employees are not notified twice.
    if (to === 'active' && !job.postedAt) {
      job.postedAt = new Date();
      notified = await broadcastJob(job);
      job.notifiedAt = new Date();
    }
    await job.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'job.status',
      entityType: 'job',
      entityId: job._id,
      before: { status: from },
      after: { status: to },
    });

    res.json({ data: adminJob(job), meta: { notified } });
  }),
);

/** Re-sends the audience blast — for a job whose first notification failed. */
adminJobsRouter.post(
  '/:id/notify',
  requirePermission('jobs:write'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, deletedAt: null });
    if (!job) throw notFound('JOB_NOT_FOUND', 'Job not found');
    if (job.status !== 'active') {
      throw conflict('JOB_NOT_ACTIVE', 'Only active jobs can be broadcast');
    }

    const notified = await broadcastJob(job);
    job.notifiedAt = new Date();
    await job.save();

    res.json({ data: { notified } });
  }),
);

adminJobsRouter.delete(
  '/:id',
  requirePermission('jobs:write'),
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, deletedAt: null });
    if (!job) throw notFound('JOB_NOT_FOUND', 'Job not found');

    // Soft delete only — applications reference this job and candidates must
    // keep seeing what they applied to.
    job.deletedAt = new Date();
    job.status = 'closed';
    await job.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'job.delete',
      entityType: 'job',
      entityId: job._id,
      before: { title: job.title, status: job.status },
    });

    res.json({ data: { ok: true } });
  }),
);

export { NOTIFY_CASES, TENURE_MONTH_OPTIONS };

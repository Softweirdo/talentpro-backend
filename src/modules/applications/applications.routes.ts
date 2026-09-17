import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import {
  Application,
  ApplicationStatusEvent,
  Employee,
  Job,
  Referral,
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
import { APPLICATION_STATUSES, PIPELINE_COLUMNS } from '../../utils/constants.js';
import {
  applicationCard,
  hydrateApplications,
  setApplicationStatus,
} from './applications.service.js';

const ACTIVE_STATUSES = ['applied', 'shortlisted', 'interview'] as const;
const CLOSED_STATUSES = ['hired', 'rejected', 'withdrawn'] as const;

// ─── Mobile ────────────────────────────────────────────────────────────────

export const applicationsRouter: Router = Router();

applicationsRouter.use(requireEmployee);

applicationsRouter.get(
  '/',
  validate({
    query: cursorQuerySchema.extend({
      statusGroup: z.enum(['all', 'active', 'closed']).default('all'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = validatedQuery<{ limit: number; cursor?: string; statusGroup: string }>(res);
    const employeeId = new Types.ObjectId(req.employee!.id);

    const filter: Record<string, unknown> = { employeeId, ...cursorFilter(q.cursor) };
    if (q.statusGroup === 'active') filter.status = { $in: ACTIVE_STATUSES };
    if (q.statusGroup === 'closed') filter.status = { $in: CLOSED_STATUSES };

    const rows = await Application.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
    const page = toCursorPage(rows, q.limit);
    const { jobs } = await hydrateApplications(page.data);

    // Counts for the "All · 4 / Active · 3 / Closed · 1" chips.
    const counts = await Application.aggregate<{ _id: string; count: number }>([
      { $match: { employeeId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const byStatus = Object.fromEntries(counts.map((c) => [c._id, c.count]));
    const sum = (keys: readonly string[]) => keys.reduce((n, k) => n + (byStatus[k] ?? 0), 0);

    res.json({
      data: page.data.map((a) => applicationCard(a, jobs.get(String(a.jobId)))),
      page: page.page,
      meta: {
        counts: {
          all: sum(APPLICATION_STATUSES),
          active: sum(ACTIVE_STATUSES),
          closed: sum(CLOSED_STATUSES),
          byStatus,
        },
      },
    });
  }),
);

applicationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const application = await Application.findOne({
      _id: req.params.id,
      employeeId: new Types.ObjectId(req.employee!.id),
    }).lean();
    if (!application) throw notFound('APPLICATION_NOT_FOUND', 'Application not found');

    const [job, events] = await Promise.all([
      Job.findById(application.jobId).lean(),
      ApplicationStatusEvent.find({ applicationId: application._id })
        .sort({ createdAt: 1 })
        .select('from to createdAt')
        .lean(),
    ]);

    res.json({
      data: {
        ...applicationCard(application, job),
        timeline: events.map((e) => ({ from: e.from, to: e.to, at: e.createdAt })),
      },
    });
  }),
);

applicationsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const application = await Application.findOne({
      _id: req.params.id,
      employeeId: new Types.ObjectId(req.employee!.id),
    });
    if (!application) throw notFound('APPLICATION_NOT_FOUND', 'Application not found');

    // Withdrawing after an interview is scheduled needs a conversation with HR,
    // not a button.
    if (!['applied', 'shortlisted'].includes(application.status)) {
      throw conflict(
        'CANNOT_WITHDRAW',
        'This application has progressed too far to withdraw. Please contact support.',
      );
    }

    await setApplicationStatus(application._id, {
      status: 'withdrawn',
      actorType: 'employee',
      actorId: req.employee!.id,
    });

    await Job.updateOne({ _id: application.jobId }, { $inc: { appliedCount: -1 } });
    res.json({ data: { ok: true } });
  }),
);

// ─── Admin ─────────────────────────────────────────────────────────────────

export const adminApplicationsRouter: Router = Router();

adminApplicationsRouter.use(requireAdmin);

const adminListQuery = pageQuerySchema.extend({
  q: z.string().max(120).optional(),
  jobId: z.string().length(24).optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  source: z.enum(['direct', 'referred']).optional(),
  categoryId: z.string().length(24).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

async function buildAdminFilter(q: z.infer<typeof adminListQuery>) {
  const filter: Record<string, unknown> = {};
  if (q.jobId) filter.jobId = new Types.ObjectId(q.jobId);
  if (q.status) filter.status = q.status;
  if (q.source) filter.source = q.source;
  if (q.dateFrom || q.dateTo) {
    filter.appliedAt = {
      ...(q.dateFrom ? { $gte: q.dateFrom } : {}),
      ...(q.dateTo ? { $lte: q.dateTo } : {}),
    };
  }
  if (q.categoryId) {
    const jobIds = await Job.find({ categoryId: new Types.ObjectId(q.categoryId) })
      .select('_id')
      .lean();
    filter.jobId = { $in: jobIds.map((j) => j._id) };
  }
  if (q.q) {
    const employees = await Employee.find({
      $or: [
        { name: { $regex: q.q, $options: 'i' } },
        { employeeCode: { $regex: q.q, $options: 'i' } },
        { mobile: { $regex: q.q, $options: 'i' } },
      ],
    })
      .select('_id')
      .limit(200)
      .lean();
    filter.employeeId = { $in: employees.map((e) => e._id) };
  }
  return filter;
}

adminApplicationsRouter.get(
  '/',
  validate({ query: adminListQuery }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<z.infer<typeof adminListQuery>>(res);
    const filter = await buildAdminFilter(q);

    const [rows, total] = await Promise.all([
      Application.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skipFor(q.page, q.perPage))
        .limit(q.perPage)
        .lean(),
      Application.countDocuments(filter),
    ]);

    const { jobs, employees } = await hydrateApplications(rows);

    res.json(
      toOffsetPage(
        rows.map((a) =>
          applicationCard(a, jobs.get(String(a.jobId)), employees.get(String(a.employeeId))),
        ),
        total,
        q.page,
        q.perPage,
      ),
    );
  }),
);

/**
 * The kanban board. Each column is capped and carries its own total, so a
 * pipeline with 2,000 applications renders the first screenful per column
 * rather than the whole collection.
 */
adminApplicationsRouter.get(
  '/board',
  validate({
    query: z.object({
      jobId: z.string().length(24).optional(),
      categoryId: z.string().length(24).optional(),
      perColumn: z.coerce.number().int().min(5).max(100).default(25),
    }),
  }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<{ jobId?: string; categoryId?: string; perColumn: number }>(res);

    const base: Record<string, unknown> = {};
    if (q.jobId) base.jobId = new Types.ObjectId(q.jobId);
    if (q.categoryId) {
      const jobIds = await Job.find({ categoryId: new Types.ObjectId(q.categoryId) })
        .select('_id')
        .lean();
      base.jobId = { $in: jobIds.map((j) => j._id) };
    }

    const columns = await Promise.all(
      PIPELINE_COLUMNS.map(async (status) => {
        const filter = { ...base, status };
        const [rows, total] = await Promise.all([
          Application.find(filter).sort({ updatedAt: -1 }).limit(q.perColumn).lean(),
          Application.countDocuments(filter),
        ]);
        return { status, rows, total };
      }),
    );

    const allRows = columns.flatMap((c) => c.rows);
    const { jobs, employees } = await hydrateApplications(allRows);

    res.json({
      data: columns.map((c) => ({
        status: c.status,
        total: c.total,
        hasMore: c.total > c.rows.length,
        cards: c.rows.map((a) =>
          applicationCard(a, jobs.get(String(a.jobId)), employees.get(String(a.employeeId))),
        ),
      })),
    });
  }),
);

adminApplicationsRouter.get(
  '/calendar',
  validate({ query: z.object({ from: z.coerce.date(), to: z.coerce.date() }) }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<{ from: Date; to: Date }>(res);
    const rows = await Application.find({
      status: 'interview',
      interviewAt: { $gte: q.from, $lte: q.to },
    })
      .sort({ interviewAt: 1 })
      .lean();

    const { jobs, employees } = await hydrateApplications(rows);
    res.json({
      data: rows.map((a) =>
        applicationCard(a, jobs.get(String(a.jobId)), employees.get(String(a.employeeId))),
      ),
    });
  }),
);

adminApplicationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const application = await Application.findById(req.params.id).lean();
    if (!application) throw notFound('APPLICATION_NOT_FOUND', 'Application not found');

    const [job, employee, events, referral] = await Promise.all([
      Job.findById(application.jobId).lean(),
      Employee.findById(application.employeeId).lean(),
      ApplicationStatusEvent.find({ applicationId: application._id }).sort({ createdAt: 1 }).lean(),
      application.referralId ? Referral.findById(application.referralId).lean() : null,
    ]);

    res.json({
      data: {
        ...applicationCard(application, job, employee),
        snapshot: application.snapshot,
        referral: referral
          ? { id: String(referral._id), status: referral.status, referrerId: String(referral.referrerId) }
          : null,
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

const statusBodySchema = z.object({
  status: z.enum(APPLICATION_STATUSES),
  reason: z.string().max(500).nullable().optional(),
  interviewAt: z.coerce.date().nullable().optional(),
  interviewLocation: z.string().max(200).nullable().optional(),
  hiredOn: z.coerce.date().nullable().optional(),
});

/** The pipeline drag-and-drop write. */
adminApplicationsRouter.patch(
  '/:id/status',
  requirePermission('applications:write'),
  validate({ body: statusBodySchema }),
  asyncHandler(async (req, res) => {
    const { application, employmentConflict } = await setApplicationStatus(String(req.params.id), {
      ...req.body,
      actorType: 'admin',
      actorId: req.admin!.id,
    });

    const [job, employee] = await Promise.all([
      Job.findById(application.jobId).lean(),
      Employee.findById(application.employeeId).lean(),
    ]);

    res.json({
      data: applicationCard(application, job, employee),
      // Surfaced so the panel can prompt rather than silently rewriting a
      // worker's employment record from a drag.
      meta: employmentConflict
        ? {
            employmentConflict: {
              currentOrganization: employmentConflict,
              message: `This employee is recorded as working at ${employmentConflict}. Their current organization was left unchanged — update it manually if they have moved.`,
            },
          }
        : {},
    });
  }),
);

adminApplicationsRouter.patch(
  '/:id/interview',
  requirePermission('applications:write'),
  validate({
    body: z.object({
      interviewAt: z.coerce.date(),
      interviewLocation: z.string().max(200).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const application = await Application.findById(req.params.id);
    if (!application) throw notFound('APPLICATION_NOT_FOUND', 'Application not found');
    if (!['shortlisted', 'interview'].includes(application.status)) {
      throw unprocessable(
        'NOT_SHORTLISTED',
        'Only a shortlisted candidate can have an interview scheduled',
      );
    }

    const result = await setApplicationStatus(application._id, {
      status: 'interview',
      interviewAt: req.body.interviewAt,
      interviewLocation: req.body.interviewLocation ?? null,
      actorType: 'admin',
      actorId: req.admin!.id,
    });

    res.json({ data: applicationCard(result.application) });
  }),
);

adminApplicationsRouter.post(
  '/bulk-status',
  requirePermission('applications:write'),
  validate({
    body: z.object({
      ids: z.array(z.string().length(24)).min(1).max(100),
      status: z.enum(APPLICATION_STATUSES),
      reason: z.string().max(500).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    // Per-item rather than one transaction: a single invalid transition in a
    // batch of 60 should not undo the other 59.
    const results = await Promise.all(
      (req.body.ids as string[]).map(async (id) => {
        try {
          await setApplicationStatus(id, {
            status: req.body.status,
            reason: req.body.reason ?? null,
            actorType: 'admin',
            actorId: req.admin!.id,
          });
          return { id, ok: true as const };
        } catch (err) {
          return { id, ok: false as const, error: (err as Error).message };
        }
      }),
    );

    res.json({
      data: results,
      meta: { succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
    });
  }),
);

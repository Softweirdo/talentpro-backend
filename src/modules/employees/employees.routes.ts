import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import {
  Application,
  Category,
  Device,
  Employee,
  Referral,
  Reward,
  nextSequence,
  recordAudit,
} from '../../models/index.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAdmin, requireEmployee, requirePermission } from '../../middleware/auth.js';
import { pageQuerySchema, skipFor, toOffsetPage } from '../../utils/paginate.js';
import { conflict, notFound } from '../../utils/errors.js';
import { formatMonthYear, daysAgo, parseMonthYear } from '../../utils/dates.js';
import { normalizeMobile } from '../../utils/mobile.js';
import { EXPERIENCE_BANDS, LANGUAGES } from '../../utils/constants.js';
import {
  addHistoryEntry,
  clearCurrentOrganization,
  deleteHistoryEntry,
  setCurrentOrganization,
  updateHistoryEntry,
} from '../../services/employment.js';
import { publicEmployee } from '../auth/auth.service.js';
import { generateReferralCode } from '../../utils/crypto.js';

function employeeRow(e: any, categoryName?: string | null) {
  return {
    id: String(e._id),
    employeeCode: e.employeeCode,
    referralCode: e.referralCode,
    name: e.name,
    mobile: e.mobile,
    age: e.age,
    experienceBand: e.experienceBand,
    categoryId: e.categoryId ? String(e.categoryId) : null,
    categoryName: categoryName ?? null,
    presentSalary: e.presentSalary,
    expectedSalary: e.expectedSalary,
    currentOrganization: e.currentOrganization,
    isEmployed: Boolean(e.currentOrganization),
    totalReferrals: e.totalReferrals,
    moneyEarned: e.moneyEarned,
    language: e.language,
    isBlocked: e.isBlocked,
    lastActiveAt: e.lastActiveAt,
    createdAt: e.createdAt,
  };
}

const historyView = (stints: any[]) =>
  [...stints]
    .sort((a, b) => new Date(b.from).getTime() - new Date(a.from).getTime())
    .map((s) => ({
      id: String(s._id),
      company: s.company,
      from: s.from,
      to: s.to,
      // "Jan 2024 — Mar 2025", matching the panel in the prototype.
      period: `${formatMonthYear(s.from)} — ${s.to ? formatMonthYear(s.to) : 'Present'}`,
      isCurrent: s.to === null,
      source: s.source,
    }));

// ─── Mobile: the employee's own profile ────────────────────────────────────

export const meRouter: Router = Router();

meRouter.use(requireEmployee);

meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const employee = await Employee.findById(req.employee!.id);
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Account not found');

    const category = employee.categoryId
      ? await Category.findById(employee.categoryId).select('name nameGu').lean()
      : null;

    res.json({
      data: {
        ...publicEmployee(employee),
        categoryName: category?.name ?? null,
        categoryNameGu: category?.nameGu ?? null,
        // Employment is admin-maintained; the app shows it behind a lock badge.
        employmentHistory: historyView(employee.employmentHistory),
      },
    });
  }),
);

/**
 * Self-service profile edit.
 *
 * Deliberately excludes employment fields: `currentOrganization` and
 * `employmentHistory` are admin-owned, because referral tenure and payouts are
 * computed from them.
 */
meRouter.patch(
  '/',
  validate({
    body: z.object({
      name: z.string().min(2).max(120).optional(),
      age: z.number().int().min(16).max(75).optional(),
      experienceBand: z.enum(EXPERIENCE_BANDS).optional(),
      categoryId: z.string().length(24).optional(),
      presentSalary: z.number().int().min(0).max(10_000_000).nullable().optional(),
      expectedSalary: z.number().int().min(0).max(10_000_000).nullable().optional(),
      language: z.enum(LANGUAGES).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const employee = await Employee.findById(req.employee!.id);
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Account not found');

    const { categoryId, ...rest } = req.body;
    Object.assign(employee, rest);
    if (categoryId) employee.categoryId = new Types.ObjectId(categoryId);
    employee.lastActiveAt = new Date();
    await employee.save();

    res.json({ data: publicEmployee(employee) });
  }),
);

meRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const employeeId = new Types.ObjectId(req.employee!.id);
    const [employee, applicationCounts] = await Promise.all([
      Employee.findById(employeeId).select('totalReferrals moneyEarned').lean(),
      Application.aggregate<{ _id: string; count: number }>([
        { $match: { employeeId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      data: {
        totalReferrals: employee?.totalReferrals ?? 0,
        moneyEarned: employee?.moneyEarned ?? 0,
        applications: Object.fromEntries(applicationCounts.map((c) => [c._id, c.count])),
      },
    });
  }),
);

meRouter.post(
  '/devices',
  validate({
    body: z.object({
      fcmToken: z.string().min(10).max(500),
      platform: z.enum(['android', 'ios']),
      appVersion: z.string().max(20).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    // Upsert on the token rather than the employee: shared handsets are common,
    // and a re-registered token must follow whoever is signed in now.
    await Device.findOneAndUpdate(
      { fcmToken: req.body.fcmToken },
      {
        $set: {
          employeeId: new Types.ObjectId(req.employee!.id),
          platform: req.body.platform,
          appVersion: req.body.appVersion ?? null,
          lastSeenAt: new Date(),
        },
      },
      { upsert: true },
    );
    res.json({ data: { ok: true } });
  }),
);

meRouter.delete(
  '/devices',
  validate({ body: z.object({ fcmToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    await Device.deleteOne({ fcmToken: req.body.fcmToken });
    res.json({ data: { ok: true } });
  }),
);

// ─── Admin ─────────────────────────────────────────────────────────────────

export const adminEmployeesRouter: Router = Router();

adminEmployeesRouter.use(requireAdmin);

const listQuery = pageQuerySchema.extend({
  q: z.string().max(120).optional(),
  categoryId: z.string().length(24).optional(),
  employmentStatus: z.enum(['employed', 'unemployed']).optional(),
  hasCode: z.enum(['yes', 'no']).optional(),
  isBlocked: z.coerce.boolean().optional(),
});

adminEmployeesRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (_req, res) => {
    const q = validatedQuery<z.infer<typeof listQuery>>(res);

    const filter: Record<string, unknown> = { deletedAt: null };
    if (q.categoryId) filter.categoryId = new Types.ObjectId(q.categoryId);
    if (q.employmentStatus === 'employed') filter.currentOrganization = { $ne: null };
    if (q.employmentStatus === 'unemployed') filter.currentOrganization = null;
    if (q.hasCode === 'yes') filter.employeeCode = { $ne: null };
    if (q.hasCode === 'no') filter.employeeCode = null;
    if (q.isBlocked !== undefined) filter.isBlocked = q.isBlocked;
    if (q.q) {
      filter.$or = [
        { name: { $regex: q.q, $options: 'i' } },
        { employeeCode: { $regex: q.q, $options: 'i' } },
        { mobile: { $regex: q.q, $options: 'i' } },
      ];
    }

    const [rows, total] = await Promise.all([
      Employee.find(filter).sort({ createdAt: -1 }).skip(skipFor(q.page, q.perPage)).limit(q.perPage).lean(),
      Employee.countDocuments(filter),
    ]);

    const categoryIds = [...new Set(rows.map((r) => String(r.categoryId)).filter((id) => id !== 'null'))];
    const categories = await Category.find({ _id: { $in: categoryIds } }).select('name').lean();
    const categoryMap = new Map(categories.map((c) => [String(c._id), c.name]));

    res.json(
      toOffsetPage(
        rows.map((e) => employeeRow(e, categoryMap.get(String(e.categoryId)))),
        total,
        q.page,
        q.perPage,
      ),
    );
  }),
);

/** The four tiles above the employee table. */
adminEmployeesRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const [total, employed, active, withoutCode] = await Promise.all([
      Employee.countDocuments({ deletedAt: null }),
      Employee.countDocuments({ deletedAt: null, currentOrganization: { $ne: null } }),
      Employee.countDocuments({ deletedAt: null, lastActiveAt: { $gte: daysAgo(30) } }),
      Employee.countDocuments({ deletedAt: null, employeeCode: null, profileCompletedAt: { $ne: null } }),
    ]);

    res.json({
      data: {
        total,
        employed,
        employedRate: total > 0 ? Math.round((employed / total) * 100) : 0,
        activeLast30Days: active,
        engagementRate: total > 0 ? Math.round((active / total) * 100) : 0,
        withoutCode,
      },
    });
  }),
);

adminEmployeesRouter.post(
  '/',
  requirePermission('employees:write'),
  validate({
    body: z.object({
      name: z.string().min(2).max(120),
      mobile: z.string().min(10).max(20),
      age: z.number().int().min(16).max(75).optional(),
      experienceBand: z.enum(EXPERIENCE_BANDS).optional(),
      categoryId: z.string().length(24).optional(),
      presentSalary: z.number().int().min(0).optional(),
      expectedSalary: z.number().int().min(0).optional(),
      currentOrganization: z.string().max(120).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const mobile = normalizeMobile(req.body.mobile);
    if (await Employee.exists({ mobile, deletedAt: null })) {
      throw conflict('MOBILE_EXISTS', 'An employee with this mobile number already exists');
    }

    const employee = await Employee.create({
      mobile,
      referralCode: generateReferralCode(),
      name: req.body.name.trim(),
      age: req.body.age ?? null,
      experienceBand: req.body.experienceBand ?? null,
      categoryId: req.body.categoryId ? new Types.ObjectId(req.body.categoryId) : null,
      presentSalary: req.body.presentSalary ?? null,
      expectedSalary: req.body.expectedSalary ?? null,
      profileCompletedAt: new Date(),
    });

    if (req.body.currentOrganization) {
      await setCurrentOrganization(employee._id, {
        company: req.body.currentOrganization,
        source: 'signup',
        actorType: 'admin',
        actorId: req.admin!.id,
      });
    }

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'employee.create',
      entityType: 'employee',
      entityId: employee._id,
      after: { name: employee.name, mobile: employee.mobile },
    });

    res.status(201).json({ data: employeeRow(employee) });
  }),
);

/** Everything the slide-out panel renders. */
adminEmployeesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const employee = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

    const [category, applications, referrals, rewards] = await Promise.all([
      employee.categoryId ? Category.findById(employee.categoryId).select('name').lean() : null,
      Application.countDocuments({ employeeId: employee._id }),
      Referral.countDocuments({ referrerId: employee._id, status: { $nin: ['cancelled', 'expired'] } }),
      Reward.aggregate<{ total: number }>([
        { $match: { employeeId: employee._id, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$approvedAmount' } } },
      ]),
    ]);

    res.json({
      data: {
        ...employeeRow(employee, category?.name),
        employmentHistory: historyView(employee.employmentHistory),
        activity: {
          applications,
          referrals,
          // Read from the ledger, not the cached column — if they ever disagree
          // the panel should show what was actually paid.
          moneyEarned: rewards[0]?.total ?? 0,
        },
      },
    });
  }),
);

adminEmployeesRouter.patch(
  '/:id',
  requirePermission('employees:write'),
  validate({
    body: z.object({
      name: z.string().min(2).max(120).optional(),
      age: z.number().int().min(16).max(75).nullable().optional(),
      experienceBand: z.enum(EXPERIENCE_BANDS).nullable().optional(),
      categoryId: z.string().length(24).nullable().optional(),
      presentSalary: z.number().int().min(0).nullable().optional(),
      expectedSalary: z.number().int().min(0).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const employee = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

    const { categoryId, ...rest } = req.body;
    Object.assign(employee, rest);
    if (categoryId !== undefined) {
      employee.categoryId = categoryId ? new Types.ObjectId(categoryId) : null;
    }
    await employee.save();

    res.json({ data: employeeRow(employee) });
  }),
);

adminEmployeesRouter.post(
  '/:id/assign-code',
  requirePermission('employees:write'),
  validate({ body: z.object({ code: z.string().max(20).optional() }).optional() }),
  asyncHandler(async (req, res) => {
    const employee = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');
    if (employee.employeeCode) {
      throw conflict('CODE_ALREADY_ASSIGNED', `This employee already has code ${employee.employeeCode}`);
    }

    const explicit = req.body?.code?.trim().toUpperCase();
    if (explicit && (await Employee.exists({ employeeCode: explicit }))) {
      throw conflict('CODE_TAKEN', 'That employee code is already in use');
    }

    // Atomic allocation — MAX()+1 would hand two admins the same code.
    employee.employeeCode = explicit ?? `EMP-${await nextSequence('employee_code', 1000)}`;
    await employee.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'employee.assign_code',
      entityType: 'employee',
      entityId: employee._id,
      after: { employeeCode: employee.employeeCode },
    });

    res.json({ data: employeeRow(employee) });
  }),
);

// ─── Current organization: the inline ✎ cell and the panel ─────────────────

adminEmployeesRouter.put(
  '/:id/current-organization',
  requirePermission('employees:write'),
  validate({
    body: z.object({
      company: z.string().min(1).max(120),
      effectiveFrom: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await setCurrentOrganization(String(req.params.id), {
      company: req.body.company,
      effectiveFrom: req.body.effectiveFrom,
      actorType: 'admin',
      actorId: req.admin!.id,
      ip: req.ip,
    });

    res.json({
      data: {
        ...employeeRow(result.employee),
        employmentHistory: historyView(result.employee.employmentHistory),
      },
      meta: {
        changed: result.changed,
        // Lets the UI say "Saved — Welspun Corp moved to history".
        archived: result.archived,
      },
    });
  }),
);

adminEmployeesRouter.delete(
  '/:id/current-organization',
  requirePermission('employees:write'),
  asyncHandler(async (req, res) => {
    const result = await clearCurrentOrganization(String(req.params.id), {
      actorType: 'admin',
      actorId: req.admin!.id,
      ip: req.ip,
    });

    res.json({
      data: {
        ...employeeRow(result.employee),
        employmentHistory: historyView(result.employee.employmentHistory),
      },
      meta: { changed: result.changed, archived: result.archived },
    });
  }),
);

// ─── Employment history: closed stints only ────────────────────────────────

const monthYear = z.union([
  z.coerce.date(),
  z.string().transform((v, ctx) => {
    const parsed = parseMonthYear(v);
    if (!parsed) {
      ctx.addIssue({ code: 'custom', message: 'Use MM/YYYY' });
      return z.NEVER;
    }
    return parsed;
  }),
]);

adminEmployeesRouter.get(
  '/:id/employment-history',
  asyncHandler(async (req, res) => {
    const employee = await Employee.findOne({ _id: req.params.id, deletedAt: null })
      .select('employmentHistory')
      .lean();
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');
    res.json({ data: historyView(employee.employmentHistory) });
  }),
);

adminEmployeesRouter.post(
  '/:id/employment-history',
  requirePermission('employees:write'),
  validate({
    body: z.object({
      company: z.string().min(1).max(120),
      from: monthYear,
      to: monthYear,
      note: z.string().max(500).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const employee = await addHistoryEntry(
      String(req.params.id),
      req.body,
      { actorType: 'admin', actorId: req.admin!.id, ip: req.ip },
    );
    res.status(201).json({ data: historyView(employee.employmentHistory) });
  }),
);

adminEmployeesRouter.patch(
  '/:id/employment-history/:entryId',
  requirePermission('employees:write'),
  validate({
    body: z.object({
      company: z.string().min(1).max(120).optional(),
      from: monthYear.optional(),
      to: monthYear.optional(),
      note: z.string().max(500).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const employee = await updateHistoryEntry(
      String(req.params.id),
      String(req.params.entryId),
      req.body,
      { actorType: 'admin', actorId: req.admin!.id, ip: req.ip },
    );
    res.json({ data: historyView(employee.employmentHistory) });
  }),
);

adminEmployeesRouter.delete(
  '/:id/employment-history/:entryId',
  requirePermission('employees:write'),
  asyncHandler(async (req, res) => {
    const employee = await deleteHistoryEntry(
      String(req.params.id),
      String(req.params.entryId),
      { actorType: 'admin', actorId: req.admin!.id, ip: req.ip },
    );
    res.json({ data: historyView(employee.employmentHistory) });
  }),
);

adminEmployeesRouter.post(
  '/:id/block',
  requirePermission('employees:write'),
  validate({ body: z.object({ reason: z.string().min(3).max(500) }) }),
  asyncHandler(async (req, res) => {
    const employee = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

    employee.isBlocked = true;
    employee.blockedReason = req.body.reason;
    // Invalidates every live access token for this account immediately.
    employee.tokenVersion += 1;
    await employee.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'employee.block',
      entityType: 'employee',
      entityId: employee._id,
      after: { reason: req.body.reason },
    });

    res.json({ data: employeeRow(employee) });
  }),
);

adminEmployeesRouter.post(
  '/:id/unblock',
  requirePermission('employees:write'),
  asyncHandler(async (req, res) => {
    const employee = await Employee.findOne({ _id: req.params.id, deletedAt: null });
    if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'Employee not found');

    employee.isBlocked = false;
    employee.blockedReason = null;
    await employee.save();

    res.json({ data: employeeRow(employee) });
  }),
);

adminEmployeesRouter.get(
  '/:id/applications',
  asyncHandler(async (req, res) => {
    const rows = await Application.find({ employeeId: new Types.ObjectId(String(req.params.id)) })
      .sort({ appliedAt: -1 })
      .limit(100)
      .lean();
    res.json({ data: rows });
  }),
);

adminEmployeesRouter.get(
  '/:id/referrals',
  asyncHandler(async (req, res) => {
    const rows = await Referral.find({ referrerId: new Types.ObjectId(String(req.params.id)) })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ data: rows });
  }),
);

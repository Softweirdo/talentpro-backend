import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Category, Employee, Job, recordAudit, slugify } from '../../models/index.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAdmin, requirePermission } from '../../middleware/auth.js';
import { conflict, notFound } from '../../utils/errors.js';

const upsertSchema = z.object({
  name: z.string().min(2).max(60),
  nameGu: z.string().max(60).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const shape = (c: { _id: Types.ObjectId; name: string; nameGu: string | null; slug: string; isActive: boolean; sortOrder: number }) => ({
  id: String(c._id),
  name: c.name,
  nameGu: c.nameGu,
  slug: c.slug,
  isActive: c.isActive,
  sortOrder: c.sortOrder,
});

/**
 * Employee and job counts per category — the numbers under each tile on the
 * admin Categories page. Derived rather than stored: two parent collections
 * would have to stay transactionally in step to cache them honestly, for a
 * figure nobody needs to the second.
 */
async function withCounts() {
  const [categories, employeeCounts, jobCounts] = await Promise.all([
    Category.find().sort({ sortOrder: 1, name: 1 }).lean(),
    Employee.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { deletedAt: null, categoryId: { $ne: null } } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ]),
    Job.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { deletedAt: null, status: 'active' } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ]),
  ]);

  const employeeMap = new Map(employeeCounts.map((r) => [String(r._id), r.count]));
  const jobMap = new Map(jobCounts.map((r) => [String(r._id), r.count]));

  return categories.map((c) => ({
    ...shape(c),
    employeeCount: employeeMap.get(String(c._id)) ?? 0,
    jobCount: jobMap.get(String(c._id)) ?? 0,
  }));
}

/** Public: powers every category dropdown in the app (signup, profile, share form). */
export const publicCategoriesRouter: Router = Router();

publicCategoriesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
    res.json({ data: categories.map(shape) });
  }),
);

export const adminCategoriesRouter: Router = Router();

adminCategoriesRouter.use(requireAdmin);

adminCategoriesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await withCounts() });
  }),
);

adminCategoriesRouter.post(
  '/',
  requirePermission('jobs:write'),
  validate({ body: upsertSchema }),
  asyncHandler(async (req, res) => {
    const slug = slugify(req.body.name);
    if (await Category.exists({ slug })) {
      throw conflict('CATEGORY_EXISTS', 'A category with this name already exists');
    }

    const category = await Category.create({
      name: req.body.name.trim(),
      nameGu: req.body.nameGu ?? null,
      slug,
      sortOrder: req.body.sortOrder ?? 0,
      isActive: req.body.isActive ?? true,
    });

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'category.create',
      entityType: 'category',
      entityId: category._id,
      after: shape(category),
    });

    res.status(201).json({ data: shape(category) });
  }),
);

adminCategoriesRouter.patch(
  '/:id',
  requirePermission('jobs:write'),
  validate({ body: upsertSchema.partial() }),
  asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) throw notFound('CATEGORY_NOT_FOUND', 'Category not found');

    const before = shape(category);
    if (req.body.name !== undefined) {
      category.name = req.body.name.trim();
      category.slug = slugify(req.body.name);
    }
    if (req.body.nameGu !== undefined) category.nameGu = req.body.nameGu;
    if (req.body.sortOrder !== undefined) category.sortOrder = req.body.sortOrder;
    if (req.body.isActive !== undefined) category.isActive = req.body.isActive;

    await category.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'category.update',
      entityType: 'category',
      entityId: category._id,
      before,
      after: shape(category),
    });

    res.json({ data: shape(category) });
  }),
);

adminCategoriesRouter.delete(
  '/:id',
  requirePermission('jobs:write'),
  asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) throw notFound('CATEGORY_NOT_FOUND', 'Category not found');

    // Jobs and employees point at this category; deleting it would orphan them
    // and break every count on the dashboard. Archiving is the supported path.
    const [jobCount, employeeCount] = await Promise.all([
      Job.countDocuments({ categoryId: category._id, deletedAt: null }),
      Employee.countDocuments({ categoryId: category._id, deletedAt: null }),
    ]);

    if (jobCount > 0 || employeeCount > 0) {
      throw conflict(
        'CATEGORY_IN_USE',
        `This category is used by ${jobCount} job(s) and ${employeeCount} employee(s). Archive it instead of deleting.`,
        { jobCount, employeeCount },
      );
    }

    await category.deleteOne();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'category.delete',
      entityType: 'category',
      entityId: category._id,
      before: shape(category),
    });

    res.json({ data: { ok: true } });
  }),
);

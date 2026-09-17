import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Notification } from '../../models/index.js';
import { validate, validatedQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireEmployee } from '../../middleware/auth.js';
import { cursorFilter, cursorQuerySchema, toCursorPage } from '../../utils/paginate.js';
import { fromNow } from '../../utils/dates.js';

export const notificationsRouter: Router = Router();

notificationsRouter.use(requireEmployee);

notificationsRouter.get(
  '/',
  validate({ query: cursorQuerySchema.extend({ unreadOnly: z.coerce.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    const q = validatedQuery<{ limit: number; cursor?: string; unreadOnly: boolean }>(res);
    const employeeId = new Types.ObjectId(req.employee!.id);

    const filter: Record<string, unknown> = { employeeId, ...cursorFilter(q.cursor) };
    if (q.unreadOnly) filter.readAt = null;

    const [rows, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean(),
      Notification.countDocuments({ employeeId, readAt: null }),
    ]);

    const page = toCursorPage(rows, q.limit);

    res.json({
      data: page.data.map((n) => ({
        id: String(n._id),
        kind: n.kind,
        title: n.title,
        body: n.body,
        data: n.data,
        isRead: Boolean(n.readAt),
        createdAt: n.createdAt,
        createdAgo: fromNow(n.createdAt),
      })),
      page: page.page,
      // Drives the badge count on the bell icon.
      meta: { unreadCount },
    });
  }),
);

notificationsRouter.post(
  '/read',
  validate({
    body: z.object({
      ids: z.array(z.string().length(24)).max(200).optional(),
      all: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const employeeId = new Types.ObjectId(req.employee!.id);
    const filter: Record<string, unknown> = { employeeId, readAt: null };
    if (!req.body.all) {
      filter._id = { $in: (req.body.ids ?? []).map((id: string) => new Types.ObjectId(id)) };
    }

    const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
    res.json({ data: { updated: result.modifiedCount } });
  }),
);

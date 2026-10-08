import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  Admin,
  Role,
  effectivePermissions,
  invalidateRoleCache,
  recordAudit,
  type AdminDoc,
  type RoleDoc,
} from '../../models/index.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAdmin, requirePermission } from '../../middleware/auth.js';
import { hashPassword } from '../auth/auth.service.js';
import { revokeAllForSubject } from '../../services/tokens.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors.js';
import {
  PERMISSION_CATALOG,
  PERMISSIONS,
  SUPER_ADMIN_ROLE,
  type Permission,
} from '../../utils/constants.js';

/**
 * Nobody can hand out access they do not hold themselves. Without this, an
 * admin with only `admins:write` could create a role with `rewards:approve`,
 * assign it to a second account, and approve payouts through it.
 */
function assertCanGrant(req: Request, permissions: readonly Permission[]): void {
  const own = new Set(req.admin!.permissions);
  const missing = permissions.filter((p) => !own.has(p));
  if (missing.length > 0) {
    throw forbidden(
      'PERMISSION_ESCALATION',
      `You cannot grant permissions you do not hold: ${missing.join(', ')}`,
    );
  }
}

const roleKey = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const shapeRole = (r: Pick<RoleDoc, '_id' | 'key' | 'name' | 'description' | 'permissions' | 'isSystem'>) => ({
  id: String(r._id),
  key: r.key,
  name: r.name,
  description: r.description,
  permissions: effectivePermissions(r),
  isSystem: r.isSystem,
  isLocked: r.key === SUPER_ADMIN_ROLE,
});

// ── Roles ───────────────────────────────────────────────────────────────────

const permissionList = z
  .array(z.enum(PERMISSIONS))
  .max(PERMISSIONS.length)
  .transform((list) => [...new Set(list)]);

const roleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(240).nullable().optional(),
  permissions: permissionList,
});

export const adminRolesRouter: Router = Router();

adminRolesRouter.use(requireAdmin);

/** The permission catalog, grouped and labelled for the Roles page. */
adminRolesRouter.get(
  '/permissions',
  asyncHandler(async (_req, res) => {
    res.json({ data: PERMISSION_CATALOG });
  }),
);

adminRolesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [roles, counts] = await Promise.all([
      Role.find().sort({ isSystem: -1, createdAt: 1 }).lean(),
      Admin.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$role', count: { $sum: 1 } } },
      ]),
    ]);
    const countMap = new Map(counts.map((c) => [c._id, c.count]));
    res.json({
      data: roles.map((r) => ({ ...shapeRole(r), adminCount: countMap.get(r.key) ?? 0 })),
    });
  }),
);

adminRolesRouter.post(
  '/',
  requirePermission('admins:write'),
  validate({ body: roleBody }),
  asyncHandler(async (req, res) => {
    assertCanGrant(req, req.body.permissions);

    const key = roleKey(req.body.name);
    if (!key) throw badRequest('ROLE_NAME_INVALID', 'Role name needs at least one letter or digit');
    if (await Role.exists({ key })) {
      throw conflict('ROLE_EXISTS', 'A role with this name already exists');
    }

    const role = await Role.create({
      key,
      name: req.body.name,
      description: req.body.description ?? null,
      permissions: req.body.permissions,
      isSystem: false,
    });
    invalidateRoleCache();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'role.create',
      entityType: 'role',
      entityId: role._id,
      after: shapeRole(role),
    });

    res.status(201).json({ data: { ...shapeRole(role), adminCount: 0 } });
  }),
);

adminRolesRouter.patch(
  '/:id',
  requirePermission('admins:write'),
  validate({ body: roleBody.partial() }),
  asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id);
    if (!role) throw notFound('ROLE_NOT_FOUND', 'Role not found');
    if (role.key === SUPER_ADMIN_ROLE) {
      throw forbidden('ROLE_LOCKED', 'The Super Admin role always has every permission');
    }

    // Both sides are checked: you can neither add what you lack nor strip it
    // from a role that holds more than you do.
    assertCanGrant(req, role.permissions);
    if (req.body.permissions) assertCanGrant(req, req.body.permissions);

    const before = shapeRole(role);
    // The key is what admins reference, so renaming changes only the label.
    if (req.body.name !== undefined) role.name = req.body.name;
    if (req.body.description !== undefined) role.description = req.body.description;
    if (req.body.permissions !== undefined) role.permissions = req.body.permissions;
    await role.save();
    invalidateRoleCache();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'role.update',
      entityType: 'role',
      entityId: role._id,
      before,
      after: shapeRole(role),
    });

    res.json({ data: { ...shapeRole(role), adminCount: await Admin.countDocuments({ role: role.key }) } });
  }),
);

adminRolesRouter.delete(
  '/:id',
  requirePermission('admins:write'),
  asyncHandler(async (req, res) => {
    const role = await Role.findById(req.params.id);
    if (!role) throw notFound('ROLE_NOT_FOUND', 'Role not found');
    if (role.isSystem) throw forbidden('ROLE_SYSTEM', 'Built-in roles cannot be deleted');
    assertCanGrant(req, role.permissions);

    const adminCount = await Admin.countDocuments({ role: role.key });
    if (adminCount > 0) {
      throw conflict(
        'ROLE_IN_USE',
        `${adminCount} admin(s) still have this role. Move them to another role first.`,
        { adminCount },
      );
    }

    await role.deleteOne();
    invalidateRoleCache();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'role.delete',
      entityType: 'role',
      entityId: role._id,
      before: shapeRole(role),
    });

    res.json({ data: { ok: true } });
  }),
);

// ── Admin users ─────────────────────────────────────────────────────────────

const shapeAdmin = (a: Pick<AdminDoc, '_id' | 'name' | 'email' | 'role' | 'isActive' | 'lastLoginAt' | 'lockedUntil' | 'createdAt'>) => ({
  id: String(a._id),
  name: a.name,
  email: a.email,
  role: a.role,
  isActive: a.isActive,
  isLocked: Boolean(a.lockedUntil && a.lockedUntil.getTime() > Date.now()),
  lastLoginAt: a.lastLoginAt,
  createdAt: a.createdAt,
});

const password = z.string().min(10, 'Password must be at least 10 characters').max(128);

async function loadRole(key: string) {
  const role = await Role.findOne({ key }).lean();
  if (!role) throw badRequest('ROLE_NOT_FOUND', `No role "${key}"`);
  return role;
}

/** Guards against the one change that cannot be undone from inside the panel. */
async function assertNotLastSuperAdmin(admin: AdminDoc): Promise<void> {
  if (admin.role !== SUPER_ADMIN_ROLE || !admin.isActive) return;
  const others = await Admin.countDocuments({
    _id: { $ne: admin._id },
    role: SUPER_ADMIN_ROLE,
    isActive: true,
  });
  if (others === 0) {
    throw conflict('LAST_SUPER_ADMIN', 'At least one active Super Admin must remain');
  }
}

export const adminUsersRouter: Router = Router();

adminUsersRouter.use(requireAdmin);

adminUsersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const admins = await Admin.find().sort({ createdAt: 1 }).lean();
    res.json({ data: admins.map(shapeAdmin) });
  }),
);

adminUsersRouter.post(
  '/',
  requirePermission('admins:write'),
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(120),
      email: z.email().max(200),
      password,
      role: z.string().min(1).max(40),
    }),
  }),
  asyncHandler(async (req, res) => {
    const role = await loadRole(req.body.role);
    assertCanGrant(req, effectivePermissions(role));

    const email = req.body.email.toLowerCase();
    if (await Admin.exists({ email })) {
      throw conflict('ADMIN_EXISTS', 'An admin with this email already exists');
    }

    const admin = await Admin.create({
      name: req.body.name,
      email,
      passwordHash: await hashPassword(req.body.password),
      role: role.key,
    });

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'admin.create',
      entityType: 'admin',
      entityId: admin._id,
      after: shapeAdmin(admin),
    });

    res.status(201).json({ data: shapeAdmin(admin) });
  }),
);

/** Loads the target and checks the actor outranks it — you can only manage admins whose access is within your own. */
async function loadManageable(req: Request): Promise<AdminDoc> {
  const admin = await Admin.findById(req.params.id);
  if (!admin) throw notFound('ADMIN_NOT_FOUND', 'Admin not found');
  assertCanGrant(req, effectivePermissions(await loadRole(admin.role)));
  return admin;
}

adminUsersRouter.patch(
  '/:id',
  requirePermission('admins:write'),
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      role: z.string().min(1).max(40).optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const admin = await loadManageable(req);
    const isSelf = String(admin._id) === req.admin!.id;
    const before = shapeAdmin(admin);

    const roleChanges = req.body.role !== undefined && req.body.role !== admin.role;
    const deactivates = req.body.isActive === false && admin.isActive;

    if (isSelf && (roleChanges || deactivates)) {
      throw forbidden('ADMIN_SELF_CHANGE', 'You cannot change your own role or deactivate yourself');
    }
    if (roleChanges || deactivates) await assertNotLastSuperAdmin(admin);

    if (roleChanges) {
      const role = await loadRole(req.body.role!);
      assertCanGrant(req, effectivePermissions(role));
      admin.role = role.key;
    }
    if (req.body.name !== undefined) admin.name = req.body.name;
    if (req.body.isActive !== undefined) admin.isActive = req.body.isActive;

    if (deactivates) {
      // The guard already refuses inactive admins on every request; this also
      // kills their refresh tokens so the session cannot quietly resume.
      admin.tokenVersion += 1;
      await revokeAllForSubject('admin', admin._id, 'admin_deactivated');
    }

    await admin.save();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'admin.update',
      entityType: 'admin',
      entityId: admin._id,
      before,
      after: shapeAdmin(admin),
    });

    res.json({ data: shapeAdmin(admin) });
  }),
);

adminUsersRouter.post(
  '/:id/reset-password',
  requirePermission('admins:write'),
  validate({ body: z.object({ password }) }),
  asyncHandler(async (req, res) => {
    const admin = await loadManageable(req);

    admin.passwordHash = await hashPassword(req.body.password);
    admin.failedLoginCount = 0;
    admin.lockedUntil = null;
    // Every existing session, including the actor's own if it is themselves,
    // must sign in again with the new password.
    admin.tokenVersion += 1;
    await admin.save();
    await revokeAllForSubject('admin', admin._id, 'password_reset');

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'admin.password_reset',
      entityType: 'admin',
      entityId: admin._id,
    });

    res.json({ data: shapeAdmin(admin) });
  }),
);

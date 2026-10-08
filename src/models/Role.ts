import { Schema, model, type Document, type Types } from 'mongoose';
import { logger } from '../config/logger.js';
import {
  PERMISSIONS,
  SUPER_ADMIN_ROLE,
  SYSTEM_ROLES,
  type Permission,
} from '../utils/constants.js';

/**
 * A named bundle of permissions an admin is assigned. The permission *keys*
 * are fixed in code — every route checks one by name — so a role can only
 * choose among them, never invent new ones.
 */
export interface RoleDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  /** Stable slug stored on `admins.role`. Never changes after creation. */
  key: string;
  name: string;
  description: string | null;
  permissions: Permission[];
  /** Seeded roles. They can be edited (except super admin) but never deleted. */
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<RoleDoc>(
  {
    key: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, default: null, maxlength: 240 },
    permissions: { type: [String], enum: PERMISSIONS, default: [] },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'roles' },
);

roleSchema.index({ key: 1 }, { unique: true });

export const Role = model<RoleDoc>('Role', roleSchema);

/**
 * Super admin always holds every permission, whatever the stored document
 * says — otherwise one bad edit could leave nobody able to manage access.
 */
export const effectivePermissions = (role: Pick<RoleDoc, 'key' | 'permissions'>): Permission[] =>
  role.key === SUPER_ADMIN_ROLE ? [...PERMISSIONS] : role.permissions;

// Read on every gated admin request, so cached briefly in process — the same
// trade-off as settings. Writes through this module invalidate it immediately.
let cached: Map<string, Permission[]> | null = null;
let cachedAt = 0;
const TTL_MS = 30_000;

export async function permissionsForRole(key: string): Promise<Permission[]> {
  if (!cached || Date.now() - cachedAt >= TTL_MS) {
    const roles = await Role.find().select('key permissions').lean();
    cached = new Map(roles.map((r) => [r.key, effectivePermissions(r)]));
    cachedAt = Date.now();
  }
  return cached.get(key) ?? [];
}

export const invalidateRoleCache = (): void => {
  cached = null;
  cachedAt = 0;
};

/**
 * Creates any missing system role. Existing ones are left alone, so
 * permissions an admin edited survive a restart.
 */
export async function ensureSystemRoles(): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    const res = await Role.updateOne(
      { key: role.key },
      { $setOnInsert: { ...role, permissions: [...role.permissions], isSystem: true } },
      { upsert: true },
    );
    if (res.upsertedCount) logger.info({ role: role.key }, 'roles: system role created');
  }
  invalidateRoleCache();
}

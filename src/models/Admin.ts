import { Schema, model, type Document, type Types } from 'mongoose';
import { ADMIN_ROLES, type AdminRole } from '../utils/constants.js';

export interface AdminDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  role: AdminRole;
  isActive: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const adminSchema = new Schema<AdminDoc>(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ADMIN_ROLES, default: 'recruiter' },
    isActive: { type: Boolean, default: true },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'admins' },
);

adminSchema.index({ email: 1 }, { unique: true });

export const Admin = model<AdminDoc>('Admin', adminSchema);

/** Who may do what. Reward approval and settings are super-admin only — they move money and credentials. */
export const ROLE_PERMISSIONS: Record<AdminRole, string[]> = {
  viewer: ['read'],
  recruiter: ['read', 'jobs:write', 'applications:write', 'employees:write', 'referrals:write'],
  super_admin: [
    'read',
    'jobs:write',
    'applications:write',
    'employees:write',
    'referrals:write',
    'rewards:approve',
    'settings:write',
    'admins:write',
    'exports:read',
  ],
};

export const hasPermission = (role: AdminRole, permission: string): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);

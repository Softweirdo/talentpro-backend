import { Schema, model, type Document, type Types } from 'mongoose';
import type { AdminRole } from '../utils/constants.js';

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
    /** Key of a document in `roles` — validated by the admins module, not an enum, since roles are editable. */
    role: { type: String, required: true, trim: true, default: 'recruiter' },
    isActive: { type: Boolean, default: true },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'admins' },
);

adminSchema.index({ email: 1 }, { unique: true });
adminSchema.index({ role: 1 });

export const Admin = model<AdminDoc>('Admin', adminSchema);

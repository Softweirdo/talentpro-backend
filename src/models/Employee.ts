import { Schema, model, type Document, type Types } from 'mongoose';
import {
  EXPERIENCE_BANDS,
  EMPLOYMENT_SOURCES,
  LANGUAGES,
  type ExperienceBand,
  type EmploymentSource,
  type Language,
} from '../utils/constants.js';

export interface EmploymentStint {
  _id: Types.ObjectId;
  company: string;
  /** Civil date, month precision. */
  from: Date;
  /** `null` means this is the current stint — at most one per employee. */
  to: Date | null;
  source: EmploymentSource;
  jobId?: Types.ObjectId | null;
  createdByAdminId?: Types.ObjectId | null;
  note?: string | null;
}

export interface EmployeeDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  mobile: string;
  employeeCode: string | null;
  referralCode: string;

  name: string;
  age: number | null;
  experienceBand: ExperienceBand | null;
  categoryId: Types.ObjectId | null;
  presentSalary: number | null;
  expectedSalary: number | null;

  /** Cache of the open stint in `employmentHistory`. Never written directly. */
  currentOrganization: string | null;
  employmentHistory: EmploymentStint[];

  referredByEmployeeId: Types.ObjectId | null;
  referredByCodeRaw: string | null;

  totalReferrals: number;
  moneyEarned: number;

  language: Language;
  isBlocked: boolean;
  blockedReason: string | null;
  profileCompletedAt: Date | null;
  lastActiveAt: Date | null;
  /** Bumped to invalidate every live access token for this employee. */
  tokenVersion: number;
  deletedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

const employmentStintSchema = new Schema<EmploymentStint>(
  {
    company: { type: String, required: true, trim: true, maxlength: 120 },
    from: { type: Date, required: true },
    to: { type: Date, default: null },
    source: { type: String, enum: EMPLOYMENT_SOURCES, default: 'admin' },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', default: null },
    createdByAdminId: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    note: { type: String, default: null, maxlength: 500 },
  },
  { _id: true },
);

const employeeSchema = new Schema<EmployeeDoc>(
  {
    mobile: { type: String, required: true, trim: true },
    // Sparse: assigned by an admin, so it is legitimately absent for new
    // signups — the prototype's "— Pending —" rows and "Codes to Assign" tile.
    employeeCode: { type: String, default: null, trim: true, uppercase: true },
    referralCode: { type: String, required: true, trim: true, uppercase: true },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    age: { type: Number, default: null, min: 16, max: 75 },
    experienceBand: { type: String, enum: [...EXPERIENCE_BANDS, null], default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    presentSalary: { type: Number, default: null, min: 0 },
    expectedSalary: { type: Number, default: null, min: 0 },

    currentOrganization: { type: String, default: null, trim: true, maxlength: 120 },
    employmentHistory: { type: [employmentStintSchema], default: [] },

    referredByEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    referredByCodeRaw: { type: String, default: null, trim: true },

    totalReferrals: { type: Number, default: 0, min: 0 },
    moneyEarned: { type: Number, default: 0, min: 0 },

    language: { type: String, enum: LANGUAGES, default: 'en' },
    isBlocked: { type: Boolean, default: false },
    blockedReason: { type: String, default: null },
    profileCompletedAt: { type: Date, default: null },
    lastActiveAt: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'employees' },
);

employeeSchema.index(
  { mobile: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
employeeSchema.index(
  { employeeCode: 1 },
  { unique: true, partialFilterExpression: { employeeCode: { $type: 'string' } } },
);
employeeSchema.index({ referralCode: 1 }, { unique: true });
employeeSchema.index({ categoryId: 1, deletedAt: 1 });
employeeSchema.index({ currentOrganization: 1 });
employeeSchema.index({ lastActiveAt: -1 });
// Drives the "Codes to Assign: 17" queue.
employeeSchema.index({ createdAt: 1 }, { partialFilterExpression: { employeeCode: null } });
/**
 * `language_override` is pointed at a field that does not exist on purpose.
 *
 * A text index otherwise reads each document's own `language` field to pick a
 * stemmer — and this collection has a `language` field holding the employee's
 * UI preference. Saving a Gujarati profile would then fail with
 * "language override unsupported: gu", because MongoDB has no Gujarati stemmer.
 * Pointing the override at an unused field keeps the two meanings apart.
 */
employeeSchema.index(
  { name: 'text', employeeCode: 'text', mobile: 'text' },
  { language_override: 'textSearchLanguage', default_language: 'none' },
);

employeeSchema.virtual('isEmployed').get(function (this: EmployeeDoc) {
  return Boolean(this.currentOrganization);
});

employeeSchema.set('toJSON', { virtuals: true });
employeeSchema.set('toObject', { virtuals: true });

export const Employee = model<EmployeeDoc>('Employee', employeeSchema);

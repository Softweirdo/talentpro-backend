import { Schema, model, type Document, type Types } from 'mongoose';
import {
  EXPERIENCE_BANDS,
  JOB_STATUSES,
  JOINING_URGENCIES,
  NOTIFY_CASES,
  TENURE_MONTH_OPTIONS,
  type ExperienceBand,
  type JobStatus,
  type JoiningUrgency,
  type NotifyCase,
} from '../utils/constants.js';

export interface JobDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  title: string;
  company: string;
  location: string;
  categoryId: Types.ObjectId;
  experienceBand: ExperienceBand;
  joiningUrgency: JoiningUrgency;
  salaryMin: number;
  salaryMax: number;
  description: string | null;
  requirements: string[];

  /** Copied onto each referral at creation; editing these never alters money already promised. */
  referralReward: number;
  tenureMonths: number;

  notifyCase: NotifyCase;
  notifiedAt: Date | null;

  status: JobStatus;
  postedAt: Date | null;
  closesAt: Date | null;

  /** Denormalised; incremented alongside the application insert. */
  appliedCount: number;

  createdByAdminId: Types.ObjectId | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<JobDoc>(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    company: { type: String, required: true, trim: true, maxlength: 140 },
    location: { type: String, required: true, trim: true, maxlength: 140 },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    experienceBand: { type: String, enum: EXPERIENCE_BANDS, required: true },
    joiningUrgency: { type: String, enum: JOINING_URGENCIES, required: true },
    salaryMin: { type: Number, required: true, min: 0 },
    salaryMax: { type: Number, required: true, min: 0 },
    description: { type: String, default: null, maxlength: 5000 },
    requirements: { type: [String], default: [] },

    referralReward: { type: Number, required: true, min: 0 },
    tenureMonths: { type: Number, enum: TENURE_MONTH_OPTIONS, required: true },

    notifyCase: { type: Number, enum: NOTIFY_CASES, default: 2 },
    notifiedAt: { type: Date, default: null },

    status: { type: String, enum: JOB_STATUSES, default: 'draft' },
    postedAt: { type: Date, default: null },
    closesAt: { type: Date, default: null },

    appliedCount: { type: Number, default: 0, min: 0 },

    createdByAdminId: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'jobs' },
);

jobSchema.pre('validate', function (next) {
  if (this.salaryMax < this.salaryMin) {
    return next(new Error('salaryMax must be greater than or equal to salaryMin'));
  }
  next();
});

jobSchema.index({ status: 1, postedAt: -1, deletedAt: 1 });
jobSchema.index({ categoryId: 1, status: 1, deletedAt: 1 });
jobSchema.index({ experienceBand: 1, status: 1 });
jobSchema.index({ title: 'text', company: 'text', location: 'text' });

export const Job = model<JobDoc>('Job', jobSchema);

import { Schema, model, type Document, type Types } from 'mongoose';
import {
  ACTOR_TYPES,
  APPLICATION_SOURCES,
  APPLICATION_STATUSES,
  type ActorType,
  type ApplicationSource,
  type ApplicationStatus,
} from '../utils/constants.js';

export interface ApplicationDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  jobId: Types.ObjectId;
  status: ApplicationStatus;
  source: ApplicationSource;
  referralId: Types.ObjectId | null;

  interviewAt: Date | null;
  interviewLocation: string | null;
  /** Civil date — feeds referral tenure, so it must be an IST calendar day. */
  hiredOn: Date | null;
  rejectionReason: string | null;

  /**
   * The applicant's profile as submitted. HR must see what was sent, not what
   * the employee edited afterwards.
   */
  snapshot: Record<string, unknown>;

  appliedAt: Date;
  shortlistedAt: Date | null;
  rejectedAt: Date | null;
  withdrawnAt: Date | null;

  /**
   * False once withdrawn, so a candidate who withdrew can apply again.
   *
   * A stored flag rather than `status: { $ne: 'withdrawn' }` in the index,
   * because MongoDB rejects `$ne` in a `partialFilterExpression` — and does so
   * silently, leaving no unique index and no duplicate protection at all.
   */
  isLive: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const applicationSchema = new Schema<ApplicationDoc>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    status: { type: String, enum: APPLICATION_STATUSES, default: 'applied' },
    source: { type: String, enum: APPLICATION_SOURCES, default: 'direct' },
    referralId: { type: Schema.Types.ObjectId, ref: 'Referral', default: null },

    interviewAt: { type: Date, default: null },
    interviewLocation: { type: String, default: null, maxlength: 200 },
    hiredOn: { type: Date, default: null },
    rejectionReason: { type: String, default: null, maxlength: 500 },

    snapshot: { type: Schema.Types.Mixed, default: {} },

    appliedAt: { type: Date, default: () => new Date() },
    shortlistedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    isLive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'applications' },
);

applicationSchema.pre('save', function (next) {
  this.isLive = this.status !== 'withdrawn';
  next();
});

// One live application per employee per job.
applicationSchema.index(
  { employeeId: 1, jobId: 1 },
  { unique: true, partialFilterExpression: { isLive: true }, name: 'applications_live_uq' },
);
applicationSchema.index({ jobId: 1, status: 1 });
applicationSchema.index({ employeeId: 1, appliedAt: -1 });
applicationSchema.index({ status: 1, updatedAt: -1 });
applicationSchema.index({ interviewAt: 1 }, { partialFilterExpression: { status: 'interview' } });

export const Application = model<ApplicationDoc>('Application', applicationSchema);

/**
 * Stage transitions are recorded as events, not just as a current status,
 * because the dashboard funnel counts stages *ever reached*. Once a candidate
 * moves from shortlisted to hired, "how many were ever shortlisted" is
 * unanswerable from `status` alone.
 */
export interface ApplicationStatusEventDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  applicationId: Types.ObjectId;
  employeeId: Types.ObjectId;
  jobId: Types.ObjectId;
  from: ApplicationStatus | null;
  to: ApplicationStatus;
  reason: string | null;
  actorType: ActorType;
  actorId: Types.ObjectId | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const applicationStatusEventSchema = new Schema<ApplicationStatusEventDoc>(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: 'Application', required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    from: { type: String, enum: [...APPLICATION_STATUSES, null], default: null },
    to: { type: String, enum: APPLICATION_STATUSES, required: true },
    reason: { type: String, default: null, maxlength: 500 },
    actorType: { type: String, enum: ACTOR_TYPES, default: 'admin' },
    actorId: { type: Schema.Types.ObjectId, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'application_status_events' },
);

applicationStatusEventSchema.index({ applicationId: 1, createdAt: 1 });
applicationStatusEventSchema.index({ to: 1, createdAt: -1 });

export const ApplicationStatusEvent = model<ApplicationStatusEventDoc>(
  'ApplicationStatusEvent',
  applicationStatusEventSchema,
);

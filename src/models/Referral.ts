import { Schema, model, type Document, type Types } from 'mongoose';
import {
  ACTOR_TYPES,
  REFERRAL_STATUSES,
  REFERRAL_TERMINAL_STATUSES,
  TENURE_MONTH_OPTIONS,
  type ActorType,
  type ReferralStatus,
} from '../utils/constants.js';

export interface ReferralDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  referrerId: Types.ObjectId;
  jobId: Types.ObjectId | null;
  categoryId: Types.ObjectId | null;

  friendName: string;
  friendMobile: string;
  friendEmployeeId: Types.ObjectId | null;
  friendApplicationId: Types.ObjectId | null;

  status: ReferralStatus;

  /**
   * Snapshotted from the job at creation and never re-read. The app promises a
   * specific amount and tenure at share time; editing the job afterwards must
   * not change what was already promised.
   */
  tenureMonths: number;
  rewardAmount: number;

  hiredOn: Date | null;
  /** `hiredOn + tenureMonths`, stored so the cron is one indexed range scan. */
  tenureDueOn: Date | null;
  tenureCompletedOn: Date | null;
  tenureBrokenOn: Date | null;

  rewardId: Types.ObjectId | null;

  smsStatus: 'queued' | 'sent' | 'failed';
  smsProviderMessageId: string | null;

  /** Claim window — an unregistered referral lapses rather than paying out years later. */
  expiresAt: Date | null;
  cancelledReason: string | null;

  /**
   * True while this referral still holds the claim on `friendMobile`.
   *
   * A derived flag rather than a query on `status`, because MongoDB's
   * `partialFilterExpression` supports only `$eq`/`$exists`/comparisons — it
   * rejects the `$nin` over terminal statuses that would otherwise express
   * this, and does so *silently*, leaving no unique index at all.
   * `setClaimActive` keeps it in step with `status`.
   */
  claimActive: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const referralSchema = new Schema<ReferralDoc>(
  {
    referrerId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },

    friendName: { type: String, required: true, trim: true, maxlength: 120 },
    friendMobile: { type: String, required: true, trim: true },
    friendEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee', default: null },
    friendApplicationId: { type: Schema.Types.ObjectId, ref: 'Application', default: null },

    status: { type: String, enum: REFERRAL_STATUSES, default: 'pending' },

    tenureMonths: { type: Number, enum: TENURE_MONTH_OPTIONS, required: true },
    rewardAmount: { type: Number, required: true, min: 0 },

    hiredOn: { type: Date, default: null },
    tenureDueOn: { type: Date, default: null },
    tenureCompletedOn: { type: Date, default: null },
    tenureBrokenOn: { type: Date, default: null },

    rewardId: { type: Schema.Types.ObjectId, ref: 'Reward', default: null },

    smsStatus: { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' },
    smsProviderMessageId: { type: String, default: null },

    expiresAt: { type: Date, default: null },
    cancelledReason: { type: String, default: null, maxlength: 500 },
    claimActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'referrals' },
);

/** Keeps `claimActive` in step with `status`. Call before every save. */
export const setClaimActive = (referral: {
  status: ReferralStatus;
  claimActive: boolean;
}): void => {
  referral.claimActive = !REFERRAL_TERMINAL_STATUSES.includes(
    referral.status as (typeof REFERRAL_TERMINAL_STATUSES)[number],
  );
};

referralSchema.pre('save', function (next) {
  setClaimActive(this);
  next();
});

// First referrer wins: one live claim per friend mobile. A terminal status
// clears `claimActive`, which frees the number for a new referrer.
referralSchema.index(
  { friendMobile: 1 },
  {
    unique: true,
    partialFilterExpression: { claimActive: true },
    name: 'referrals_friend_live_uq',
  },
);
referralSchema.index({ referrerId: 1, createdAt: -1 });
referralSchema.index({ status: 1, createdAt: -1 });
// The tenure cron's only hot path.
referralSchema.index({ status: 1, tenureDueOn: 1 });
referralSchema.index({ friendEmployeeId: 1 });
referralSchema.index({ expiresAt: 1 }, { partialFilterExpression: { status: 'pending' } });

export const Referral = model<ReferralDoc>('Referral', referralSchema);

export interface ReferralStatusEventDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  referralId: Types.ObjectId;
  referrerId: Types.ObjectId;
  from: ReferralStatus | null;
  to: ReferralStatus;
  reason: string | null;
  actorType: ActorType;
  actorId: Types.ObjectId | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const referralStatusEventSchema = new Schema<ReferralStatusEventDoc>(
  {
    referralId: { type: Schema.Types.ObjectId, ref: 'Referral', required: true },
    referrerId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    from: { type: String, enum: [...REFERRAL_STATUSES, null], default: null },
    to: { type: String, enum: REFERRAL_STATUSES, required: true },
    reason: { type: String, default: null, maxlength: 500 },
    actorType: { type: String, enum: ACTOR_TYPES, default: 'system' },
    actorId: { type: Schema.Types.ObjectId, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'referral_status_events' },
);

referralStatusEventSchema.index({ referralId: 1, createdAt: 1 });

export const ReferralStatusEvent = model<ReferralStatusEventDoc>(
  'ReferralStatusEvent',
  referralStatusEventSchema,
);

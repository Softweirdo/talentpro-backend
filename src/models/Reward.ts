import { Schema, model, type Document, type Types } from 'mongoose';
import { REWARD_STATUSES, type RewardStatus } from '../utils/constants.js';

/**
 * The rewards collection is the payout ledger — the authoritative record of
 * what was owed and paid. `Employee.moneyEarned` is only a cache over it.
 */
export interface RewardDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  referralId: Types.ObjectId;
  employeeId: Types.ObjectId;

  /** Snapshotted from the referral; `approvedAmount` is what an admin actually authorised. */
  suggestedAmount: number;
  approvedAmount: number | null;

  status: RewardStatus;
  eligibleAt: Date;
  approvedAt: Date | null;
  approvedByAdminId: Types.ObjectId | null;
  paidAt: Date | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  holdReason: string | null;
  voidReason: string | null;
  idempotencyKey: string | null;

  createdAt: Date;
  updatedAt: Date;
}

const rewardSchema = new Schema<RewardDoc>(
  {
    referralId: { type: Schema.Types.ObjectId, ref: 'Referral', required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },

    suggestedAmount: { type: Number, required: true, min: 0 },
    approvedAmount: { type: Number, default: null, min: 0 },

    status: { type: String, enum: REWARD_STATUSES, default: 'pending_approval' },
    eligibleAt: { type: Date, required: true },
    approvedAt: { type: Date, default: null },
    approvedByAdminId: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    paidAt: { type: Date, default: null },
    paymentMethod: { type: String, default: null },
    paymentReference: { type: String, default: null },
    holdReason: { type: String, default: null, maxlength: 500 },
    voidReason: { type: String, default: null, maxlength: 500 },
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: true, collection: 'rewards' },
);

// One reward per referral, ever. This unique index is the idempotency boundary
// that makes the tenure cron safe to run twice.
rewardSchema.index({ referralId: 1 }, { unique: true });
rewardSchema.index({ status: 1, eligibleAt: 1 });
rewardSchema.index({ employeeId: 1, status: 1 });
rewardSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export const Reward = model<RewardDoc>('Reward', rewardSchema);

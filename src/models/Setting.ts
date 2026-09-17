import { Schema, model, type Document, type Types } from 'mongoose';
import { DEFAULTS, TENURE_MONTH_OPTIONS } from '../utils/constants.js';

/** Single-document platform configuration, edited from the admin Settings page. */
export interface SettingDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  key: 'platform';
  smsProvider: 'fast2sms' | 'msg91' | 'textlocal';
  smsSenderId: string;
  /** Encrypted at rest; the API only ever returns a masked form. */
  smsApiKeyEnc: string | null;
  fcmServerKeyEnc: string | null;
  defaultTenureMonths: number;
  defaultRewardAmount: number;
  tokenExpiryDays: number;
  referralClaimWindowDays: number;
  updatedByAdminId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const settingSchema = new Schema<SettingDoc>(
  {
    key: { type: String, enum: ['platform'], default: 'platform' },
    smsProvider: {
      type: String,
      enum: ['fast2sms', 'msg91', 'textlocal'],
      default: 'fast2sms',
    },
    smsSenderId: { type: String, default: DEFAULTS.smsSenderId, maxlength: 11 },
    smsApiKeyEnc: { type: String, default: null, select: false },
    fcmServerKeyEnc: { type: String, default: null, select: false },
    defaultTenureMonths: {
      type: Number,
      enum: TENURE_MONTH_OPTIONS,
      default: DEFAULTS.tenureMonths,
    },
    defaultRewardAmount: { type: Number, default: DEFAULTS.rewardAmount, min: 0 },
    tokenExpiryDays: { type: Number, default: DEFAULTS.tokenExpiryDays, min: 1 },
    referralClaimWindowDays: {
      type: Number,
      default: DEFAULTS.referralClaimWindowDays,
      min: 1,
    },
    updatedByAdminId: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true, collection: 'settings' },
);

settingSchema.index({ key: 1 }, { unique: true });

export const Setting = model<SettingDoc>('Setting', settingSchema);

let cached: SettingDoc | null = null;
let cachedAt = 0;
const TTL_MS = 30_000;

/** Read on nearly every write path, so it is cached briefly in process. */
export async function getSettings(force = false): Promise<SettingDoc> {
  if (!force && cached && Date.now() - cachedAt < TTL_MS) return cached;
  const doc =
    (await Setting.findOne({ key: 'platform' })) ??
    (await Setting.create({ key: 'platform' }));
  cached = doc;
  cachedAt = Date.now();
  return doc;
}

export const invalidateSettingsCache = (): void => {
  cached = null;
  cachedAt = 0;
};

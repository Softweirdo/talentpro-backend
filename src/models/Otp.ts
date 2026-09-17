import { Schema, model, type Document, type Types } from 'mongoose';
import { DEFAULTS } from '../utils/constants.js';

export interface OtpDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  mobile: string;
  /** HMAC-SHA256 under a server pepper — the plaintext code is never persisted. */
  codeHash: string;
  purpose: 'login';
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  requestIp: string | null;
  deviceId: string | null;
  smsStatus: 'queued' | 'sent' | 'failed';
  createdAt: Date;
}

const otpSchema = new Schema<OtpDoc>(
  {
    mobile: { type: String, required: true, trim: true },
    codeHash: { type: String, required: true, select: false },
    purpose: { type: String, enum: ['login'], default: 'login' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: DEFAULTS.otpMaxAttempts },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    requestIp: { type: String, default: null },
    deviceId: { type: String, default: null },
    smsStatus: { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'otps' },
);

otpSchema.index({ mobile: 1, createdAt: -1 });
// Expired OTPs are swept by Mongo itself; the grace period keeps a short audit
// trail for rate limiting after expiry.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const Otp = model<OtpDoc>('Otp', otpSchema);

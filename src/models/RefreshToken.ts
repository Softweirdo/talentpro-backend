import { Schema, model, type Document, type Types } from 'mongoose';

export interface RefreshTokenDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  subjectType: 'employee' | 'admin';
  subjectId: Types.ObjectId;
  /** Only the SHA-256 of the opaque token is stored. */
  tokenHash: string;
  /**
   * Rotation family. Presenting an already-revoked token means it leaked, so
   * the whole family is revoked and the user must re-authenticate — the
   * cheapest meaningful defence for a passwordless app.
   */
  familyId: Types.ObjectId;
  parentId: Types.ObjectId | null;
  deviceId: string | null;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<RefreshTokenDoc>(
  {
    subjectType: { type: String, enum: ['employee', 'admin'], required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true },
    familyId: { type: Schema.Types.ObjectId, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'RefreshToken', default: null },
    deviceId: { type: String, default: null },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'refresh_tokens' },
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ subjectType: 1, subjectId: 1, revokedAt: 1 });
refreshTokenSchema.index({ familyId: 1 });
// Swept a week after expiry, leaving a window for reuse detection on stale tokens.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 604_800 });

export const RefreshToken = model<RefreshTokenDoc>('RefreshToken', refreshTokenSchema);

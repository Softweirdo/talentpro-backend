import { Schema, model, type Document, type Types } from 'mongoose';
import { ACTOR_TYPES, type ActorType } from '../utils/constants.js';
import { logger } from '../config/logger.js';

export interface AuditLogDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  actorType: ActorType;
  actorId: Types.ObjectId | null;
  /** Dotted action name, e.g. `employee.current_org.set`, `reward.approve`. */
  action: string;
  entityType: string;
  entityId: Types.ObjectId;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: Date;
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    actorType: { type: String, enum: ACTOR_TYPES, required: true },
    actorId: { type: Schema.Types.ObjectId, default: null },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_log' },
);

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export const AuditLog = model<AuditLogDoc>('AuditLog', auditLogSchema);

export interface AuditInput {
  actorType: ActorType;
  actorId?: Types.ObjectId | string | null;
  action: string;
  entityType: string;
  entityId: Types.ObjectId | string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/**
 * Audit writes must never take down the business operation that triggered
 * them — a failure here is logged, not thrown.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before ?? null,
      after: input.after ?? null,
      ip: input.ip ?? null,
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'audit: write failed');
  }
}

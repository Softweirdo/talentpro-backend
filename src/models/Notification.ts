import { Schema, model, type Document, type Types } from 'mongoose';
import { NOTIFICATION_KINDS, type NotificationKind } from '../utils/constants.js';

export interface NotificationDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Deep-link payload, e.g. `{ screen: 'JobDetail', jobId }`. */
  data: Record<string, unknown>;
  readAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, required: true, maxlength: 500 },
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'notifications' },
);

notificationSchema.index({ employeeId: 1, createdAt: -1 });
notificationSchema.index({ employeeId: 1, readAt: 1 });

export const Notification = model<NotificationDoc>('Notification', notificationSchema);

export interface DeviceDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  employeeId: Types.ObjectId;
  fcmToken: string;
  platform: 'android' | 'ios';
  appVersion: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const deviceSchema = new Schema<DeviceDoc>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    fcmToken: { type: String, required: true },
    platform: { type: String, enum: ['android', 'ios'], required: true },
    appVersion: { type: String, default: null },
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, collection: 'devices' },
);

// A token belongs to one device; re-registering it just moves it to the
// current employee (shared handsets are common in this market).
deviceSchema.index({ fcmToken: 1 }, { unique: true });
deviceSchema.index({ employeeId: 1 });

export const Device = model<DeviceDoc>('Device', deviceSchema);

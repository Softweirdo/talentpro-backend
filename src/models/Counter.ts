import { Schema, model, type Document, type Types } from 'mongoose';

/**
 * Atomic sequence allocator. Employee codes must be gapless-ish and never
 * duplicated, which `findOneAndUpdate($inc)` guarantees and `MAX()+1` does not.
 */
export interface CounterDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  key: string;
  seq: number;
}

const counterSchema = new Schema<CounterDoc>(
  {
    key: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { collection: 'counters', versionKey: false },
);

counterSchema.index({ key: 1 }, { unique: true });

export const Counter = model<CounterDoc>('Counter', counterSchema);

/**
 * Returns a strictly increasing number for `key`, offset so the first value is
 * `startAt` rather than 1 (employee codes read better as EMP-1001 than EMP-1).
 */
export async function nextSequence(key: string, startAt = 1000): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return startAt + doc.seq - 1;
}

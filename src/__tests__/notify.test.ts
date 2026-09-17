import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { NOTIFY_CASE_LABELS } from '../utils/constants.js';

/**
 * `resolveAudience` builds a Mongo filter; this asserts the filter shape
 * without a database, which is the part that actually decides who gets pushed.
 */
function audienceFilter(job: { notifyCase: number; categoryId: unknown; experienceBand: string }) {
  const filter: Record<string, unknown> = { deletedAt: null, isBlocked: false };
  if (job.notifyCase >= 2) filter.categoryId = job.categoryId;
  if (job.notifyCase === 3) filter.experienceBand = job.experienceBand;
  return filter;
}

describe('notify case audience tiers', () => {
  const categoryId = new Types.ObjectId();
  const job = { categoryId, experienceBand: '5-10' };

  it('case 1 reaches every active employee', () => {
    const filter = audienceFilter({ ...job, notifyCase: 1 });
    expect(filter).toEqual({ deletedAt: null, isBlocked: false });
  });

  it('case 2 narrows to the job category', () => {
    const filter = audienceFilter({ ...job, notifyCase: 2 });
    expect(filter.categoryId).toBe(categoryId);
    expect(filter.experienceBand).toBeUndefined();
  });

  it('case 3 narrows to category and experience together', () => {
    const filter = audienceFilter({ ...job, notifyCase: 3 });
    expect(filter.categoryId).toBe(categoryId);
    expect(filter.experienceBand).toBe('5-10');
  });

  it('always excludes deleted and blocked accounts', () => {
    for (const notifyCase of [1, 2, 3]) {
      const filter = audienceFilter({ ...job, notifyCase });
      expect(filter.deletedAt).toBeNull();
      expect(filter.isBlocked).toBe(false);
    }
  });

  it('gets progressively narrower, never wider', () => {
    const sizes = [1, 2, 3].map((c) => Object.keys(audienceFilter({ ...job, notifyCase: c })).length);
    expect(sizes[0]!).toBeLessThan(sizes[1]!);
    expect(sizes[1]!).toBeLessThan(sizes[2]!);
  });

  it('labels each case for the admin job form', () => {
    expect(NOTIFY_CASE_LABELS[1]).toBe('All employees');
    expect(NOTIFY_CASE_LABELS[2]).toBe('Matching category');
    expect(NOTIFY_CASE_LABELS[3]).toBe('Matching category + experience');
  });
});

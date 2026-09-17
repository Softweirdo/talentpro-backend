import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  addDays,
  addMonths,
  daysBetween,
  formatCivilDate,
  formatMonthYear,
  parseMonthYear,
  startOfMonthIst,
  tenureProgress,
  toCivilDate,
  todayIst,
} from '../utils/dates.js';

afterEach(() => vi.useRealTimers());

describe('civil dates in IST', () => {
  it('keeps a late-evening IST timestamp on the same IST day', () => {
    // 23:40 IST on 28 Apr is 18:10 UTC on 28 Apr — same day either way.
    expect(toCivilDate('2026-04-28T18:10:00Z').toISOString()).toBe('2026-04-28T00:00:00.000Z');
  });

  it('rolls a late-UTC timestamp forward to the correct IST day', () => {
    // 20:00 UTC on 28 Apr is 01:30 IST on 29 Apr. Getting this wrong makes
    // every tenure calculation off by one.
    expect(toCivilDate('2026-04-28T20:00:00Z').toISOString()).toBe('2026-04-29T00:00:00.000Z');
  });

  it('treats the IST day boundary as 18:30 UTC', () => {
    expect(toCivilDate('2026-04-28T18:29:59Z').toISOString()).toBe('2026-04-28T00:00:00.000Z');
    expect(toCivilDate('2026-04-28T18:30:00Z').toISOString()).toBe('2026-04-29T00:00:00.000Z');
  });
});

describe('addMonths', () => {
  it('clamps to the end of a shorter month', () => {
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(addMonths(new Date('2026-08-31T00:00:00Z'), 6).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
  });

  it('handles a leap year', () => {
    expect(addMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('crosses a year boundary', () => {
    expect(addMonths(new Date('2025-11-12T00:00:00Z'), 3).toISOString()).toBe(
      '2026-02-12T00:00:00.000Z',
    );
  });
});

describe('tenureProgress', () => {
  it('counts the hire date itself as Day 1', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-04-28T06:00:00Z'));
    const hiredOn = new Date('2026-04-28T00:00:00Z');
    expect(tenureProgress(hiredOn, addMonths(hiredOn, 3))?.day).toBe(1);
  });

  it('reproduces the prototype: hired 28 Apr, Day 14 on 11 May', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-11T06:00:00Z'));
    const hiredOn = new Date('2026-04-28T00:00:00Z');
    const progress = tenureProgress(hiredOn, addMonths(hiredOn, 3));
    expect(progress?.day).toBe(14);
    expect(progress?.isComplete).toBe(false);
  });

  it('marks complete on the due date and stops counting past it', () => {
    const hiredOn = new Date('2026-04-28T00:00:00Z');
    const dueOn = addMonths(hiredOn, 3);

    vi.useFakeTimers().setSystemTime(new Date('2026-07-28T06:00:00Z'));
    expect(tenureProgress(hiredOn, dueOn)?.isComplete).toBe(true);

    // Well past due — the counter must not run beyond the total.
    vi.useFakeTimers().setSystemTime(new Date('2026-12-01T06:00:00Z'));
    const late = tenureProgress(hiredOn, dueOn);
    expect(late?.day).toBe(late?.totalDays);
    expect(late?.daysRemaining).toBe(0);
  });

  it('returns null when the referral has not been hired', () => {
    expect(tenureProgress(null, null)).toBeNull();
    expect(tenureProgress(new Date(), null)).toBeNull();
  });
});

describe('helpers', () => {
  it('formats dates the way the app displays them', () => {
    expect(formatCivilDate(new Date('2026-04-28T00:00:00Z'))).toBe('28 Apr 2026');
    expect(formatMonthYear(new Date('2024-01-01T00:00:00Z'))).toBe('Jan 2024');
    expect(formatCivilDate(null)).toBeNull();
  });

  it('parses the MM/YYYY input the history form uses', () => {
    expect(parseMonthYear('03/2025')?.toISOString()).toBe('2025-03-01T00:00:00.000Z');
    expect(parseMonthYear('3/2025')?.toISOString()).toBe('2025-03-01T00:00:00.000Z');
    expect(parseMonthYear('13/2025')).toBeNull();
    expect(parseMonthYear('March 2025')).toBeNull();
  });

  it('measures whole days in both directions', () => {
    expect(daysBetween(new Date('2026-04-28T00:00:00Z'), new Date('2026-05-11T00:00:00Z'))).toBe(13);
    expect(daysBetween(new Date('2026-05-11T00:00:00Z'), new Date('2026-04-28T00:00:00Z'))).toBe(-13);
  });

  it('snaps to the first of the IST month, which is what employment stints use', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-14T06:00:00Z'));
    expect(startOfMonthIst().toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(addDays(todayIst(), -1).toISOString()).toBe('2026-09-13T00:00:00.000Z');
  });
});

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import { env } from '../config/env.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);

export const TZ = env.TIMEZONE;

/**
 * Date semantics in this system are Indian, not UTC. A hire recorded at
 * 23:40 IST belongs to *that* IST day, not the next UTC one — get this wrong
 * and every tenure calculation is off by one.
 *
 * Convention: "civil dates" (hire date, tenure due date, employment stint
 * boundaries) are stored as UTC-midnight Date objects representing an IST
 * calendar day. `toCivilDate` is the only way such a value should be produced.
 */
export function toCivilDate(input: Date | string | number = new Date()): Date {
  const ist = dayjs(input).tz(TZ);
  return new Date(Date.UTC(ist.year(), ist.month(), ist.date()));
}

/** Today's IST calendar day, as a civil date. */
export const todayIst = (): Date => toCivilDate(new Date());

/** First day of the current IST month — the default for employment stints. */
export function startOfMonthIst(input: Date | string | number = new Date()): Date {
  const ist = dayjs(input).tz(TZ);
  return new Date(Date.UTC(ist.year(), ist.month(), 1));
}

/** Adds whole months, clamping to the end of the target month (31 Jan + 1mo = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const d = dayjs.utc(date).add(months, 'month');
  return new Date(Date.UTC(d.year(), d.month(), d.date()));
}

export function addDays(date: Date, days: number): Date {
  const d = dayjs.utc(date).add(days, 'day');
  return new Date(Date.UTC(d.year(), d.month(), d.date()));
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((toCivilDate(to).getTime() - toCivilDate(from).getTime()) / 86_400_000);
}

/**
 * Tenure progress as the app renders it: "3 mo · Day 14".
 * Day 1 is the hire date itself. Never stored — always computed on read, so it
 * stays correct even if the server was down for a week.
 */
export function tenureProgress(hiredOn: Date | null | undefined, dueOn: Date | null | undefined) {
  if (!hiredOn || !dueOn) return null;
  const today = todayIst();
  const totalDays = daysBetween(hiredOn, dueOn);
  const elapsed = daysBetween(hiredOn, today) + 1;
  return {
    day: Math.max(1, Math.min(elapsed, totalDays)),
    totalDays,
    daysRemaining: Math.max(0, daysBetween(today, dueOn)),
    isComplete: today.getTime() >= dueOn.getTime(),
  };
}

/** "2h ago", "3 days ago" — matches the prototype's relative timestamps. */
export const fromNow = (date: Date): string => dayjs(date).fromNow();

/** "28 Apr 2026" — the display format used throughout the app and admin. */
export const formatCivilDate = (date: Date | null | undefined): string | null =>
  date ? dayjs.utc(date).format('D MMM YYYY') : null;

/** "Jan 2024" — month precision, for employment history periods. */
export const formatMonthYear = (date: Date | null | undefined): string | null =>
  date ? dayjs.utc(date).format('MMM YYYY') : null;

/** Parses the "MM/YYYY" input the employment-history form uses. */
export function parseMonthYear(value: string): Date | null {
  const m = /^(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Start of the IST day/week/month, returned as a real instant for range queries. */
export function istRangeStart(unit: 'day' | 'week' | 'month' | 'year', offset = 0): Date {
  return dayjs().tz(TZ).subtract(offset, unit).startOf(unit).toDate();
}

export function daysAgo(days: number): Date {
  return dayjs().subtract(days, 'day').toDate();
}

export { dayjs };

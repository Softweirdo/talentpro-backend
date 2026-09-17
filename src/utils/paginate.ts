import { Types } from 'mongoose';
import { z } from 'zod';

/** Cursor pagination for the mobile app's infinite-scroll feeds. */
export const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

/** Offset pagination for admin tables, which show page numbers and totals. */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(25),
});

export interface CursorPage<T> {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean };
}

export interface OffsetPage<T> {
  data: T[];
  page: { page: number; perPage: number; total: number; totalPages: number };
}

/**
 * Keyset pagination on `_id`. Monotonic ObjectIds make this a stable ordering
 * that does not skip or repeat rows when documents are inserted mid-scroll,
 * which offset pagination cannot promise.
 */
export function cursorFilter(cursor?: string): Record<string, unknown> {
  if (!cursor || !Types.ObjectId.isValid(cursor)) return {};
  return { _id: { $lt: new Types.ObjectId(cursor) } };
}

export function toCursorPage<T extends { _id: Types.ObjectId }>(
  rows: T[],
  limit: number,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    page: {
      nextCursor: hasMore ? String(data[data.length - 1]?._id) : null,
      hasMore,
    },
  };
}

export function toOffsetPage<T>(rows: T[], total: number, page: number, perPage: number): OffsetPage<T> {
  return {
    data: rows,
    page: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
  };
}

export const skipFor = (page: number, perPage: number): number => (page - 1) * perPage;

/** Escapes user input before it reaches a `$regex`, so a stray `(` cannot 500. */
export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const searchRegex = (value: string): RegExp => new RegExp(escapeRegex(value.trim()), 'i');

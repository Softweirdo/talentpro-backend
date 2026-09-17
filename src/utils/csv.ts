/**
 * Minimal RFC 4180 CSV writer. Values containing a comma, quote or newline are
 * quoted; embedded quotes are doubled.
 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCell(c.header)).join(',');
  const body = rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(','));
  // A BOM makes Excel open UTF-8 (Gujarati names, the ₹ sign) correctly.
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}

export const csvFilename = (entity: string): string =>
  `talentpro-${entity}-${new Date().toISOString().slice(0, 10)}.csv`;

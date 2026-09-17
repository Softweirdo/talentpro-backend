import { describe, expect, it } from 'vitest';
import { toCsv, type CsvColumn } from '../utils/csv.js';

interface Row {
  name: string;
  note?: string;
}

describe('csv writer', () => {
  const cols: CsvColumn<Row>[] = [
    { header: 'Name', value: (r) => r.name },
    { header: 'Note', value: (r) => r.note },
  ];

  it('quotes cells containing a comma, quote or newline', () => {
    const csv = toCsv(
      [
        { name: 'L&T Construction, Surat', note: 'fine' },
        { name: 'He said "yes"', note: 'line1\nline2' },
      ],
      cols,
    );
    expect(csv).toContain('"L&T Construction, Surat"');
    expect(csv).toContain('"He said ""yes"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('leaves null and undefined as empty cells', () => {
    const csv = toCsv([{ name: 'Ramesh', note: undefined }], cols);
    expect(csv.split('\r\n')[1]).toBe('Ramesh,');
  });

  it('starts with a BOM so Excel reads Gujarati and ₹ correctly', () => {
    const csv = toCsv([{ name: 'રમેશ પટેલ', note: '₹2,500' }], cols);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('રમેશ પટેલ');
    // The rupee amount contains a comma, so it must come back quoted.
    expect(csv).toContain('"₹2,500"');
  });

  it('emits a header row even with no data', () => {
    expect(toCsv([], cols)).toBe('﻿Name,Note\r\n');
  });
});

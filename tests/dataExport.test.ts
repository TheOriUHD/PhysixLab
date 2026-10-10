import { describe, expect, it } from 'vitest';
import {
  listDataSources,
  registerDataSource,
  toCSV,
  toJSON,
  toTSV,
  type DataTable,
} from '../src/app/export/dataExport';

const t: DataTable = {
  name: 'Energy, test',
  columns: [
    { key: 't', label: 'Time (s)' },
    { key: 'note', label: 'Note, with "quotes"' },
    { key: 'e', label: 'E (J)' },
  ],
  rows: [
    [0, 'start', 1.5],
    [0.5, 'line\nbreak', 1e-7],
    [1, 'say "hi"', Number.NaN],
    [1.5, ' padded ', null],
  ],
};

describe('table export (DT-3)', () => {
  it('writes RFC 4180 CSV: quoting, doubled quotes, CRLF, empty cells for NaN/null', () => {
    expect(toCSV(t)).toBe(
      [
        'Time (s),"Note, with ""quotes""",E (J)',
        '0,start,1.5',
        '0.5,"line\nbreak",1e-7',
        '1,"say ""hi""",',
        '1.5," padded ",',
        '',
      ].join('\r\n'),
    );
  });
  it('JSON rows are keyed by column key', () => {
    const j = JSON.parse(toJSON(t)) as { rows: Record<string, unknown>[]; columns: unknown[] };
    expect(j.rows[0]).toEqual({ t: 0, note: 'start', e: 1.5 });
    expect(j.rows[3].e).toBeNull();
    expect(j.columns).toHaveLength(3);
  });
  it('TSV has no tabs or newlines inside cells', () => {
    const lines = toTSV(t).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.every((l) => l.split('\t').length === 3)).toBe(true);
  });
  it('sources register once and can be removed', () => {
    const off = registerDataSource({ id: 'test.src', label: 'x', table: () => t });
    expect(listDataSources().some((s) => s.id === 'test.src')).toBe(true);
    expect(() => registerDataSource({ id: 'test.src', label: 'y', table: () => null })).toThrow(/already registered/);
    off();
    expect(listDataSources().some((s) => s.id === 'test.src')).toBe(false);
  });
});

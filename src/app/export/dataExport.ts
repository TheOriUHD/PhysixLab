/**
 * Table export hooks (DT-3). Anything that shows numbers over time or per object (telemetry charts, analysis
 * panels, probes) describes them as a `DataTable` and registers a `DataSource`; the commands and menus in
 * src/ui/extensions/data-export.ts then offer CSV / JSON / clipboard for every source without further wiring.
 *
 *   registerDataSource({ id: 'my.panel', label: 'My panel', table: (app) => ({ name, columns, rows }) });
 */
import type { App } from '../app';

export interface DataColumn {
  /** Machine key (JSON property name). */
  key: string;
  /** Header text for CSV (include the unit: "Speed (m/s)"). */
  label: string;
}

export interface DataTable {
  name: string;
  columns: DataColumn[];
  /** One array per row, same order as `columns`; numbers are written with full precision. */
  rows: (number | string | boolean | null)[][];
}

export interface DataSource {
  id: string;
  label: string;
  /** The current table, or null when there is nothing to export yet. */
  table: (app: App) => DataTable | null;
}

const sources = new Map<string, DataSource>();

export function registerDataSource(s: DataSource): () => void {
  if (sources.has(s.id)) throw new Error(`data source "${s.id}" is already registered`);
  sources.set(s.id, s);
  return () => void sources.delete(s.id);
}

export const listDataSources = (): DataSource[] => [...sources.values()];

function csvCell(v: number | string | boolean | null): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV (CRLF line ends, quotes doubled), with a header row. */
export function toCSV(t: DataTable): string {
  const lines = [t.columns.map((c) => csvCell(c.label)).join(',')];
  for (const r of t.rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** An array of objects keyed by column key. */
export function toJSON(t: DataTable): string {
  const objs = t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c.key, r[i] ?? null])));
  return JSON.stringify({ name: t.name, columns: t.columns, rows: objs }, null, 1);
}

/** Tab-separated text: pastes into spreadsheets as columns. */
export function toTSV(t: DataTable): string {
  const clean = (v: number | string | boolean | null) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
  return [t.columns.map((c) => clean(c.label)).join('\t'), ...t.rows.map((r) => r.map(clean).join('\t'))].join('\n');
}

export type TableFormat = 'csv' | 'json' | 'clipboard';

export function fileSafe(name: string): string {
  return name.replace(/[^\w\- ]+/g, '_').trim() || 'data';
}

/** Download `text` as a file (test hook: `window.__lastDownload` receives `{name, text}` when `window.__e2eDownloads` is set). */
export function saveTextFile(name: string, text: string, mime: string): void {
  const w = window as unknown as { __e2eDownloads?: boolean; __lastDownload?: { name: string; text: string } };
  if (w.__e2eDownloads) {
    w.__lastDownload = { name, text };
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Exports `table` in `format`; resolves with a short message for a toast. */
export async function exportTable(table: DataTable, format: TableFormat): Promise<string> {
  const base = fileSafe(table.name);
  if (format === 'csv') {
    saveTextFile(`${base}.csv`, toCSV(table), 'text/csv');
    return `Saved ${base}.csv (${table.rows.length} rows)`;
  }
  if (format === 'json') {
    saveTextFile(`${base}.json`, toJSON(table), 'application/json');
    return `Saved ${base}.json (${table.rows.length} rows)`;
  }
  await navigator.clipboard.writeText(toTSV(table));
  return `Copied ${table.rows.length} rows — paste into a spreadsheet`;
}

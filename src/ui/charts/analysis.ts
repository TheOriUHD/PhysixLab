/**
 * Derived signals, summary statistics, histograms and CSV formatting for the chart widgets (DOM-free).
 */
import type { MultiSeries } from './series';

export type DerivedOp = 'derivative' | 'integral' | 'rms' | 'min' | 'max' | 'mean';
export const DERIVED_OPS: readonly { id: DerivedOp; label: string; suffix: string; hint: string }[] = [
  {
    id: 'derivative',
    label: 'Derivative d/dt',
    suffix: 'd/dt',
    hint: 'Rate of change per second (backward difference)',
  },
  {
    id: 'integral',
    label: 'Integral ∫dt',
    suffix: '∫dt',
    hint: 'Running integral since the recording started (trapezoid rule)',
  },
  { id: 'rms', label: 'Running RMS', suffix: 'RMS', hint: 'Root mean square of all samples so far (time weighted)' },
  { id: 'min', label: 'Running min', suffix: 'min', hint: 'Smallest value so far' },
  { id: 'max', label: 'Running max', suffix: 'max', hint: 'Largest value so far' },
  { id: 'mean', label: 'Running mean', suffix: 'mean', hint: 'Average of all samples so far (time weighted)' },
];

/** Streaming derived signal: feed (t, v) in order, get the derived value. One instance per derived trace. */
export class DerivedSignal {
  private pt = NaN;
  private pv = NaN;
  private acc = 0; // integral, or integral of v² for rms
  private span = 0;
  private lo = Infinity;
  private hi = -Infinity;
  private last = NaN;
  constructor(readonly op: DerivedOp) {}

  reset(): void {
    this.pt = this.pv = this.last = NaN;
    this.acc = this.span = 0;
    this.lo = Infinity;
    this.hi = -Infinity;
  }

  step(t: number, v: number): number {
    if (Number.isNaN(v)) return this.last;
    const dt = t - this.pt;
    const first = Number.isNaN(this.pt);
    if (!first && dt < 0) this.reset();
    const hasPrev = !Number.isNaN(this.pt) && dt > 1e-12;
    let out: number;
    switch (this.op) {
      case 'derivative':
        out = hasPrev ? (v - this.pv) / dt : this.last;
        if (Number.isNaN(out)) out = 0;
        break;
      case 'integral':
        if (hasPrev) this.acc += 0.5 * (v + this.pv) * dt;
        out = this.acc;
        break;
      case 'rms':
        if (hasPrev) {
          this.acc += 0.5 * (v * v + this.pv * this.pv) * dt;
          this.span += dt;
        }
        out = this.span > 0 ? Math.sqrt(this.acc / this.span) : Math.abs(v);
        break;
      case 'mean':
        if (hasPrev) {
          this.acc += 0.5 * (v + this.pv) * dt;
          this.span += dt;
        }
        out = this.span > 0 ? this.acc / this.span : v;
        break;
      case 'min':
        this.lo = Math.min(this.lo, v);
        out = this.lo;
        break;
      default:
        this.hi = Math.max(this.hi, v);
        out = this.hi;
    }
    if (!hasPrev && !first && dt >= 0 && dt <= 1e-12) {
      /* same instant: keep the previous sample */
    } else {
      this.pt = t;
      this.pv = v;
    }
    this.last = out;
    return out;
  }
}

export interface SummaryStats {
  count: number;
  min: number;
  max: number;
  /** Time-weighted mean (trapezoid). */
  mean: number;
  rms: number;
  /** Sample standard deviation about the (unweighted) mean. */
  std: number;
  first: number;
  last: number;
  /** Mean rate of change over the range, (last - first) / duration. */
  slope: number;
  /** ∫ v dt (trapezoid). */
  integral: number;
}

/** Summary of channel `c` over rows [i0, i1) (NaN rows skipped); null if fewer than one valid row. */
export function summarize(s: MultiSeries, c: number, i0 = 0, i1 = s.length): SummaryStats | null {
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let first = NaN;
  let last = NaN;
  let tFirst = NaN;
  let tLast = NaN;
  let integral = 0;
  let int2 = 0;
  let pt = NaN;
  let pv = NaN;
  for (let i = Math.max(0, i0); i < Math.min(s.length, i1); i++) {
    const v = s.valueAt(c, i);
    if (Number.isNaN(v)) continue;
    const t = s.timeAt(i);
    count++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (Number.isNaN(first)) {
      first = v;
      tFirst = t;
    }
    last = v;
    tLast = t;
    if (!Number.isNaN(pt)) {
      const dt = t - pt;
      integral += 0.5 * (v + pv) * dt;
      int2 += 0.5 * (v * v + pv * pv) * dt;
    }
    pt = t;
    pv = v;
  }
  if (!count) return null;
  const dur = tLast - tFirst;
  const mean0 = sum / count;
  let ss = 0;
  for (let i = Math.max(0, i0); i < Math.min(s.length, i1); i++) {
    const v = s.valueAt(c, i);
    if (!Number.isNaN(v)) ss += (v - mean0) * (v - mean0);
  }
  return {
    count,
    min,
    max,
    mean: dur > 0 ? integral / dur : mean0,
    rms: dur > 0 ? Math.sqrt(int2 / dur) : Math.abs(first),
    std: count > 1 ? Math.sqrt(ss / (count - 1)) : 0,
    first,
    last,
    slope: dur > 0 ? (last - first) / dur : 0,
    integral,
  };
}

export interface Histogram {
  /** Lower edge of the first bin and the bin width. */
  lo: number;
  width: number;
  counts: Uint32Array;
  /** Number of values binned (NaN skipped). */
  total: number;
}

/** Bin channel `c` (rows [i0, i1)) into `bins` equal bins spanning the data range (or `[lo, hi]` if given). */
export function histogram(
  s: MultiSeries,
  c: number,
  bins: number,
  i0 = 0,
  i1 = s.length,
  range?: [number, number],
): Histogram {
  bins = Math.max(1, Math.floor(bins));
  let lo = range ? range[0] : Infinity;
  let hi = range ? range[1] : -Infinity;
  if (!range) {
    for (let i = Math.max(0, i0); i < Math.min(s.length, i1); i++) {
      const v = s.valueAt(c, i);
      if (Number.isNaN(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const counts = new Uint32Array(bins);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, width: 1, counts, total: 0 };
  if (hi - lo < 1e-12) {
    lo -= 0.5;
    hi += 0.5;
  }
  const width = (hi - lo) / bins;
  let total = 0;
  for (let i = Math.max(0, i0); i < Math.min(s.length, i1); i++) {
    const v = s.valueAt(c, i);
    if (Number.isNaN(v) || v < lo || v > hi) continue;
    counts[Math.min(bins - 1, Math.floor((v - lo) / width))]++;
    total++;
  }
  return { lo, width, counts, total };
}

const csvCell = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Number formatting for CSV: shortest round-trip-ish text, empty for NaN. */
const csvNum = (v: number): string => (Number.isNaN(v) ? '' : String(Number(v.toPrecision(9))));

export interface CsvColumn {
  name: string;
  unit: string;
  channel: number;
}

/** CSV of all rows (header `time [s], name [unit], …`; one line per row; `\n` line ends; empty cell for NaN). */
export function toCsv(
  s: MultiSeries,
  cols: readonly CsvColumn[],
  markers: readonly { t: number; text: string }[] = [],
): string {
  const head = ['time [s]', ...cols.map((c) => csvCell(c.unit ? `${c.name} [${c.unit}]` : c.name))];
  if (markers.length) head.push('marker');
  const lines = [head.join(',')];
  const sorted = markers.slice().sort((a, b) => a.t - b.t);
  let m = 0;
  for (let i = 0; i < s.length; i++) {
    const t = s.timeAt(i);
    const row = [csvNum(t)];
    for (const c of cols) row.push(csvNum(s.valueAt(c.channel, i)));
    if (markers.length) {
      // a marker is attached to the first row at or after its time
      const last = i === s.length - 1;
      const texts: string[] = [];
      while (m < sorted.length && (last || sorted[m].t <= t + 1e-9)) {
        texts.push(sorted[m].text);
        m++;
      }
      row.push(csvCell(texts.join(' | ')));
    }
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

/** Axis helpers for the chart canvases (DOM-free). */

/** "Nice" tick values covering [lo, hi] with about `count` intervals (1/2/5 × 10^k steps). */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return Number.isFinite(lo) ? [lo] : [];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
  const out: number[] = [];
  const start = Math.ceil(lo / step - 1e-9) * step;
  for (let v = start; v <= hi + step * 1e-9 && out.length < 50; v += step)
    out.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
  return out;
}

/** Compact number for an axis label. */
export function tickLabel(v: number, step = 0): string {
  const a = Math.abs(v);
  if (v === 0) return '0';
  if (a >= 1e6) return `${+(v / 1e6).toPrecision(3)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toPrecision(3)}k`;
  if (a < 1e-3) return v.toExponential(0);
  if (step > 0) {
    const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
    return v.toFixed(dec);
  }
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
}

/** Value for the legend / cursor read-out: 4 significant digits, no exponent for ordinary magnitudes. */
export function valueText(v: number): string {
  if (Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

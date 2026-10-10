/**
 * Canvas drawing of one chart (time / spectrum / XY / histogram). Pure functions of the model and a view window:
 * the widget owns the canvas, the interaction and the view state; this module only paints and reports the geometry
 * it used (`Layout`) so the widget can map the pointer to data.
 */
import { histogram } from './analysis';
import { findPeaks, formatHz, peakLabel, spectrum } from './fft';
import type { Peak, Spectrum, WindowKind } from './fft';
import type { ChartModel } from './model';
import { niceTicks, tickLabel, valueText } from './ticks';

export interface Theme {
  bg: string;
  grid: string;
  zero: string;
  text: string;
  textStrong: string;
  accent: string;
  font: string;
  fontUi: string;
}

export function readTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    bg: v('--panel', '#12161e'),
    grid: 'rgba(152,165,185,0.13)',
    zero: 'rgba(152,165,185,0.38)',
    text: v('--text-3', '#627086'),
    textStrong: v('--text-2', '#98a5b9'),
    accent: v('--accent', '#3ddcff'),
    font: `10.5px ${v('--mono', 'ui-monospace, Menlo, Consolas, monospace')}`,
    fontUi: `11.5px ${v('--font', 'system-ui, sans-serif')}`,
  };
}

export interface SpecResult {
  spec: Spectrum;
  peaks: Peak[];
  /** The time range the spectrum was computed over. */
  t0: number;
  t1: number;
  trace: number;
}

/** Spectrum of trace `ti` over the recorded rows inside [t0, t1]; null when there is too little data. */
export function computeSpectrum(
  model: ChartModel,
  ti: number,
  t0: number,
  t1: number,
  win: WindowKind,
): SpecResult | null {
  const d = model.data;
  const tr = model.traces[ti];
  if (!tr || d.length < 16) return null;
  const a = Math.max(t0, d.firstTime);
  const b = Math.min(t1, d.lastTime);
  const i0 = d.lowerBound(a);
  const i1 = d.lowerBound(b + 1e-9);
  const rows = i1 - i0;
  if (rows < 16 || !(b > a)) return null;
  let n = 32;
  while (n * 2 <= Math.min(rows, 8192)) n *= 2;
  const grid = new Float64Array(n);
  if (!d.resampleUniform(tr.channel, a, b, grid)) return null;
  for (let i = 0; i < n; i++) if (Number.isNaN(grid[i])) grid[i] = 0;
  const fs = (n - 1) / (b - a);
  const spec = spectrum(grid, fs, { window: win, size: Math.min(16384, n * 2) });
  const peaks = findPeaks(spec, 4, 0.12, spec.df * 3);
  return { spec, peaks, t0: a, t1: b, trace: ti };
}

export interface Hover {
  x: number;
  y: number;
}

export interface Layout {
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  pw: number;
  ph: number;
  t0: number;
  t1: number;
  /** y ranges of the left / right axes */
  lo: [number, number];
  hi: [number, number];
  /** Row under the cursor (time mode), or -1. */
  hoverRow: number;
  /** X range of the spectrum / XY / histogram plots (data units). */
  x0: number;
  x1: number;
  /** Marker x positions (px) from the last time-mode draw. */
  markerX: number[];
}

export const newLayout = (): Layout => ({
  padL: 0,
  padR: 0,
  padT: 0,
  padB: 0,
  pw: 0,
  ph: 0,
  t0: 0,
  t1: 1,
  lo: [0, 1],
  hi: [1, 1],
  hoverRow: -1,
  x0: 0,
  x1: 1,
  markerX: [],
});

export interface DrawInput {
  model: ChartModel;
  /** Visible time window. */
  t0: number;
  t1: number;
  hover: Hover | null;
  theme: Theme;
  spec: SpecResult | null;
  /** Draw the cursor and the markers' hit areas (off for exports). */
  interactive: boolean;
}

const NO_DATA: Record<string, string> = {
  time: 'Press Simulate to record',
  spectrum: 'Needs a running simulation and a trace',
  xy: 'Pick two traces to plot against each other',
  hist: 'Press Simulate to collect values',
};

export function drawChart(g: CanvasRenderingContext2D, W: number, H: number, inp: DrawInput, L: Layout): void {
  const { model, theme } = inp;
  g.fillStyle = theme.bg;
  g.fillRect(0, 0, W, H);
  g.font = theme.font;
  const cfg = model.cfg;
  const hasR = model.traces.some((t) => t.cfg.axis === 'R' && t.cfg.visible);
  L.padL = 46;
  L.padR = cfg.mode === 'time' && hasR ? 46 : 12;
  L.padT = 16;
  L.padB = 20;
  L.pw = Math.max(10, W - L.padL - L.padR);
  L.ph = Math.max(10, H - L.padT - L.padB);
  L.hoverRow = -1;
  if (cfg.mode === 'time') drawTime(g, W, inp, L);
  else if (cfg.mode === 'spectrum') drawSpectrum(g, W, inp, L);
  else if (cfg.mode === 'xy') drawXY(g, W, H, inp, L);
  else drawHist(g, W, inp, L);
}

function message(g: CanvasRenderingContext2D, L: Layout, theme: Theme, text: string): void {
  g.fillStyle = theme.text;
  g.font = theme.fontUi;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, L.padL + L.pw / 2, L.padT + L.ph / 2);
}

function frame(g: CanvasRenderingContext2D, W: number, L: Layout, theme: Theme): void {
  g.strokeStyle = theme.grid;
  g.lineWidth = 1;
  g.strokeRect(L.padL + 0.5, L.padT + 0.5, L.pw, L.ph);
  void W;
}

function yGrid(
  g: CanvasRenderingContext2D,
  L: Layout,
  theme: Theme,
  lo: number,
  hi: number,
  side: 'L' | 'R',
  grid: boolean,
  color?: string,
): void {
  const ticks = niceTicks(lo, hi, Math.max(2, Math.round(L.ph / 34)));
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 0;
  g.textBaseline = 'middle';
  g.textAlign = side === 'L' ? 'right' : 'left';
  for (const v of ticks) {
    const y = Math.round(L.padT + (1 - (v - lo) / (hi - lo)) * L.ph) + 0.5;
    if (grid) {
      g.strokeStyle = v === 0 ? theme.zero : theme.grid;
      g.beginPath();
      g.moveTo(L.padL, y);
      g.lineTo(L.padL + L.pw, y);
      g.stroke();
    }
    g.fillStyle = color ?? theme.text;
    g.fillText(tickLabel(v, step), side === 'L' ? L.padL - 6 : L.padL + L.pw + 6, y);
  }
}

function xGrid(
  g: CanvasRenderingContext2D,
  L: Layout,
  theme: Theme,
  x0: number,
  x1: number,
  fmt: (v: number) => string,
): void {
  const ticks = niceTicks(x0, x1, Math.max(2, Math.round(L.pw / 70)));
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (const v of ticks) {
    const x = Math.round(L.padL + ((v - x0) / (x1 - x0)) * L.pw) + 0.5;
    g.strokeStyle = v === 0 ? theme.zero : theme.grid;
    g.beginPath();
    g.moveTo(x, L.padT);
    g.lineTo(x, L.padT + L.ph);
    g.stroke();
    g.fillStyle = theme.text;
    g.fillText(fmt(v), x, L.padT + L.ph + 5);
  }
}

function unitList(model: ChartModel, axis: 'L' | 'R'): string {
  const u = new Set<string>();
  model.traces.forEach((t, i) => {
    if (t.cfg.axis === axis && t.cfg.visible) u.add(model.unitOf(i));
  });
  return [...u].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------------------------- time

function drawTime(g: CanvasRenderingContext2D, W: number, inp: DrawInput, L: Layout): void {
  const { model, theme, t0, t1 } = inp;
  const d = model.data;
  L.t0 = t0;
  L.t1 = t1;
  const i0 = Math.max(0, d.lowerBound(t0) - 1);
  const i1 = Math.min(d.length, d.lowerBound(t1) + 1);
  // y ranges per axis
  for (let a = 0; a < 2; a++) {
    const axis = a === 0 ? 'L' : 'R';
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of model.traces) {
      if (!t.cfg.visible || t.cfg.axis !== axis) continue;
      for (let i = i0; i < i1; i++) {
        const v = d.valueAt(t.channel, i);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < 1e-9 * Math.max(1, Math.abs(hi))) {
      const c = Math.abs(hi) > 1e-9 ? Math.abs(hi) * 0.1 : 0.5;
      lo -= c;
      hi += c;
    }
    const pad = (hi - lo) * 0.07;
    L.lo[a] = lo - pad;
    L.hi[a] = hi + pad;
  }
  const hasR = model.traces.some((t) => t.cfg.axis === 'R' && t.cfg.visible);
  const X = (t: number) => L.padL + ((t - t0) / (t1 - t0)) * L.pw;
  const Y = (v: number, a: number) => L.padT + (1 - (v - L.lo[a]) / (L.hi[a] - L.lo[a])) * L.ph;

  yGrid(g, L, theme, L.lo[0], L.hi[0], 'L', true);
  if (hasR) yGrid(g, L, theme, L.lo[1], L.hi[1], 'R', false, theme.textStrong);
  xGrid(g, L, theme, t0, t1, (v) => `${+v.toFixed(2)}s`);
  frame(g, W, L, theme);

  // traces
  g.save();
  g.beginPath();
  g.rect(L.padL, L.padT - 1, L.pw, L.ph + 2);
  g.clip();
  g.lineJoin = 'round';
  g.lineWidth = 1.6;
  const span = t1 - t0;
  for (const tr of model.traces) {
    if (!tr.cfg.visible || d.length < 1) continue;
    const a = tr.cfg.axis === 'R' ? 1 : 0;
    g.strokeStyle = tr.cfg.color;
    g.beginPath();
    const n = i1 - i0;
    let pen = false;
    if (n <= L.pw * 2) {
      for (let i = i0; i < i1; i++) {
        const v = d.valueAt(tr.channel, i);
        if (Number.isNaN(v)) {
          pen = false;
          continue;
        }
        const x = X(d.timeAt(i));
        const y = Y(v, a);
        if (pen) g.lineTo(x, y);
        else g.moveTo(x, y);
        pen = true;
      }
    } else {
      // more rows than pixels: keep first / min / max / last of every pixel column so peaks survive
      let col = -1;
      let first = 0,
        last = 0,
        mn = 0,
        mx = 0;
      const flush = () => {
        if (col < 0) return;
        const x = L.padL + col + 0.5;
        const f = Y(first, a),
          lo = Y(mn, a),
          hi = Y(mx, a),
          l = Y(last, a);
        if (pen) g.lineTo(x, f);
        else g.moveTo(x, f);
        g.lineTo(x, lo);
        g.lineTo(x, hi);
        g.lineTo(x, l);
        pen = true;
      };
      for (let i = i0; i < i1; i++) {
        const v = d.valueAt(tr.channel, i);
        if (Number.isNaN(v)) continue;
        const c = Math.floor(((d.timeAt(i) - t0) / span) * L.pw);
        if (c !== col) {
          flush();
          col = c;
          first = mn = mx = v;
        } else {
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        last = v;
      }
      flush();
    }
    g.stroke();
  }
  // markers
  L.markerX.length = 0;
  g.setLineDash([4, 3]);
  g.lineWidth = 1;
  g.font = theme.font;
  g.textAlign = 'left';
  g.textBaseline = 'top';
  for (const m of model.cfg.markers) {
    const x = X(m.t);
    L.markerX.push(x);
    if (x < L.padL - 1 || x > L.padL + L.pw + 1) continue;
    g.strokeStyle = 'rgba(255,179,71,0.85)';
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, L.padT);
    g.lineTo(Math.round(x) + 0.5, L.padT + L.ph);
    g.stroke();
  }
  g.setLineDash([]);
  g.restore();
  g.fillStyle = '#ffb347';
  g.textAlign = 'left';
  g.textBaseline = 'top';
  for (let k = 0; k < model.cfg.markers.length; k++) {
    const x = L.markerX[k];
    if (x < L.padL - 1 || x > L.padL + L.pw + 1) continue;
    g.fillText(model.cfg.markers[k].text, Math.min(x + 4, L.padL + L.pw - 30), L.padT + 2);
  }
  // axis units
  g.fillStyle = theme.textStrong;
  g.textBaseline = 'top';
  g.textAlign = 'left';
  const uL = unitList(model, 'L');
  if (uL) g.fillText(uL, 6, 2);
  if (hasR) {
    const uR = unitList(model, 'R');
    if (uR) {
      g.textAlign = 'right';
      g.fillText(uR, W - 4, 2);
    }
  }
  if (!model.traces.length) message(g, L, theme, 'Add a trace to start plotting');
  else if (d.length < 2) message(g, L, theme, NO_DATA.time);
  // cursor
  if (inp.interactive && inp.hover && d.length) {
    const hx = inp.hover.x;
    if (hx >= L.padL && hx <= L.padL + L.pw) {
      const tt = t0 + ((hx - L.padL) / L.pw) * span;
      const row = d.nearest(tt);
      L.hoverRow = row;
      if (row >= 0) {
        const x = Math.round(X(d.timeAt(row))) + 0.5;
        g.strokeStyle = theme.textStrong;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, L.padT);
        g.lineTo(x, L.padT + L.ph);
        g.stroke();
        const lines: { text: string; color: string }[] = [
          { text: `t = ${d.timeAt(row).toFixed(3)} s`, color: theme.textStrong },
        ];
        model.traces.forEach((tr, ti) => {
          if (!tr.cfg.visible) return;
          const v = d.valueAt(tr.channel, row);
          if (!Number.isNaN(v)) {
            g.fillStyle = tr.cfg.color;
            g.beginPath();
            g.arc(x, Y(v, tr.cfg.axis === 'R' ? 1 : 0), 3, 0, Math.PI * 2);
            g.fill();
          }
          lines.push({
            text: `${model.nameOf(ti)}  ${valueText(v)} ${model.unitOf(ti)}`.trimEnd(),
            color: tr.cfg.color,
          });
        });
        readout(g, L, theme, x, lines);
      }
    }
  }
}

function readout(
  g: CanvasRenderingContext2D,
  L: Layout,
  theme: Theme,
  x: number,
  lines: { text: string; color: string }[],
): void {
  g.font = theme.font;
  let w = 0;
  for (const l of lines) w = Math.max(w, g.measureText(l.text).width);
  w += 16;
  const lh = 14;
  const h = lines.length * lh + 8;
  let bx = x + 10;
  if (bx + w > L.padL + L.pw) bx = x - 10 - w;
  bx = Math.max(L.padL + 2, bx);
  const by = L.padT + 18;
  g.fillStyle = 'rgba(8,10,15,0.88)';
  g.strokeStyle = 'rgba(152,165,185,0.3)';
  g.lineWidth = 1;
  g.beginPath();
  g.roundRect(bx, by, w, Math.min(h, L.ph - 20), 5);
  g.fill();
  g.stroke();
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  lines.forEach((l, i) => {
    if (by + 4 + (i + 1) * lh > L.padT + L.ph) return;
    g.fillStyle = l.color;
    g.fillText(l.text, bx + 8, by + 4 + i * lh + lh / 2);
  });
}

// ---------------------------------------------------------------------------------------------- spectrum

function drawSpectrum(g: CanvasRenderingContext2D, W: number, inp: DrawInput, L: Layout): void {
  const { model, theme, spec: sr } = inp;
  const cfg = model.cfg;
  frame(g, W, L, theme);
  if (!sr) {
    xGrid(g, L, theme, 0, 1, () => '');
    message(g, L, theme, cfg.traces.length ? 'Collecting samples… (needs about 1 s of data)' : NO_DATA.spectrum);
    return;
  }
  const { spec, peaks } = sr;
  const color = model.traces[sr.trace]?.cfg.color ?? theme.accent;
  const unit = model.unitOf(sr.trace);
  const fmax = spec.fs / 2;
  L.x0 = 0;
  L.x1 = fmax;
  let top = 0;
  for (let k = 1; k < spec.mag.length; k++) top = Math.max(top, spec.mag[k]);
  if (top <= 0) top = 1;
  const db = cfg.spectrum.log;
  const floorDb = -90;
  const lo = db ? floorDb : 0;
  const hi = db ? 20 * Math.log10(top) + 6 : top * 1.12;
  const lowDb = Math.max(floorDb, hi - 90);
  const ylo = db ? lowDb : lo;
  const yv = (m: number) => (db ? Math.max(ylo, 20 * Math.log10(Math.max(m, 1e-12))) : m);
  const X = (f: number) => L.padL + (f / fmax) * L.pw;
  const Y = (v: number) => L.padT + (1 - (v - ylo) / (hi - ylo)) * L.ph;
  yGrid(g, L, theme, ylo, hi, 'L', true);
  xGrid(g, L, theme, 0, fmax, (v) => `${+v.toFixed(2)}`);
  frame(g, W, L, theme);
  g.save();
  g.beginPath();
  g.rect(L.padL, L.padT - 1, L.pw, L.ph + 2);
  g.clip();
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.beginPath();
  const bins = spec.mag.length;
  let col = -1;
  let mx = -Infinity;
  let started = false;
  const colFlush = () => {
    if (col < 0) return;
    const x = L.padL + col + 0.5;
    if (started) g.lineTo(x, Y(mx));
    else g.moveTo(x, Y(mx));
    started = true;
  };
  if (bins <= L.pw * 1.5) {
    for (let k = 0; k < bins; k++) {
      const x = X(spec.freq[k]);
      const y = Y(yv(spec.mag[k]));
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  } else {
    for (let k = 0; k < bins; k++) {
      const c = Math.floor((spec.freq[k] / fmax) * (L.pw - 1));
      if (c !== col) {
        colFlush();
        col = c;
        mx = yv(spec.mag[k]);
      } else mx = Math.max(mx, yv(spec.mag[k]));
    }
    colFlush();
  }
  g.stroke();
  g.lineTo(X(spec.freq[bins - 1]), Y(ylo));
  g.lineTo(X(0), Y(ylo));
  g.globalAlpha = 0.12;
  g.fillStyle = color;
  g.fill();
  g.globalAlpha = 1;
  g.restore();
  // peak labels
  g.font = theme.font;
  g.textBaseline = 'bottom';
  const placed: number[] = [];
  for (const p of peaks) {
    const x = X(p.freq);
    const y = Y(yv(p.mag));
    g.fillStyle = '#ffb347';
    g.beginPath();
    g.arc(x, y, 3, 0, Math.PI * 2);
    g.fill();
    const label = peakLabel(p);
    const w = g.measureText(label).width;
    let tx = Math.min(x - w / 2, L.padL + L.pw - w - 2);
    tx = Math.max(L.padL + 2, tx);
    let ty = Math.max(L.padT + 12, y - 6);
    while (placed.some((o) => Math.abs(o - ty) < 13) && ty < L.padT + L.ph - 4) ty += 13;
    placed.push(ty);
    g.fillStyle = 'rgba(8,10,15,0.7)';
    g.fillRect(tx - 2, ty - 12, w + 4, 13);
    g.fillStyle = '#ffb347';
    g.textAlign = 'left';
    g.fillText(label, tx, ty);
  }
  g.fillStyle = theme.textStrong;
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.fillText(`${db ? 'dB' : unit || 'amplitude'} · ${model.nameOf(sr.trace)}  ·  Hz`, 6, 2);
  // cursor
  if (inp.interactive && inp.hover && inp.hover.x >= L.padL && inp.hover.x <= L.padL + L.pw) {
    const f = ((inp.hover.x - L.padL) / L.pw) * fmax;
    const k = Math.min(bins - 1, Math.max(0, Math.round(f / spec.df)));
    const x = Math.round(X(spec.freq[k])) + 0.5;
    g.strokeStyle = theme.textStrong;
    g.beginPath();
    g.moveTo(x, L.padT);
    g.lineTo(x, L.padT + L.ph);
    g.stroke();
    readout(g, L, theme, x, [
      { text: formatHz(spec.freq[k]), color: theme.textStrong },
      { text: db ? `${yv(spec.mag[k]).toFixed(1)} dB` : `${valueText(spec.mag[k])} ${unit}`.trimEnd(), color },
    ]);
  }
}

// ---------------------------------------------------------------------------------------------- XY

function drawXY(g: CanvasRenderingContext2D, W: number, H: number, inp: DrawInput, L: Layout): void {
  const { model, theme, t0, t1 } = inp;
  const cfg = model.cfg;
  const d = model.data;
  const xi = model.traceIndex(cfg.xy.x, 0);
  const yi = model.traceIndex(cfg.xy.y, 1);
  frame(g, W, L, theme);
  if (xi < 0 || yi < 0 || d.length < 2) {
    xGrid(g, L, theme, 0, 1, () => '');
    message(g, L, theme, xi < 0 || yi < 0 ? NO_DATA.xy : 'Press Simulate to record');
    return;
  }
  const cx = model.traces[xi].channel;
  const cy = model.traces[yi].channel;
  const i0 = Math.max(0, d.lowerBound(t0));
  const i1 = Math.min(d.length, d.lowerBound(t1) + 1);
  let xlo = Infinity,
    xhi = -Infinity,
    ylo = Infinity,
    yhi = -Infinity;
  for (let i = i0; i < i1; i++) {
    const x = d.valueAt(cx, i),
      y = d.valueAt(cy, i);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    xlo = Math.min(xlo, x);
    xhi = Math.max(xhi, x);
    ylo = Math.min(ylo, y);
    yhi = Math.max(yhi, y);
  }
  if (!Number.isFinite(xlo)) {
    message(g, L, theme, 'No data in the visible time range');
    return;
  }
  const widen = (lo: number, hi: number): [number, number] => {
    if (hi - lo < 1e-9) {
      const c = Math.abs(hi) > 1e-9 ? Math.abs(hi) * 0.1 : 0.5;
      lo -= c;
      hi += c;
    }
    const p = (hi - lo) * 0.07;
    return [lo - p, hi + p];
  };
  [xlo, xhi] = widen(xlo, xhi);
  [ylo, yhi] = widen(ylo, yhi);
  L.x0 = xlo;
  L.x1 = xhi;
  L.lo[0] = ylo;
  L.hi[0] = yhi;
  yGrid(g, L, theme, ylo, yhi, 'L', true);
  xGrid(g, L, theme, xlo, xhi, (v) => tickLabel(v));
  frame(g, W, L, theme);
  const X = (v: number) => L.padL + ((v - xlo) / (xhi - xlo)) * L.pw;
  const Y = (v: number) => L.padT + (1 - (v - ylo) / (yhi - ylo)) * L.ph;
  g.save();
  g.beginPath();
  g.rect(L.padL, L.padT - 1, L.pw, L.ph + 2);
  g.clip();
  g.lineWidth = 1.4;
  g.lineJoin = 'round';
  const chunks = 4;
  const per = Math.max(1, Math.ceil((i1 - i0) / chunks));
  g.strokeStyle = model.traces[yi].cfg.color;
  for (let c = 0; c < chunks; c++) {
    g.globalAlpha = 0.25 + (0.75 * (c + 1)) / chunks;
    g.beginPath();
    let pen = false;
    const s = i0 + c * per;
    for (let i = Math.max(i0, s - 1); i < Math.min(i1, s + per); i++) {
      const x = d.valueAt(cx, i),
        y = d.valueAt(cy, i);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        pen = false;
        continue;
      }
      if (pen) g.lineTo(X(x), Y(y));
      else g.moveTo(X(x), Y(y));
      pen = true;
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  const lx = d.valueAt(cx, i1 - 1),
    ly = d.valueAt(cy, i1 - 1);
  if (!Number.isNaN(lx) && !Number.isNaN(ly)) {
    g.fillStyle = '#e8eefc';
    g.beginPath();
    g.arc(X(lx), Y(ly), 3.5, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  g.fillStyle = theme.textStrong;
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.fillText(`${model.nameOf(yi)} ${model.unitOf(yi) ? `[${model.unitOf(yi)}]` : ''}`, 6, 2);
  g.textAlign = 'right';
  g.fillText(`${model.nameOf(xi)} ${model.unitOf(xi) ? `[${model.unitOf(xi)}]` : ''}`, W - 4, H - 14);
  if (inp.interactive && inp.hover && inp.hover.x >= L.padL && inp.hover.x <= L.padL + L.pw) {
    const hx = xlo + ((inp.hover.x - L.padL) / L.pw) * (xhi - xlo);
    const hy = ylo + (1 - (inp.hover.y - L.padT) / L.ph) * (yhi - ylo);
    readout(g, L, theme, inp.hover.x, [
      { text: `x = ${valueText(hx)} ${model.unitOf(xi)}`.trimEnd(), color: theme.textStrong },
      { text: `y = ${valueText(hy)} ${model.unitOf(yi)}`.trimEnd(), color: model.traces[yi].cfg.color },
    ]);
  }
}

// ---------------------------------------------------------------------------------------------- histogram

function drawHist(g: CanvasRenderingContext2D, W: number, inp: DrawInput, L: Layout): void {
  const { model, theme, t0, t1 } = inp;
  const cfg = model.cfg;
  const d = model.data;
  const ti = model.traceIndex(cfg.hist.trace, 0);
  frame(g, W, L, theme);
  if (ti < 0 || d.length < 2) {
    xGrid(g, L, theme, 0, 1, () => '');
    message(g, L, theme, ti < 0 ? 'Pick a trace to bin' : NO_DATA.hist);
    return;
  }
  const i0 = Math.max(0, d.lowerBound(t0));
  const i1 = Math.min(d.length, d.lowerBound(t1) + 1);
  const hs = histogram(d, model.traces[ti].channel, cfg.hist.bins, i0, i1);
  if (!hs.total) {
    message(g, L, theme, 'No data in the visible time range');
    return;
  }
  const x0 = hs.lo;
  const x1 = hs.lo + hs.width * hs.counts.length;
  L.x0 = x0;
  L.x1 = x1;
  let top = 1;
  for (const c of hs.counts) top = Math.max(top, c);
  yGrid(g, L, theme, 0, top * 1.1, 'L', true);
  xGrid(g, L, theme, x0, x1, (v) => tickLabel(v));
  frame(g, W, L, theme);
  const color = model.traces[ti].cfg.color;
  const bw = L.pw / hs.counts.length;
  let hoverBin = -1;
  if (inp.interactive && inp.hover && inp.hover.x >= L.padL && inp.hover.x <= L.padL + L.pw)
    hoverBin = Math.min(hs.counts.length - 1, Math.floor((inp.hover.x - L.padL) / bw));
  for (let k = 0; k < hs.counts.length; k++) {
    const hgt = (hs.counts[k] / (top * 1.1)) * L.ph;
    g.fillStyle = color;
    g.globalAlpha = k === hoverBin ? 0.95 : 0.7;
    g.fillRect(L.padL + k * bw + 1, L.padT + L.ph - hgt, Math.max(1, bw - 2), hgt);
  }
  g.globalAlpha = 1;
  g.fillStyle = theme.textStrong;
  g.textAlign = 'left';
  g.textBaseline = 'top';
  const u = model.unitOf(ti);
  g.fillText(`count · ${model.nameOf(ti)}${u ? ` [${u}]` : ''}  ·  ${hs.total} samples`, 6, 2);
  if (hoverBin >= 0) {
    const lo = hs.lo + hoverBin * hs.width;
    readout(g, L, theme, L.padL + (hoverBin + 0.5) * bw, [
      { text: `${valueText(lo)} … ${valueText(lo + hs.width)} ${u}`.trimEnd(), color: theme.textStrong },
      { text: `${hs.counts[hoverBin]} samples (${((100 * hs.counts[hoverBin]) / hs.total).toFixed(1)} %)`, color },
    ]);
  }
}

/**
 * Chart configuration (what is persisted), its sanitiser, and the runtime `ChartModel` that owns the recorded data
 * of one chart and samples its traces (DOM-free).
 */
import { DERIVED_OPS, DerivedSignal } from './analysis';
import type { DerivedOp } from './analysis';
import { compile } from './expr';
import type { WindowKind } from './fft';
import { WINDOWS } from './fft';
import { MultiSeries } from './series';
import { exprHost, signalDef } from './signals';
import type { SignalSource } from './signals';

export type ChartMode = 'time' | 'spectrum' | 'xy' | 'hist';
export const CHART_MODES: readonly { id: ChartMode; label: string; title: string }[] = [
  { id: 'time', label: 'Time', title: 'Traces against time' },
  { id: 'spectrum', label: 'Spectrum', title: 'Frequency content (FFT) of one trace' },
  { id: 'xy', label: 'XY', title: 'One trace against another (phase plot)' },
  { id: 'hist', label: 'Hist', title: 'Distribution of the values of one trace' },
];

export interface TraceCfg {
  id: string;
  label: string;
  /** Expression over the signal catalogue, e.g. `speed(Crate)` or `0.5*mass(a)*speed(a)^2`. Empty for derived traces. */
  expr: string;
  color: string;
  unit: string;
  axis: 'L' | 'R';
  visible: boolean;
  /** A trace computed from another trace of the same chart. */
  derived?: { op: DerivedOp; of: string };
}

export interface Marker {
  t: number;
  text: string;
}

export interface ChartCfg {
  id: string;
  title: string;
  mode: ChartMode;
  traces: TraceCfg[];
  /** Visible time span, seconds. */
  span: number;
  follow: boolean;
  /** Seconds of history kept. */
  recordLen: number;
  /** Rows recorded per simulated second at most. */
  sampleHz: number;
  markers: Marker[];
  spectrum: { trace: string; window: WindowKind; log: boolean };
  xy: { x: string; y: string };
  hist: { trace: string; bins: number };
  stats: boolean;
  /** Widget size in px; `h` 0 = fill the dock. */
  w: number;
  h: number;
}

export const PALETTE = [
  '#3ddcff',
  '#ffb347',
  '#b18cff',
  '#ff6b9a',
  '#5be3a1',
  '#ffd166',
  '#7aa2ff',
  '#e8eefc',
] as const;
export const RECORD_LENGTHS = [10, 30, 60, 120, 300, 600] as const;
export const SPANS = [2, 5, 10, 15, 30, 60, 120] as const;
export const MAX_CHARTS = 12;
export const MAX_TRACES = 12;
export const MAX_MARKERS = 200;

let idCounter = 0;
export const newId = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export function defaultChart(title = 'Chart'): ChartCfg {
  return {
    id: newId('c'),
    title,
    mode: 'time',
    traces: [],
    span: 15,
    follow: true,
    recordLen: 120,
    sampleHz: 60,
    markers: [],
    spectrum: { trace: '', window: 'hann', log: false },
    xy: { x: '', y: '' },
    hist: { trace: '', bins: 20 },
    stats: false,
    w: 500,
    h: 0,
  };
}

export function nextColor(traces: readonly TraceCfg[]): string {
  const used = new Set(traces.map((t) => t.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[traces.length % PALETTE.length];
}

const str = (v: unknown, d: string, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : d);
const num = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

/** Sanitise one persisted chart (anything may be in localStorage). */
export function sanitizeChart(raw: unknown): ChartCfg | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = defaultChart();
  const traces: TraceCfg[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(r.traces) ? r.traces.slice(0, MAX_TRACES) : []) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const id = str(o.id, '', 40);
    if (!id || seen.has(id)) continue;
    let derived: TraceCfg['derived'];
    if (o.derived && typeof o.derived === 'object') {
      const dd = o.derived as Record<string, unknown>;
      const op = oneOf(
        dd.op,
        DERIVED_OPS.map((x) => x.id),
        'derivative',
      );
      const of = str(dd.of, '', 40);
      if (of && seen.has(of)) derived = { op, of }; // must refer to an earlier trace
    }
    const expr = str(o.expr, '', 300);
    if (!derived && !expr.trim()) continue;
    seen.add(id);
    traces.push({
      id,
      label: str(o.label, '', 80),
      expr,
      color: /^#[0-9a-fA-F]{6}$/.test(str(o.color, '')) ? str(o.color, '') : PALETTE[traces.length % PALETTE.length],
      unit: str(o.unit, '', 20),
      axis: o.axis === 'R' ? 'R' : 'L',
      visible: o.visible !== false,
      derived,
    });
  }
  const ids = new Set(traces.map((t) => t.id));
  const pick = (v: unknown) => (typeof v === 'string' && ids.has(v) ? v : '');
  const sp = (r.spectrum && typeof r.spectrum === 'object' ? r.spectrum : {}) as Record<string, unknown>;
  const xy = (r.xy && typeof r.xy === 'object' ? r.xy : {}) as Record<string, unknown>;
  const hi = (r.hist && typeof r.hist === 'object' ? r.hist : {}) as Record<string, unknown>;
  const markers: Marker[] = [];
  for (const m of Array.isArray(r.markers) ? r.markers.slice(0, MAX_MARKERS) : []) {
    const o = (m ?? {}) as Record<string, unknown>;
    if (typeof o.t === 'number' && Number.isFinite(o.t)) markers.push({ t: o.t, text: str(o.text, '', 120) });
  }
  return {
    id: str(r.id, d.id, 40) || d.id,
    title: str(r.title, 'Chart', 60),
    mode: oneOf(
      r.mode,
      CHART_MODES.map((m) => m.id),
      'time',
    ),
    traces,
    span: num(r.span, d.span, 0.5, 3600),
    follow: r.follow !== false,
    recordLen: num(r.recordLen, d.recordLen, 5, 3600),
    sampleHz: num(r.sampleHz, d.sampleHz, 5, 120),
    markers,
    spectrum: {
      trace: pick(sp.trace),
      window: oneOf(
        sp.window,
        WINDOWS.map((w) => w.id),
        'hann',
      ),
      log: sp.log === true,
    },
    xy: { x: pick(xy.x), y: pick(xy.y) },
    hist: { trace: pick(hi.trace), bins: Math.round(num(hi.bins, 20, 3, 200)) },
    stats: r.stats === true,
    w: Math.round(num(r.w, d.w, 240, 1600)),
    h: r.h === 0 ? 0 : Math.round(num(r.h, 0, 140, 900)),
  };
}

/** Runtime state of one trace. */
export interface TraceRt {
  cfg: TraceCfg;
  channel: number;
  /** null when the expression does not compile (see `error`) or for a derived trace. */
  eval: (() => number) | null;
  error: string;
  derived: DerivedSignal | null;
  /** Index (into the model's traces) of the source of a derived trace, or -1. */
  source: number;
  usesSelected: boolean;
  usesContacts: boolean;
}

/** Everything one chart records. The view state (zoom, hover) lives in the widget. */
export class ChartModel {
  readonly data: MultiSeries;
  traces: TraceRt[] = [];
  private src: SignalSource | null = null;

  constructor(public cfg: ChartCfg) {
    this.data = new MultiSeries(Math.ceil(cfg.recordLen * cfg.sampleHz), 1 / cfg.sampleHz);
  }

  /** Apply `recordLen` / `sampleHz` from the config to the buffer. */
  applyRecording(): void {
    this.data.minDt = 1 / this.cfg.sampleHz;
    this.data.resize(Math.ceil(this.cfg.recordLen * this.cfg.sampleHz));
  }

  /** (Re)build the runtime traces from the config. Existing data is kept for traces that keep their channel. */
  bind(src: SignalSource): void {
    this.src = src;
    // Channels follow the config order: rebuild the buffer's channel list only when the trace set changed.
    if (
      this.traces.length !== this.cfg.traces.length ||
      this.traces.some((t, i) => t.cfg.id !== this.cfg.traces[i].id)
    ) {
      const old = this.traces;
      const oldData = old.map((t, i) => ({ id: t.cfg.id, i }));
      // Remove channels of traces that are gone (from the end so indices stay valid).
      for (let i = old.length - 1; i >= 0; i--)
        if (!this.cfg.traces.some((c) => c.id === old[i].cfg.id)) this.data.removeChannel(i);
      const kept = oldData.filter((o) => this.cfg.traces.some((c) => c.id === o.id));
      const order = new Map(kept.map((o, i) => [o.id, i]));
      // Existing channels keep their relative order; a config reorder is not supported, new traces are appended.
      this.traces = [];
      for (const c of this.cfg.traces) {
        const prev = old.find((t) => t.cfg.id === c.id);
        if (prev) {
          // a trace that was already there keeps its compiled getter and running state (derivative, integral …)
          prev.channel = order.get(c.id) as number;
          const changed = prev.cfg.expr !== c.expr || prev.cfg.derived?.op !== c.derived?.op || !!prev.error;
          prev.cfg = c;
          if (changed) this.compileInto(prev, c);
          this.traces.push(prev);
        } else this.traces.push(this.makeRt(c, this.data.addChannel()));
      }
    } else {
      this.traces.forEach((t, i) => this.compileInto(t, this.cfg.traces[i]));
    }
    this.traces.forEach((t) => {
      t.source = t.cfg.derived ? this.traces.findIndex((o) => o.cfg.id === t.cfg.derived?.of) : -1;
    });
  }

  private makeRt(cfg: TraceCfg, channel: number): TraceRt {
    const t: TraceRt = {
      cfg,
      channel,
      eval: null,
      error: '',
      derived: null,
      source: -1,
      usesSelected: false,
      usesContacts: false,
    };
    this.compileInto(t, cfg);
    return t;
  }

  private compileInto(t: TraceRt, cfg: TraceCfg): void {
    t.cfg = cfg;
    t.eval = null;
    t.error = '';
    t.usesSelected = false;
    t.usesContacts = false;
    if (cfg.derived) {
      if (!t.derived || t.derived.op !== cfg.derived.op) t.derived = new DerivedSignal(cfg.derived.op);
      return;
    }
    t.derived = null;
    if (!this.src) return;
    try {
      const c = compile(cfg.expr, exprHost(this.src));
      t.eval = c.eval;
      t.usesSelected = c.refs.some((r) => r === 'selected' || r === 'sel');
      t.usesContacts = c.signals.some((s) => s === 'contacts' || s === 'contact_force');
    } catch (e) {
      t.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Recompile one trace after its config changed. */
  recompile(i: number): void {
    const t = this.traces[i];
    if (t) this.compileInto(t, this.cfg.traces[i]);
  }

  /** Recompile the traces that follow the selection. Returns true if any did. */
  rebindSelected(): boolean {
    let any = false;
    this.traces.forEach((t, i) => {
      if (t.usesSelected || t.error) {
        this.compileInto(t, this.cfg.traces[i]);
        any = true;
      }
    });
    return any;
  }

  /** Index of the trace with config id `id`, or `fallback` (when such a trace exists), or -1. */
  traceIndex(id: string, fallback: number): number {
    const i = this.traces.findIndex((t) => t.cfg.id === id);
    return i >= 0 ? i : fallback < this.traces.length ? fallback : -1;
  }

  get needsContacts(): boolean {
    return this.traces.some((t) => t.usesContacts);
  }

  /** Record one row at simulation time `t`. Returns false if the sample was decimated away. Allocation-free. */
  sample(t: number): boolean {
    const d = this.data;
    if (t < d.lastTime) this.clear(); // the clock went backwards: a new run
    if (!d.accept(t)) return false;
    const row = d.beginRow(t);
    const traces = this.traces;
    for (let i = 0; i < traces.length; i++) {
      const tr = traces[i];
      let v = NaN;
      if (tr.derived) {
        if (tr.source >= 0) v = tr.derived.step(t, d.valueAt(traces[tr.source].channel, row));
      } else if (tr.eval) v = tr.eval();
      d.set(tr.channel, row, v);
    }
    return true;
  }

  clear(): void {
    this.data.clear();
    for (const t of this.traces) t.derived?.reset();
    this.cfg.markers = [];
  }

  /** Unit shown for a trace (derived traces transform their source's unit). */
  unitOf(i: number): string {
    const t = this.traces[i];
    if (!t) return '';
    if (t.cfg.unit) return t.cfg.unit;
    if (!t.cfg.derived) {
      const m = /^\s*([A-Za-z_]\w*)\s*\(/.exec(t.cfg.expr);
      const def = m && /^\s*\w+\s*\([^()]*\)\s*$/.test(t.cfg.expr) ? signalDef(m[1]) : undefined;
      return def?.unit ?? '';
    }
    const src = this.unitOf(t.source);
    switch (t.cfg.derived.op) {
      case 'derivative':
        return src ? `${src}/s` : '1/s';
      case 'integral':
        return src ? `${src}·s` : 's';
      default:
        return src;
    }
  }

  /** Display name of a trace. */
  nameOf(i: number): string {
    const t = this.traces[i];
    if (!t) return '';
    if (t.cfg.label) return t.cfg.label;
    if (t.cfg.derived) {
      const sfx = DERIVED_OPS.find((o) => o.id === t.cfg.derived?.op)?.suffix ?? '';
      return `${this.nameOf(t.source)} ${sfx}`;
    }
    return t.cfg.expr;
  }
}

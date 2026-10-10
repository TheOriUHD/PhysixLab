/**
 * One chart widget: header (title, view mode, actions), the plot canvas with its pointer interaction (wheel zoom,
 * drag pan, hover cursor, click markers), the optional statistics table and the trace legend.
 *
 * Drawing is throttled to ~30 Hz, skipped while the widget is off screen, sized with a ResizeObserver and scaled by
 * devicePixelRatio. Sampling never touches the DOM (see `ChartModel.sample`).
 */
import { h } from '../dom';
import { segmented } from '../controls';
import { icon } from '../icons';
import { openMenu } from '../menu';
import type { MenuItem } from '../menu';
import { promptText } from '../modal';
import { DERIVED_OPS, summarize, toCsv } from './analysis';
import type { DerivedOp } from './analysis';
import { WINDOWS } from './fft';
import type { WindowKind } from './fft';
import { CHART_MODES, MAX_MARKERS, MAX_TRACES, RECORD_LENGTHS, SPANS, newId, nextColor } from './model';
import type { ChartCfg, ChartMode, ChartModel } from './model';
import { computeSpectrum, drawChart, newLayout, readTheme } from './render';
import type { Hover, SpecResult, Theme } from './render';
import { valueText } from './ticks';

export interface WidgetHost {
  /** Persist the configuration of all charts (debounced by the host). */
  save(): void;
  remove(w: ChartWidget): void;
  duplicate(w: ChartWidget): void;
  move(w: ChartWidget, dir: -1 | 1): void;
  reorder(dragId: string, targetId: string, after: boolean): void;
  /** Open the trace picker / editor; `index` edits an existing trace. */
  pickTrace(w: ChartWidget, index?: number): void;
  /** The recording settings changed (capacity, rate). */
  recordingChanged(w: ChartWidget): void;
  /** Called after traces were added / removed so the host can rebind and re-evaluate what the charts need. */
  tracesChanged(w: ChartWidget): void;
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const slug = (s: string) => s.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'chart';

const FRAME_MS = 33;

export class ChartWidget {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly plot: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly titleBtn: HTMLButtonElement;
  private readonly liveBtn: HTMLButtonElement;
  private readonly statsBtn: HTMLButtonElement;
  private readonly modeSeg: ReturnType<typeof segmented<ChartMode>>;
  private readonly ro: ResizeObserver;
  private readonly io: IntersectionObserver;
  private visible = true;
  private raf = 0;
  private lastDraw = 0;
  private lastStats = 0;
  private theme: Theme | null = null;
  private themeAt = 0;
  private hover: Hover | null = null;
  private spec: SpecResult | null = null;
  private specKey = '';
  private specAt = 0;
  private readonly layout = newLayout();
  /** Left edge of the visible window while paused (follow off). */
  private viewT0 = 0;
  private chips: { row: HTMLElement; sw: HTMLElement; name: HTMLElement; val: HTMLElement; axis: HTMLElement }[] = [];
  private chipKey = '';
  private subKey = '';
  private statsKey = '';
  private disposed = false;

  constructor(
    readonly model: ChartModel,
    private readonly host: WidgetHost,
  ) {
    const cfg = model.cfg;
    this.canvas = h('canvas', { class: 'ch-canvas', tabindex: 0, 'aria-label': 'Chart' });
    this.plot = h('div', { class: 'ch-plot' }, this.canvas);
    this.legend = h('div', { class: 'ch-legend' });
    this.statsEl = h('div', { class: 'ch-stats' });
    this.sub = h('div', { class: 'ch-sub' });
    this.titleBtn = h('button', { class: 'ch-title', type: 'button', title: 'Click to rename' }, cfg.title);
    this.titleBtn.addEventListener('click', () => void this.rename());
    const grip = h('span', { class: 'ch-grip', title: 'Drag to reorder', draggable: true }, icon('move'));
    this.modeSeg = segmented<ChartMode>({
      options: CHART_MODES.map((m) => ({ value: m.id, label: m.label, title: m.title })),
      value: cfg.mode,
      compact: true,
      onChange: (m) => this.setMode(m),
    });
    this.modeSeg.el.classList.add('ch-modes');
    const addBtn = h(
      'button',
      { class: 'ch-btn ch-add', type: 'button', title: 'Add a trace (signal picker or expression)' },
      icon('plus'),
      h('span', null, 'Trace'),
    );
    addBtn.addEventListener('click', () => this.host.pickTrace(this));
    this.liveBtn = h('button', { class: 'ch-btn ch-live', type: 'button' });
    this.liveBtn.addEventListener('click', () => this.setFollow(!cfg.follow));
    this.statsBtn = h(
      'button',
      {
        class: 'ch-btn ch-sigma',
        type: 'button',
        title: 'Summary statistics of the visible range: min, max, mean, RMS, slope, integral',
      },
      'Σ',
    );
    this.statsBtn.addEventListener('click', () => {
      cfg.stats = !cfg.stats;
      this.layoutChanged();
      this.host.save();
    });
    const exportBtn = h(
      'button',
      { class: 'ch-btn', type: 'button', title: 'Export this chart as PNG or CSV' },
      icon('download'),
    );
    exportBtn.addEventListener('click', () => this.exportMenu(exportBtn));
    const moreBtn = h('button', { class: 'ch-btn ch-more', type: 'button', title: 'Chart options' }, '⋯');
    moreBtn.addEventListener('click', () => this.optionsMenu(moreBtn));
    const head = h(
      'div',
      { class: 'ch-head' },
      grip,
      this.titleBtn,
      this.modeSeg.el,
      h('span', { class: 'ch-spacer' }),
      addBtn,
      this.liveBtn,
      this.statsBtn,
      exportBtn,
      moreBtn,
    );
    const resizer = h('div', { class: 'ch-resize', title: 'Drag to resize' });
    this.el = h(
      'section',
      { class: 'ch-widget', dataset: { chart: cfg.id }, 'aria-label': cfg.title },
      head,
      this.sub,
      this.plot,
      this.statsEl,
      this.legend,
      resizer,
    );
    this.applySize();
    this.wirePointer();
    this.wireDrag(grip);
    this.wireResize(resizer);
    this.ro = new ResizeObserver(() => this.requestDraw());
    this.ro.observe(this.plot);
    this.io = new IntersectionObserver((es) => {
      this.visible = es[es.length - 1]?.isIntersecting ?? true;
      if (this.visible) this.requestDraw();
    });
    this.io.observe(this.el);
    this.refreshChrome();
  }

  get cfg(): ChartCfg {
    return this.model.cfg;
  }

  dispose(): void {
    this.disposed = true;
    this.ro.disconnect();
    this.io.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  // ------------------------------------------------------------------------------------------ layout / chrome

  applySize(): void {
    const c = this.cfg;
    this.el.style.width = `${c.w}px`;
    this.el.style.height = c.h > 0 ? `${c.h}px` : '';
    this.el.classList.toggle('fixed-h', c.h > 0);
  }

  private layoutChanged(): void {
    this.refreshChrome();
    this.requestDraw();
  }

  /** Bring titles, buttons, the sub-toolbar and the legend in line with the configuration. */
  refreshChrome(): void {
    const c = this.cfg;
    this.titleBtn.textContent = c.title;
    this.el.setAttribute('aria-label', c.title);
    this.modeSeg.set(c.mode);
    this.liveBtn.classList.toggle('on', c.follow);
    this.liveBtn.replaceChildren(h('i', { class: 'ch-dot' }), h('span', null, c.follow ? 'Live' : 'Paused'));
    this.liveBtn.title = c.follow
      ? 'Following the newest data. Click to pause the view (recording continues)'
      : 'View paused (recording continues). Click to follow the live data';
    this.statsBtn.classList.toggle('on', c.stats);
    this.statsEl.style.display = c.stats ? '' : 'none';
    this.buildSub();
    this.buildLegend();
    this.updateLegendValues();
  }

  private traceOptions(sel: HTMLSelectElement, value: string, none: string): void {
    sel.replaceChildren(
      ...this.model.traces.map((t, i) =>
        h('option', { value: t.cfg.id, selected: t.cfg.id === value }, this.model.nameOf(i)),
      ),
    );
    if (!this.model.traces.length) sel.appendChild(h('option', { value: '' }, none));
  }

  private buildSub(): void {
    const c = this.cfg;
    const key = `${c.mode}|${c.traces.map((t) => t.id + t.label + t.expr).join(',')}|${c.spectrum.trace}|${c.xy.x}|${c.xy.y}|${c.hist.trace}`;
    if (key === this.subKey) return;
    this.subKey = key;
    this.sub.replaceChildren();
    this.sub.style.display = c.mode === 'time' ? 'none' : '';
    const sel = (label: string, value: string, set: (v: string) => void, title: string) => {
      const s = h('select', { class: 'select ch-select', title });
      this.traceOptions(s, value, 'no traces yet');
      s.addEventListener('change', () => {
        set(s.value);
        this.spec = null;
        this.specKey = '';
        this.host.save();
        this.requestDraw();
      });
      return h('label', { class: 'ch-field' }, h('span', null, label), s);
    };
    const eff = (id: string, fallback: number) =>
      this.model.traces.some((t) => t.cfg.id === id) ? id : (this.model.traces[fallback]?.cfg.id ?? '');
    if (c.mode === 'spectrum') {
      const win = h(
        'select',
        { class: 'select ch-select', title: 'Window function applied before the FFT' },
        ...WINDOWS.map((w) => h('option', { value: w.id, selected: w.id === c.spectrum.window }, w.label)),
      );
      win.addEventListener('change', () => {
        c.spectrum.window = win.value as WindowKind;
        this.specKey = '';
        this.host.save();
        this.requestDraw();
      });
      const log = h('input', { type: 'checkbox', checked: c.spectrum.log });
      log.addEventListener('change', () => {
        c.spectrum.log = log.checked;
        this.host.save();
        this.requestDraw();
      });
      this.sub.append(
        sel('Signal', eff(c.spectrum.trace, 0), (v) => (c.spectrum.trace = v), 'Trace to analyse'),
        h('label', { class: 'ch-field' }, h('span', null, 'Window'), win),
        h('label', { class: 'ch-field ch-check', title: 'Amplitude in decibels' }, log, h('span', null, 'dB')),
        h('span', { class: 'ch-hint' }, 'FFT of the visible time range · peaks are labelled'),
      );
    } else if (c.mode === 'xy') {
      this.sub.append(
        sel('X', eff(c.xy.x, 0), (v) => (c.xy.x = v), 'Trace on the horizontal axis'),
        sel('Y', eff(c.xy.y, 1), (v) => (c.xy.y = v), 'Trace on the vertical axis'),
        h('span', { class: 'ch-hint' }, 'Phase plot of the visible time range · newest part is brightest'),
      );
    } else if (c.mode === 'hist') {
      const bins = h(
        'select',
        { class: 'select ch-select', title: 'Number of bins' },
        ...[10, 20, 40, 80].map((n) => h('option', { value: String(n), selected: n === c.hist.bins }, `${n} bins`)),
      );
      bins.addEventListener('change', () => {
        c.hist.bins = Number(bins.value);
        this.host.save();
        this.requestDraw();
      });
      this.sub.append(
        sel('Signal', eff(c.hist.trace, 0), (v) => (c.hist.trace = v), 'Trace to bin'),
        bins,
      );
    }
  }

  private buildLegend(): void {
    const m = this.model;
    const key = m.cfg.traces
      .map(
        (t, i) =>
          `${t.id}|${t.color}|${t.visible}|${t.axis}|${t.label}|${t.expr}|${t.unit}|${m.traces[i]?.error ?? ''}`,
      )
      .join(';');
    if (key === this.chipKey) return;
    this.chipKey = key;
    this.chips = [];
    this.legend.replaceChildren();
    if (!m.cfg.traces.length) {
      this.legend.appendChild(
        h('span', { class: 'ch-empty' }, 'No traces yet. Use + Trace to plot a signal or type an expression.'),
      );
      return;
    }
    m.cfg.traces.forEach((t, i) => {
      const err = m.traces[i]?.error ?? '';
      const sw = h('button', {
        class: 'ch-sw',
        type: 'button',
        title: 'Show / hide this trace',
        style: { background: t.color },
      });
      sw.addEventListener('click', () => {
        t.visible = !t.visible;
        this.host.save();
        this.layoutChanged();
      });
      const name = h(
        'button',
        { class: 'ch-name', type: 'button', title: err ? err : `${m.nameOf(i)} — click to edit` },
        m.nameOf(i),
      );
      name.addEventListener('click', () => this.host.pickTrace(this, i));
      const val = h('b', { class: 'ch-val' }, '—');
      const axis = h(
        'button',
        { class: 'ch-axis', type: 'button', title: 'Left / right y-axis (click to switch)' },
        t.axis,
      );
      axis.addEventListener('click', () => {
        t.axis = t.axis === 'L' ? 'R' : 'L';
        this.host.save();
        this.layoutChanged();
      });
      const more = h('button', { class: 'ch-chipmore', type: 'button', title: 'Derived traces, remove' }, '⋯');
      more.addEventListener('click', () => this.traceMenu(more, i));
      const row = h(
        'div',
        { class: `ch-chip${t.visible ? '' : ' off'}${err ? ' err' : ''}`, dataset: { trace: t.id } },
        sw,
        name,
        err ? h('span', { class: 'ch-warn', title: err }, '!') : val,
        axis,
        more,
      );
      this.chips.push({ row, sw, name, val, axis });
      this.legend.appendChild(row);
    });
  }

  private traceMenu(anchor: HTMLElement, i: number): void {
    const t = this.cfg.traces[i];
    const items: MenuItem[] = [
      { label: 'Edit trace…', icon: 'settings', action: () => this.host.pickTrace(this, i) },
      { heading: 'Add a derived trace' },
      ...DERIVED_OPS.map((o) => ({
        label: o.label,
        icon: 'wave',
        action: () => this.addDerived(i, o.id),
      })),
      { sep: true },
      { label: 'Remove trace', icon: 'trash', action: () => this.removeTrace(t.id) },
    ];
    openMenu(items, anchor);
  }

  // ------------------------------------------------------------------------------------------ traces

  addDerived(i: number, op: DerivedOp): void {
    const src = this.cfg.traces[i];
    if (!src || this.cfg.traces.length >= MAX_TRACES) return;
    this.cfg.traces.push({
      id: newId('t'),
      label: '',
      expr: '',
      color: nextColor(this.cfg.traces),
      unit: '',
      axis: src.axis,
      visible: true,
      derived: { op, of: src.id },
    });
    this.host.tracesChanged(this);
  }

  removeTrace(id: string): void {
    const drop = new Set([id]);
    // derived traces go with their source
    for (let again = true; again;) {
      again = false;
      for (const t of this.cfg.traces) {
        if (t.derived && drop.has(t.derived.of) && !drop.has(t.id)) {
          drop.add(t.id);
          again = true;
        }
      }
    }
    this.cfg.traces = this.cfg.traces.filter((t) => !drop.has(t.id));
    const c = this.cfg;
    if (drop.has(c.spectrum.trace)) c.spectrum.trace = '';
    if (drop.has(c.hist.trace)) c.hist.trace = '';
    if (drop.has(c.xy.x)) c.xy.x = '';
    if (drop.has(c.xy.y)) c.xy.y = '';
    this.host.tracesChanged(this);
  }

  /** The labelled spectral peaks of the spectrum view (strongest first); empty outside the spectrum mode. */
  peaks(): readonly { freq: number; mag: number }[] {
    return this.currentSpec(true)?.peaks ?? [];
  }

  /** Called by the host after traces changed and the model was rebound. */
  tracesRebound(): void {
    this.subKey = '';
    this.chipKey = '';
    this.statsKey = '';
    this.spec = null;
    this.specKey = '';
    this.refreshChrome();
    this.requestDraw();
  }

  // ------------------------------------------------------------------------------------------ view window

  /** The visible time window. */
  window(): [number, number] {
    const c = this.cfg;
    const d = this.model.data;
    const last = d.length ? d.lastTime : 0;
    if (c.follow) {
      const t0 = Math.max(0, last - c.span);
      return [t0, t0 + c.span];
    }
    return [this.viewT0, this.viewT0 + c.span];
  }

  setFollow(on: boolean): void {
    const c = this.cfg;
    if (!on && c.follow) this.viewT0 = this.window()[0];
    c.follow = on;
    this.refreshChrome();
    this.requestDraw();
    this.host.save();
  }

  setMode(m: ChartMode): void {
    this.cfg.mode = m;
    this.spec = null;
    this.specKey = '';
    this.refreshChrome();
    this.requestDraw();
    this.host.save();
  }

  setSpan(s: number): void {
    const [t0] = this.window();
    this.cfg.span = Math.min(s, this.cfg.recordLen);
    if (!this.cfg.follow) this.viewT0 = t0;
    this.requestDraw();
    this.host.save();
  }

  // ------------------------------------------------------------------------------------------ pointer

  private pos(e: PointerEvent | WheelEvent | MouseEvent): Hover {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private wirePointer(): void {
    const cv = this.canvas;
    let down: { x: number; t0: number; moved: boolean; id: number } | null = null;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = this.pos(e);
      down = { x: p.x, t0: this.window()[0], moved: false, id: e.pointerId };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      const p = this.pos(e);
      this.hover = p;
      if (down && down.id === e.pointerId) {
        const dx = p.x - down.x;
        if (Math.abs(dx) > 3) down.moved = true;
        if (down.moved) {
          const c = this.cfg;
          const L = this.layout;
          if (c.follow) {
            c.follow = false;
            this.refreshChrome();
          }
          const d = this.model.data;
          const dt = (-dx / Math.max(1, L.pw)) * c.span;
          const lo = Math.min(d.firstTime, d.lastTime) - c.span * 0.25;
          const hi = Math.max(lo, d.lastTime - c.span * 0.25);
          this.viewT0 = Math.min(hi, Math.max(lo, down.t0 + dt));
        }
      }
      this.requestDraw();
    });
    const end = (e: PointerEvent) => {
      if (!down || down.id !== e.pointerId) return;
      const wasClick = !down.moved;
      down = null;
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      if (wasClick && e.type === 'pointerup') this.click(this.pos(e));
      else if (!wasClick) this.host.save();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
      if (!down) {
        this.hover = null;
        this.requestDraw();
      }
    });
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const c = this.cfg;
        const L = this.layout;
        const p = this.pos(e);
        const [t0] = this.window();
        const frac = Math.min(1, Math.max(0, (p.x - L.padL) / Math.max(1, L.pw)));
        const tc = t0 + frac * c.span;
        const span = Math.min(Math.max(0.2, c.recordLen), Math.max(0.2, c.span * Math.exp(e.deltaY * 0.0015)));
        c.span = span;
        if (!c.follow) this.viewT0 = tc - frac * span;
        this.requestDraw();
        this.host.save();
      },
      { passive: false },
    );
    cv.addEventListener('dblclick', () => this.setFollow(true));
    cv.addEventListener('contextmenu', (e) => {
      const i = this.markerAt(this.pos(e).x);
      if (i < 0) return;
      e.preventDefault();
      openMenu(
        [
          { label: 'Edit marker text…', icon: 'settings', action: () => void this.editMarker(i) },
          { label: 'Delete marker', icon: 'trash', action: () => this.deleteMarker(i) },
        ],
        { x: e.clientX, y: e.clientY },
      );
    });
    cv.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const c = this.cfg;
        if (c.follow) this.setFollow(false);
        this.viewT0 += (e.key === 'ArrowLeft' ? -1 : 1) * c.span * 0.1;
        this.requestDraw();
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === '+' || e.key === '-') {
        this.setSpan(this.cfg.span * (e.key === '+' ? 0.8 : 1.25));
        e.stopPropagation();
      } else if (e.key === 'Home' || e.key === 'End') {
        this.setFollow(e.key === 'End');
        e.stopPropagation();
      }
    });
  }

  private markerAt(x: number): number {
    const L = this.layout;
    const mk = this.cfg.markers;
    for (let i = 0; i < mk.length; i++) if (Math.abs(L.markerX[i] - x) <= 6) return i;
    return -1;
  }

  private click(p: Hover): void {
    const c = this.cfg;
    const L = this.layout;
    if (c.mode !== 'time' || p.x < L.padL || p.x > L.padL + L.pw || !this.model.data.length) return;
    const i = this.markerAt(p.x);
    if (i >= 0) {
      void this.editMarker(i);
      return;
    }
    if (c.markers.length >= MAX_MARKERS) return;
    const [t0] = this.window();
    const t = t0 + ((p.x - L.padL) / L.pw) * c.span;
    c.markers.push({ t, text: `M${c.markers.length + 1}` });
    this.host.save();
    this.requestDraw();
  }

  async editMarker(i: number): Promise<void> {
    const m = this.cfg.markers[i];
    if (!m) return;
    const text = await promptText('Marker text', `Annotation at t = ${m.t.toFixed(3)} s`, m.text, 'Save');
    if (text === null) return;
    m.text = text.slice(0, 120);
    this.host.save();
    this.requestDraw();
  }

  deleteMarker(i: number): void {
    this.cfg.markers.splice(i, 1);
    this.host.save();
    this.requestDraw();
  }

  async rename(): Promise<void> {
    const t = await promptText('Rename chart', 'Chart title', this.cfg.title, 'Rename');
    if (t === null) return;
    this.cfg.title = t.slice(0, 60);
    this.refreshChrome();
    this.host.save();
  }

  // ------------------------------------------------------------------------------------------ menus / export

  private optionsMenu(anchor: HTMLElement): void {
    const c = this.cfg;
    const items: MenuItem[] = [
      { heading: 'Visible time span' },
      ...SPANS.filter((s) => s <= c.recordLen).map((s) => ({
        label: `${s} s`,
        checked: Math.abs(c.span - s) < 0.01,
        action: () => this.setSpan(s),
      })),
      { heading: 'Record length' },
      ...RECORD_LENGTHS.map((s) => ({
        label: s >= 60 ? `${s / 60} min` : `${s} s`,
        checked: c.recordLen === s,
        action: () => {
          c.recordLen = s;
          c.span = Math.min(c.span, s);
          this.host.recordingChanged(this);
          this.host.save();
          this.requestDraw();
        },
      })),
      { sep: true },
      { label: 'Clear recorded data and markers', icon: 'trash', action: () => this.clearData() },
      { label: 'Rename…', icon: 'settings', action: () => void this.rename() },
      { label: 'Duplicate chart', icon: 'copy', action: () => this.host.duplicate(this) },
      { label: 'Move earlier', action: () => this.host.move(this, -1) },
      { label: 'Move later', action: () => this.host.move(this, 1) },
      { sep: true },
      { label: 'Remove chart', icon: 'trash', action: () => this.host.remove(this) },
    ];
    openMenu(items, anchor);
  }

  clearData(): void {
    this.model.clear();
    this.spec = null;
    this.specKey = '';
    this.requestDraw();
    this.host.save();
  }

  private exportMenu(anchor: HTMLElement): void {
    openMenu(
      [
        { label: 'Export image (PNG)', icon: 'camera', action: () => this.exportPng() },
        { label: 'Export data (CSV)', icon: 'download', action: () => this.exportCsv() },
      ],
      anchor,
    );
  }

  csv(): string {
    const m = this.model;
    return toCsv(
      m.data,
      m.traces.map((t, i) => ({ name: m.nameOf(i), unit: m.unitOf(i), channel: t.channel })),
      m.cfg.markers,
    );
  }

  exportCsv(): void {
    downloadBlob(`${slug(this.cfg.title)}.csv`, new Blob([this.csv()], { type: 'text/csv;charset=utf-8' }));
  }

  /** Render the current view (no cursor) plus a legend strip into a PNG. */
  exportPng(): Promise<Blob | null> {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(240, Math.round(this.canvas.clientWidth));
    const hh = Math.max(120, Math.round(this.canvas.clientHeight));
    const legendH = 8 + 18 * Math.max(1, Math.ceil(this.model.traces.length / 2));
    const off = document.createElement('canvas');
    off.width = Math.round(w * dpr);
    off.height = Math.round((hh + legendH + 22) * dpr);
    const g = off.getContext('2d');
    if (!g) return Promise.resolve(null);
    g.scale(dpr, dpr);
    const theme = this.getTheme();
    g.fillStyle = theme.bg;
    g.fillRect(0, 0, w, hh + legendH + 22);
    g.fillStyle = theme.textStrong;
    g.font = `600 12px ${theme.fontUi.split('px ')[1]}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(this.cfg.title, 10, 12);
    g.save();
    g.translate(0, 22);
    const [t0, t1] = this.window();
    drawChart(
      g,
      w,
      hh,
      { model: this.model, t0, t1, hover: null, theme, spec: this.currentSpec(true), interactive: false },
      newLayout(),
    );
    g.restore();
    g.font = theme.fontUi;
    this.model.traces.forEach((t, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = 10 + col * (w / 2);
      const y = 22 + hh + 14 + row * 18;
      g.fillStyle = t.cfg.color;
      g.fillRect(x, y - 2, 14, 3);
      g.fillStyle = theme.textStrong;
      const u = this.model.unitOf(i);
      g.fillText(`${this.model.nameOf(i)}${u ? ` [${u}]` : ''}`, x + 20, y);
    });
    return new Promise((res) => {
      off.toBlob((b) => {
        if (b) downloadBlob(`${slug(this.cfg.title)}.png`, b);
        res(b);
      }, 'image/png');
    });
  }

  // ------------------------------------------------------------------------------------------ drag / resize

  private wireDrag(grip: HTMLElement): void {
    grip.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('application/x-physicslab-chart', this.cfg.id);
      e.dataTransfer?.setData('text/plain', this.cfg.title);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setDragImage(this.el, 20, 14);
      }
      this.el.classList.add('dragging');
    });
    grip.addEventListener('dragend', () => this.el.classList.remove('dragging'));
    const isChart = (e: DragEvent) => e.dataTransfer?.types.includes('application/x-physicslab-chart') ?? false;
    this.el.addEventListener('dragover', (e) => {
      if (!isChart(e)) return;
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      this.el.classList.toggle('drop-before', !after);
      this.el.classList.toggle('drop-after', after);
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop-before', 'drop-after'));
    this.el.addEventListener('drop', (e) => {
      if (!isChart(e)) return;
      e.preventDefault();
      const after = this.el.classList.contains('drop-after');
      this.el.classList.remove('drop-before', 'drop-after');
      const id = e.dataTransfer?.getData('application/x-physicslab-chart');
      if (id && id !== this.cfg.id) this.host.reorder(id, this.cfg.id, after);
    });
  }

  private wireResize(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const r = this.el.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      const w0 = r.width;
      const h0 = r.height;
      const move = (ev: PointerEvent) => {
        this.cfg.w = Math.round(Math.min(1600, Math.max(240, w0 + ev.clientX - sx)));
        this.cfg.h = Math.round(Math.min(900, Math.max(180, h0 + ev.clientY - sy)));
        this.applySize();
        this.requestDraw();
      };
      const up = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.host.save();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => {
      this.cfg.h = 0;
      this.applySize();
      this.requestDraw();
      this.host.save();
    });
  }

  // ------------------------------------------------------------------------------------------ drawing

  private getTheme(): Theme {
    const now = performance.now();
    if (!this.theme || now - this.themeAt > 2000) {
      this.theme = readTheme(this.el);
      this.themeAt = now;
    }
    return this.theme;
  }

  /** Ask for a redraw (coalesced, <= ~30 Hz, skipped while hidden). */
  requestDraw(): void {
    if (this.raf || this.disposed) return;
    const wait = Math.max(0, FRAME_MS - (performance.now() - this.lastDraw));
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (wait > 0 && performance.now() - this.lastDraw < FRAME_MS) {
        this.requestDraw();
        return;
      }
      this.draw();
    });
  }

  private currentSpec(force = false): SpecResult | null {
    const c = this.cfg;
    if (c.mode !== 'spectrum') return null;
    const m = this.model;
    const [t0, t1] = this.window();
    let ti = m.traces.findIndex((t) => t.cfg.id === c.spectrum.trace);
    if (ti < 0)
      ti = Math.max(
        0,
        m.traces.findIndex((t) => t.cfg.visible),
      );
    if (ti < 0) return null;
    const key = `${m.data.length}|${m.data.lastTime}|${t0}|${t1}|${ti}|${c.spectrum.window}`;
    const now = performance.now();
    if (key !== this.specKey && (force || now - this.specAt > 120)) {
      this.specKey = key;
      this.specAt = now;
      this.spec = computeSpectrum(m, ti, t0, t1, c.spectrum.window);
    }
    return this.spec;
  }

  private draw(): void {
    if (this.disposed || !this.visible) return;
    const cv = this.canvas;
    const w = cv.clientWidth;
    const hh = cv.clientHeight;
    if (w < 40 || hh < 40) return;
    this.lastDraw = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(hh * dpr);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [t0, t1] = this.window();
    drawChart(
      g,
      w,
      hh,
      {
        model: this.model,
        t0,
        t1,
        hover: this.hover,
        theme: this.getTheme(),
        spec: this.currentSpec(),
        interactive: true,
      },
      this.layout,
    );
    this.updateLegendValues();
    if (this.cfg.stats && this.lastDraw - this.lastStats > 250) {
      this.lastStats = this.lastDraw;
      this.updateStats(t0, t1);
    }
  }

  private updateLegendValues(): void {
    const m = this.model;
    const d = m.data;
    const row = this.layout.hoverRow >= 0 && this.cfg.mode === 'time' ? this.layout.hoverRow : d.length - 1;
    for (let i = 0; i < this.chips.length && i < m.traces.length; i++) {
      const chip = this.chips[i];
      const t = m.traces[i];
      chip.row.classList.toggle('off', !t.cfg.visible);
      chip.axis.textContent = t.cfg.axis;
      const v = row >= 0 ? d.valueAt(t.channel, row) : NaN;
      const u = m.unitOf(i);
      const text = `${valueText(v)}${u ? ` ${u}` : ''}`;
      if (chip.val.textContent !== text) chip.val.textContent = text;
    }
  }

  private updateStats(t0: number, t1: number): void {
    const m = this.model;
    const d = m.data;
    const i0 = d.lowerBound(t0);
    const i1 = d.lowerBound(t1 + 1e-9);
    const key = `${m.traces.length}`;
    if (key !== this.statsKey) {
      this.statsKey = key;
      this.statsEl.replaceChildren();
    }
    const rows: HTMLElement[] = [
      h(
        'div',
        { class: 'ch-st head' },
        ...['trace', 'min', 'max', 'mean', 'RMS', 'σ', 'last', 'd/dt', '∫dt'].map((s) => h('span', null, s)),
      ),
    ];
    m.traces.forEach((t, i) => {
      if (!t.cfg.visible) return;
      const s = summarize(d, t.channel, i0, i1);
      const u = m.unitOf(i);
      const f = (v: number | undefined) => (v === undefined ? '—' : valueText(v));
      rows.push(
        h(
          'div',
          { class: 'ch-st', title: u ? `Units: ${u}` : '' },
          h('span', { style: { color: t.cfg.color } }, m.nameOf(i)),
          h('span', null, f(s?.min)),
          h('span', null, f(s?.max)),
          h('span', null, f(s?.mean)),
          h('span', null, f(s?.rms)),
          h('span', null, f(s?.std)),
          h('span', null, f(s?.last)),
          h('span', null, f(s?.slope)),
          h('span', null, f(s?.integral)),
        ),
      );
    });
    this.statsEl.replaceChildren(...rows);
  }
}

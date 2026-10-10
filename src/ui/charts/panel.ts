/**
 * The Charts panel (bottom dock): any number of chart widgets in a wrapping grid. Owns the persisted configuration
 * (localStorage), the sampling of every chart once per physics frame, and the plumbing between widgets and the
 * trace dialog. Registered through the panel registry (`chartsPanel`).
 */
import '../../styles/charts.css'; // the chart styles load with the panel (keeps src/main.ts conflict-free)
import type { App } from '../../app/app';
import type { PanelDef } from '../../app/registry/panels';
import { h } from '../dom';
import { icon } from '../icons';
import { openMenu } from '../menu';
import type { MenuItem } from '../menu';
import { createAppSource } from './appSource';
import type { AppSource } from './appSource';
import { ChartModel, MAX_CHARTS, MAX_TRACES, defaultChart, newId, nextColor, sanitizeChart } from './model';
import type { ChartCfg, TraceCfg } from './model';
import { openTraceDialog } from './traceDialog';
import { ChartWidget } from './widget';
import type { WidgetHost } from './widget';

const STORAGE_KEY = 'physixlab.charts.v1';

interface Persisted {
  v: 1;
  charts: ChartCfg[];
  aliases: Record<string, string>;
}

export function loadPersisted(raw: string | null): { charts: ChartCfg[]; aliases: Record<string, string> } {
  const out = { charts: [] as ChartCfg[], aliases: {} as Record<string, string> };
  if (!raw) return out;
  try {
    const p = JSON.parse(raw) as Partial<Persisted> | null;
    if (!p || typeof p !== 'object') return out;
    const seen = new Set<string>();
    for (const c of Array.isArray(p.charts) ? p.charts.slice(0, MAX_CHARTS) : []) {
      const s = sanitizeChart(c);
      if (s && !seen.has(s.id)) {
        seen.add(s.id);
        out.charts.push(s);
      }
    }
    if (p.aliases && typeof p.aliases === 'object') {
      for (const [k, v] of Object.entries(p.aliases).slice(0, 40))
        if (/^[A-Za-z_]\w{0,23}$/.test(k) && typeof v === 'string' && v.length < 80) out.aliases[k] = v;
    }
  } catch {
    /* corrupt storage: start empty */
  }
  return out;
}

interface Preset {
  label: string;
  title: string;
  make: () => ChartCfg;
}

function trace(expr: string, label: string, color: string, unit = '', axis: 'L' | 'R' = 'L'): TraceCfg {
  return { id: newId('t'), label, expr, color, unit, axis, visible: true };
}

const PRESETS: readonly Preset[] = [
  { label: 'Empty chart', title: 'Start with no traces and add your own', make: () => defaultChart('Chart') },
  {
    label: 'Selected object: speed and height',
    title: 'Speed (left axis) and height (right axis) of whatever is selected',
    make: () => ({
      ...defaultChart('Selection'),
      traces: [
        trace('speed(selected)', 'Speed', '#3ddcff', 'm/s'),
        trace('height(selected)', 'Height', '#ffb347', 'm', 'R'),
      ],
    }),
  },
  {
    label: 'Energy of the whole scene',
    title: 'Total, kinetic, gravitational and spring energy',
    make: () => ({
      ...defaultChart('Energy'),
      traces: [
        trace('energy_total()', 'Total', '#e8eefc', 'J'),
        trace('energy_kinetic()', 'Kinetic', '#3ddcff', 'J'),
        trace('energy_potential()', 'Gravitational', '#ffb347', 'J'),
        trace('energy_elastic()', 'Spring', '#ff6b9a', 'J'),
      ],
    }),
  },
  {
    label: 'Phase plot: height vs vertical velocity',
    title: 'XY plot of the selected object',
    make: () => {
      const c: ChartCfg = {
        ...defaultChart('Phase plot'),
        mode: 'xy',
        traces: [
          trace('height(selected)', 'Height', '#3ddcff', 'm'),
          trace('vel_y(selected)', 'Vertical velocity', '#ffb347', 'm/s'),
        ],
      };
      c.xy = { x: c.traces[0].id, y: c.traces[1].id };
      return c;
    },
  },
  {
    label: 'Spectrum of the selected object’s height',
    title: 'FFT of the height of the selection (oscillators show their frequency)',
    make: () => {
      const c: ChartCfg = {
        ...defaultChart('Spectrum'),
        mode: 'spectrum',
        span: 30,
        traces: [trace('height(selected)', 'Height', '#5be3a1', 'm')],
      };
      c.spectrum.trace = c.traces[0].id;
      return c;
    },
  },
];

class ChartsPanel implements WidgetHost {
  readonly el: HTMLElement;
  readonly toolbar: HTMLElement[];
  private readonly grid: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly tile: HTMLElement;
  private widgets: ChartWidget[] = [];
  private readonly source: AppSource;
  private saveTimer = 0;
  private lastFrame = -1;
  private forcedContacts = false;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly app: App,
    private readonly active: () => boolean,
  ) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    const saved = loadPersisted(raw);
    this.source = createAppSource(app, saved.aliases);

    this.grid = h('div', { class: 'ch-grid' });
    this.empty = h('div', { class: 'ch-emptystate' });
    this.el = h('div', { class: 'ch-panel' }, this.grid, this.empty);
    // Also in the grid: the tab strip of the dock can be too crowded to show the toolbar button (narrow windows).
    this.tile = h(
      'button',
      { class: 'ch-addtile', type: 'button', title: 'Add a chart', 'aria-label': 'Add chart' },
      icon('plus'),
      h('span', null, 'Add chart'),
    );
    this.tile.addEventListener('click', () => this.addMenu(this.tile));
    this.grid.appendChild(this.tile);
    const add = h(
      'button',
      { class: 'btn small ch-addchart', type: 'button', title: 'Add chart', 'aria-label': 'Add chart' },
      icon('plus'),
      h('span', { class: 'ch-addlabel' }, 'Add chart'),
    );
    add.addEventListener('click', () => this.addMenu(add));
    this.toolbar = [add];

    for (const cfg of saved.charts) this.mount(cfg);
    this.refreshEmpty();

    // Sampling: once per physics frame, no DOM work.
    const onFrame = () => this.onFrame();
    this.offs.push(app.on('frame', onFrame));
    const rebind = () => {
      let any = false;
      for (const w of this.widgets) if (w.model.rebindSelected()) any = true;
      if (any) for (const w of this.widgets) w.tracesRebound();
    };
    this.offs.push(app.store.on('selection', rebind));
    let t = 0;
    this.offs.push(
      app.store.on('change', () => {
        clearTimeout(t);
        t = window.setTimeout(rebind, 250);
      }),
    );
    // Spawned debris and rebuilt worlds emit `layout` while a chart is recording: only retry what could not resolve
    // earlier. (Rebinding everything would restart the running state of derivative / integral traces.)
    this.offs.push(app.sim.on('layout', rebind));
  }

  // ------------------------------------------------------------------------------------------ plumbing

  private mount(cfg: ChartCfg, at = -1): ChartWidget {
    const model = new ChartModel(cfg);
    model.bind(this.source);
    const w = new ChartWidget(model, this);
    if (at < 0 || at >= this.widgets.length) {
      this.widgets.push(w);
      this.grid.insertBefore(w.el, this.tile);
    } else {
      this.grid.insertBefore(w.el, this.widgets[at].el);
      this.widgets.splice(at, 0, w);
    }
    return w;
  }

  private refreshEmpty(): void {
    this.empty.style.display = this.widgets.length ? 'none' : '';
    this.grid.style.display = this.widgets.length ? '' : 'none';
    if (this.widgets.length) return;
    this.empty.replaceChildren(
      h('div', { class: 'ch-empty-title' }, 'Charts'),
      h(
        'p',
        null,
        'Plot any signal of the simulation against time: positions, velocities, accelerations, momentum, energy, joint and spring values, or your own expression such as ',
        h('code', null, 'speed(a) - speed(b)'),
        '. Zoom with the wheel, pan by dragging, click to drop a marker, and switch a chart to spectrum, phase plot or histogram.',
      ),
      h(
        'div',
        { class: 'ch-presets' },
        ...PRESETS.map((p) => {
          const b = h('button', { class: 'btn small', type: 'button', title: p.title }, p.label);
          b.addEventListener('click', () => this.addChart(p.make()));
          return b;
        }),
      ),
    );
  }

  addChart(cfg: ChartCfg): ChartWidget | null {
    if (this.widgets.length >= MAX_CHARTS) {
      this.app.toast(`Up to ${MAX_CHARTS} charts. Remove one first.`, 'warn');
      return null;
    }
    const w = this.mount(cfg);
    this.refreshEmpty();
    this.save();
    this.syncContacts();
    w.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    w.requestDraw();
    return w;
  }

  private addMenu(anchor: HTMLElement): void {
    const items: MenuItem[] = PRESETS.map((p) => ({
      label: p.label,
      icon: p === PRESETS[0] ? 'plus' : 'wave',
      action: () => void this.addChart(p.make()),
    }));
    openMenu(items, anchor);
  }

  /** The widgets, in display order (for tests and tools). */
  list(): readonly ChartWidget[] {
    return this.widgets;
  }

  save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    clearTimeout(this.saveTimer);
    const data: Persisted = { v: 1, charts: this.widgets.map((w) => w.cfg), aliases: { ...this.source.aliases() } };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* private window or quota: the charts simply do not persist */
    }
  }

  private syncContacts(): void {
    const need = this.widgets.some((w) => w.model.needsContacts);
    const sim = this.app.sim;
    if (need && !sim.wantContacts) {
      sim.wantContacts = true;
      this.forcedContacts = true;
    } else if (!need && this.forcedContacts) {
      sim.wantContacts = this.app.prefs.value.overlays.contacts;
      this.forcedContacts = false;
    }
  }

  private onFrame(): void {
    const c = this.app.sim.client;
    if (!c.active || !c.stats || c.frameNo === this.lastFrame || !this.widgets.length) return;
    this.lastFrame = c.frameNo;
    if (this.forcedContacts && !this.app.sim.wantContacts) this.app.sim.wantContacts = true;
    const running = this.app.sim.mode === 'running';
    const t = c.stats.simTime;
    const show = this.active() && this.app.prefs.value.showBottom;
    for (const w of this.widgets) {
      if (!running && w.model.data.length > 0) continue;
      if (w.model.sample(t) && show) w.requestDraw();
    }
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    this.flush();
    for (const off of this.offs) off();
    for (const w of this.widgets) w.dispose();
    if (this.forcedContacts) this.app.sim.wantContacts = this.app.prefs.value.overlays.contacts;
  }

  // ------------------------------------------------------------------------------------------ WidgetHost

  remove(w: ChartWidget): void {
    const i = this.widgets.indexOf(w);
    if (i < 0) return;
    this.widgets.splice(i, 1);
    w.dispose();
    w.el.remove();
    this.refreshEmpty();
    this.syncContacts();
    this.save();
  }

  duplicate(w: ChartWidget): void {
    const src = w.cfg;
    const ids = new Map<string, string>();
    const copy: ChartCfg = JSON.parse(JSON.stringify(src)) as ChartCfg;
    copy.id = newId('c');
    copy.title = `${src.title} copy`.slice(0, 60);
    for (const t of copy.traces) {
      const old = t.id;
      t.id = newId('t');
      ids.set(old, t.id);
      if (t.derived) t.derived.of = ids.get(t.derived.of) ?? t.derived.of;
    }
    const map = (id: string) => ids.get(id) ?? '';
    copy.spectrum.trace = map(copy.spectrum.trace);
    copy.xy = { x: map(copy.xy.x), y: map(copy.xy.y) };
    copy.hist.trace = map(copy.hist.trace);
    copy.markers = [];
    if (this.widgets.length >= MAX_CHARTS) {
      this.app.toast(`Up to ${MAX_CHARTS} charts. Remove one first.`, 'warn');
      return;
    }
    const at = this.widgets.indexOf(w) + 1;
    this.mount(copy, at);
    this.save();
  }

  move(w: ChartWidget, dir: -1 | 1): void {
    const i = this.widgets.indexOf(w);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.widgets.length) return;
    this.widgets.splice(i, 1);
    this.widgets.splice(j, 0, w);
    this.relayout();
  }

  reorder(dragId: string, targetId: string, after: boolean): void {
    const from = this.widgets.findIndex((w) => w.cfg.id === dragId);
    if (from < 0) return;
    const [w] = this.widgets.splice(from, 1);
    let to = this.widgets.findIndex((x) => x.cfg.id === targetId);
    if (to < 0) to = this.widgets.length;
    this.widgets.splice(after ? to + 1 : to, 0, w);
    this.relayout();
  }

  private relayout(): void {
    this.grid.replaceChildren(...this.widgets.map((w) => w.el), this.tile);
    this.save();
  }

  pickTrace(w: ChartWidget, index?: number): void {
    const cfg = w.cfg;
    const existing = index !== undefined ? cfg.traces[index] : undefined;
    if (!existing && cfg.traces.length >= MAX_TRACES) {
      this.app.toast(`A chart holds up to ${MAX_TRACES} traces.`, 'warn');
      return;
    }
    const from = existing?.derived
      ? w.model.nameOf(cfg.traces.findIndex((t) => t.id === existing.derived?.of))
      : undefined;
    openTraceDialog({
      app: this.app,
      source: this.source,
      existing,
      derivedFrom: from,
      color: nextColor(cfg.traces),
      onAliases: () => {
        for (const x of this.widgets) {
          x.model.bind(this.source);
          x.tracesRebound();
        }
        this.save();
      },
      onSave: (t, again) => {
        if (existing) {
          existing.label = t.label;
          existing.unit = t.unit;
          existing.color = t.color;
          existing.axis = t.axis;
          if (existing.derived && t.derivedOp) existing.derived.op = t.derivedOp;
          else existing.expr = t.expr;
          if (existing.derived) existing.derived = { ...existing.derived };
          w.model.bind(this.source);
          // a changed derived operation needs a fresh running state
          w.model.recompile(index as number);
          w.tracesRebound();
          this.syncContacts();
          this.save();
          return;
        }
        if (cfg.traces.length >= MAX_TRACES) {
          this.app.toast(`A chart holds up to ${MAX_TRACES} traces.`, 'warn');
          return;
        }
        cfg.traces.push({ id: newId('t'), ...t, visible: true });
        this.tracesChanged(w);
        if (again) this.app.toast('Trace added', 'info');
      },
    });
  }

  tracesChanged(w: ChartWidget): void {
    w.model.bind(this.source);
    w.tracesRebound();
    this.syncContacts();
    this.save();
  }

  recordingChanged(w: ChartWidget): void {
    w.model.applyRecording();
    w.requestDraw();
  }
}

const panels = new WeakMap<App, ChartsPanel>();
/** The panel of the running app: `window.physixlab` is a Proxy of the App, so lookups by identity can miss. */
let current: ChartsPanel | undefined;

/** The charts panel of an app (created on first use); for tests, tools and other panels. */
export function chartsFor(app: App): ChartsPanel | undefined {
  return panels.get(app) ?? current;
}

export type { ChartsPanel };

export const chartsPanel: PanelDef = {
  id: 'charts',
  label: 'Charts',
  icon: 'wave',
  region: 'bottom',
  order: 30,
  title: 'Live charts: any signal or expression against time, plus spectrum, phase plot and histogram views',
  build(app, ctx) {
    const panel = new ChartsPanel(app, ctx.active);
    panels.set(app, panel);
    current = panel;
    return {
      el: panel.el,
      toolbar: panel.toolbar,
      onShow: () => panel.list().forEach((w) => w.requestDraw()),
      dispose: () => {
        panel.dispose();
        panels.delete(app);
        if (current === panel) current = undefined;
      },
    };
  },
};

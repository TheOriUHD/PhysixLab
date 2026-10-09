/**
 * Telemetry dock: live time-series charts of the running simulation.
 *  - Energy: kinetic, rotational, potential, spring (elastic) and total mechanical energy.
 *  - Selection: speed / height of the selected body, or position / speed of a selected joint.
 * All values come straight from the physics worker's per-frame statistics.
 */
import { RAD, vlen } from '../core/math';
import type { App } from '../app/app';
import { B } from '../physics/protocol';
import { fmt } from './controls';
import { h } from './dom';
import { iconButton } from './controls';

interface SeriesDef { id: string; label: string; color: string; unit: string; on: boolean; fmt?: (v: number) => string }

class Chart {
  readonly canvas = h('canvas');
  readonly legend = h('div', { class: 'legend' });
  readonly wrap = h('div', { class: 'chart-wrap' }, this.canvas);
  private t: number[] = [];
  private data: number[][] = [];
  private items: HTMLElement[] = [];
  private values: HTMLElement[] = [];
  window = 15;
  zeroLine = true;

  constructor(private defs: SeriesDef[], private unitLabel: string) {
    this.data = defs.map(() => []);
    defs.forEach((d, i) => {
      const value = h('b', null, '—');
      const item = h('div', { class: `legend-item toggle ${d.on ? '' : 'off'}`, title: 'Click to show / hide' }, h('i', { style: { background: d.color } }), h('span', null, d.label), value);
      item.addEventListener('click', () => { d.on = !d.on; item.classList.toggle('off', !d.on); this.draw(); });
      this.items.push(item); this.values.push(value);
      this.legend.appendChild(item);
      void i;
    });
  }

  reset(defs?: SeriesDef[]): void {
    if (defs) {
      this.defs = defs;
      this.legend.replaceChildren();
      this.items = []; this.values = [];
      defs.forEach((d) => {
        const value = h('b', null, '—');
        const item = h('div', { class: `legend-item toggle ${d.on ? '' : 'off'}` }, h('i', { style: { background: d.color } }), h('span', null, d.label), value);
        item.addEventListener('click', () => { d.on = !d.on; item.classList.toggle('off', !d.on); this.draw(); });
        this.items.push(item); this.values.push(value);
        this.legend.appendChild(item);
      });
    }
    this.t = [];
    this.data = this.defs.map(() => []);
    this.draw();
  }

  push(t: number, values: number[]): void {
    if (this.t.length && t < this.t[this.t.length - 1]) this.reset();
    this.t.push(t);
    values.forEach((v, i) => this.data[i].push(v));
    // keep roughly 2× the visible window
    const cutoff = t - this.window * 2;
    while (this.t.length > 2 && this.t[1] < cutoff) { this.t.shift(); this.data.forEach((d) => d.shift()); }
    values.forEach((v, i) => {
      const d = this.defs[i];
      this.values[i].textContent = `${d.fmt ? d.fmt(v) : fmt(v, Math.abs(v) < 10 ? 3 : Math.abs(v) < 1000 ? 2 : 0)} ${d.unit}`;
    });
  }

  draw(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, hgt = c.clientHeight;
    if (w < 10 || hgt < 10) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const padL = 54, padR = 12, padT = 10, padB = 20;
    const pw = w - padL - padR, ph = hgt - padT - padB;
    const tEnd = this.t.length ? this.t[this.t.length - 1] : 0;
    const tStart = Math.max(0, tEnd - this.window);
    const t0 = Math.min(tStart, tEnd - this.window);
    let lo = Infinity, hi = -Infinity;
    this.defs.forEach((d, i) => {
      if (!d.on) return;
      for (let k = 0; k < this.t.length; k++) if (this.t[k] >= t0) { lo = Math.min(lo, this.data[i][k]); hi = Math.max(hi, this.data[i][k]); }
    });
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (this.zeroLine) lo = Math.min(lo, 0);
    if (hi - lo < 1e-9) hi = lo + 1;
    const padY = (hi - lo) * 0.08;
    hi += padY; if (lo !== 0 || !this.zeroLine) lo -= padY;
    const X = (t: number) => padL + ((t - t0) / this.window) * pw;
    const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * ph;

    g.font = '10.5px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.fillStyle = '#627086';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      const y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.textAlign = 'right';
      g.fillText(niceNum(v), padL - 6, y);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let s = Math.ceil(t0); s <= tEnd + 0.01; s += this.window > 10 ? 5 : 2) {
      const x = X(s);
      if (x < padL || x > w - padR) continue;
      g.strokeStyle = 'rgba(255,255,255,0.04)';
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, padT); g.lineTo(Math.round(x) + 0.5, padT + ph); g.stroke();
      g.fillText(`${s}s`, x, padT + ph + 5);
    }
    if (this.zeroLine && lo < 0 && hi > 0) {
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      const y = Math.round(Y(0)) + 0.5;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
    }
    g.save();
    g.beginPath(); g.rect(padL, padT - 2, pw, ph + 4); g.clip();
    this.defs.forEach((d, i) => {
      if (!d.on || this.t.length < 2) return;
      g.strokeStyle = d.color;
      g.lineWidth = d.id === 'total' ? 2.2 : 1.6;
      g.lineJoin = 'round';
      g.beginPath();
      let started = false;
      for (let k = 0; k < this.t.length; k++) {
        if (this.t[k] < t0 - 0.5) continue;
        const x = X(this.t[k]), y = Y(this.data[i][k]);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
    });
    g.restore();
    g.fillStyle = '#627086';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText(this.unitLabel, padL + 4, padT);
    if (this.t.length < 2) {
      g.fillStyle = '#627086'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = '12px Inter, system-ui, sans-serif';
      g.fillText('Press Simulate to record', padL + pw / 2, padT + ph / 2);
    }
  }
}

function niceNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

export function buildDock(app: App): HTMLElement {
  const { prefs } = app;
  const energyDefs: SeriesDef[] = [
    { id: 'total', label: 'Total mechanical', color: '#e8eefc', unit: 'J', on: true },
    { id: 'kinetic', label: 'Kinetic (motion)', color: '#3ddcff', unit: 'J', on: true },
    { id: 'rot', label: 'Kinetic (spin)', color: '#b18cff', unit: 'J', on: true },
    { id: 'potential', label: 'Gravitational', color: '#ffb347', unit: 'J', on: true },
    { id: 'elastic', label: 'Spring', color: '#ff6b9a', unit: 'J', on: true },
  ];
  const energy = new Chart(energyDefs, 'Energy (J)');
  let selDefs = selectionDefs('none');
  const selection = new Chart(selDefs, '');
  selection.zeroLine = true;

  const tabEnergy = h('button', { class: 'tab', type: 'button' }, 'Energy');
  const tabSel = h('button', { class: 'tab', type: 'button' }, 'Selection');
  tabEnergy.addEventListener('click', () => prefs.set({ bottomTab: 'energy' }));
  tabSel.addEventListener('click', () => prefs.set({ bottomTab: 'selection' }));
  const note = h('span', { style: { color: 'var(--text-3)', fontSize: '11.5px', marginLeft: '10px' } }, '');
  const winSel = h('select', { class: 'select', style: { width: '84px', marginLeft: 'auto', height: '24px' }, title: 'Time window' }, ...[5, 15, 30, 60].map((s) => h('option', { value: String(s), selected: s === 15 }, `${s} s`)));
  winSel.addEventListener('change', () => { energy.window = selection.window = Number(winSel.value); energy.draw(); selection.draw(); });
  const clearBtn = iconButton('trash', 'Clear recorded data', () => { energy.reset(); selection.reset(); });
  const head = h('div', { class: 'dock-head' }, tabEnergy, tabSel, note, winSel, clearBtn);

  const eBody = h('div', { class: 'dock-body' }, energy.wrap, energy.legend);
  const sBody = h('div', { class: 'dock-body' }, selection.wrap, selection.legend);
  const dock = h('div', { class: 'dock' }, head, eBody, sBody);

  const syncTabs = () => {
    const t = prefs.value.bottomTab;
    tabEnergy.classList.toggle('on', t === 'energy');
    tabSel.classList.toggle('on', t === 'selection');
    eBody.style.display = t === 'energy' ? '' : 'none';
    sBody.style.display = t === 'selection' ? '' : 'none';
    dock.classList.toggle('collapsed', !prefs.value.showBottom);
    requestAnimationFrame(() => { energy.draw(); selection.draw(); });
  };
  prefs.on('change', syncTabs);
  syncTabs();

  // Rebuild the selection chart when what is selected changes.
  let selKey = '';
  const selKind = (): { kind: 'body' | 'joint' | 'none'; id: string } => {
    const id = app.store.selection[0];
    if (!id) return { kind: 'none', id: '' };
    return app.store.body(id) ? { kind: 'body', id } : app.store.joint(id) ? { kind: 'joint', id } : { kind: 'none', id: '' };
  };
  const rebuildSel = () => {
    const k = selKind();
    selKey = `${k.kind}:${k.id}`;
    selDefs = selectionDefs(k.kind, k.id ? app.store.joint(k.id)?.type : undefined);
    selection.reset(selDefs);
    note.textContent = k.kind === 'none' ? 'Select an object to plot its motion' : app.store.get(k.id)?.name ?? '';
  };
  app.store.on('selection', rebuildSel);
  rebuildSel();

  let lastFrame = -1;
  let lastDraw = 0;
  app.on('frame', () => {
    const c = app.sim.client;
    if (!c.active || !c.stats || c.frameNo === lastFrame) return;
    lastFrame = c.frameNo;
    if (app.sim.mode === 'running' || c.frameNo <= 2 || app.sim.mode === 'paused') {
      const st = c.stats;
      if (app.sim.mode === 'running' || energy['t'].length === 0) {
        const e = st.energy;
        energy.push(st.simTime, [e.kinetic + e.rotational + e.potential + e.elastic, e.kinetic, e.rotational, e.potential, e.elastic]);
        const k = selKind();
        if (`${k.kind}:${k.id}` !== selKey) rebuildSel();
        if (k.kind === 'body') {
          const p = c.poseOf(k.id);
          if (p) {
            const v = Math.hypot(p[B.vx], p[B.vy], p[B.vz]);
            selection.push(st.simTime, [v, p[B.py], p[B.ke], vlen([p[B.fx], p[B.fy], p[B.fz]]), Math.hypot(p[B.wx], p[B.wy], p[B.wz])]);
          }
        } else if (k.kind === 'joint') {
          const s = c.jointOf(k.id);
          const t = app.store.joint(k.id)?.type;
          if (s) selection.push(st.simTime, t === 'hinge' ? [s[0] * RAD, s[1], ] : t === 'spring' ? [s[0], s[2], s[1]] : [s[0], s[1]]);
        }
      }
    }
    const now = performance.now();
    if (now - lastDraw > 60 && prefs.value.showBottom) {
      lastDraw = now;
      (prefs.value.bottomTab === 'energy' ? energy : selection).draw();
    }
  });
  app.sim.on('layout', () => { if (!app.sim.active) { energy.reset(); selection.reset(); } else { energy.reset(); selection.reset(); } });
  new ResizeObserver(() => { energy.draw(); selection.draw(); }).observe(dock);
  return dock;
}

function selectionDefs(kind: 'body' | 'joint' | 'none', jtype?: string): SeriesDef[] {
  if (kind === 'body') {
    return [
      { id: 'speed', label: 'Speed', color: '#3ddcff', unit: 'm/s', on: true },
      { id: 'height', label: 'Height', color: '#ffb347', unit: 'm', on: true },
      { id: 'ke', label: 'Kinetic energy', color: '#b18cff', unit: 'J', on: false },
      { id: 'force', label: 'Net force', color: '#ff6b9a', unit: 'N', on: false },
      { id: 'spin', label: 'Spin rate', color: '#5be3a1', unit: 'rad/s', on: false },
    ];
  }
  if (kind === 'joint') {
    if (jtype === 'hinge') return [{ id: 'angle', label: 'Angle', color: '#ffb347', unit: '°', on: true }, { id: 'speed', label: 'Angular speed', color: '#3ddcff', unit: 'rad/s', on: true }];
    if (jtype === 'spring') return [{ id: 'length', label: 'Length', color: '#3ddcff', unit: 'm', on: true }, { id: 'force', label: 'Force', color: '#ff6b9a', unit: 'N', on: true }, { id: 'rate', label: 'Stretch rate', color: '#ffb347', unit: 'm/s', on: false }];
    return [{ id: 'pos', label: 'Position', color: '#5be3a1', unit: 'm', on: true }, { id: 'speed', label: 'Speed', color: '#3ddcff', unit: 'm/s', on: true }];
  }
  return [{ id: 'none', label: 'Nothing selected', color: '#627086', unit: '', on: false }];
}

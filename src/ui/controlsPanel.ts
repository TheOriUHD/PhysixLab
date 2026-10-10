/**
 * The Controls tab of the bottom dock (package CP): every key and every analog axis that the components of the scene
 * listen to, as things you can hold and drag with the mouse or a finger. The physical keyboard keeps working the same
 * way (the keys are lit while held); the axes (`ctx.input.axis`) have no keyboard form, so this is where a throttle,
 * a steering input or a collective is driven from.
 *
 *   - Axes: a slider from −1 to +1 per axis name; double-click or the reset button zeroes it; "Spring back" returns it
 *     to zero when released (a joystick) instead of holding the value (a lever).
 *   - Keys: a key cap per bound key; pressing it holds the key for the simulation exactly as the keyboard does.
 *
 * What is listed comes from `sceneControls` (src/model/controls.ts), so a new component shows up here without any code.
 */
import type { App } from '../app/app';
import type { PanelDef } from '../app/registry/panels';
import { describeUse, sceneControls, type AxisControl, type KeyControl } from '../model/controls';
import { keyLabel } from './controls';
import { clear, h } from './dom';

const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

class ControlsView {
  readonly el = h('div', { class: 'ctl-panel', 'aria-label': 'Controls' });
  private readonly hint = h('div', { class: 'ctl-hint' });
  private readonly axisBox = h('div', { class: 'ctl-axes', role: 'group', 'aria-label': 'Analog axes' });
  private readonly keyBox = h('div', { class: 'ctl-keys', role: 'group', 'aria-label': 'Keys' });
  private readonly spring = h('input', { type: 'checkbox', id: 'ctl-spring' });
  private readonly axisValues = new Map<string, number>();
  private readonly keyButtons = new Map<string, HTMLButtonElement>();
  private readonly sliders = new Map<string, { range: HTMLInputElement; out: HTMLOutputElement }>();
  private signature = '';
  private queued = false;

  constructor(private readonly app: App) {
    const springLabel = h(
      'label',
      { class: 'ctl-spring', title: 'Return an axis to zero when you let go of its slider, like a joystick' },
      this.spring,
      h('span', null, 'Spring back'),
    );
    this.el.append(
      h(
        'div',
        { class: 'ctl-col' },
        h('div', { class: 'ctl-head' }, h('b', null, 'Analog axes'), springLabel),
        this.axisBox,
      ),
      h('div', { class: 'ctl-col keys' }, h('div', { class: 'ctl-head' }, h('b', null, 'Keys')), this.keyBox),
      this.hint,
    );
    app.store.on('change', () => this.schedule());
    app.sim.on('mode', () => {
      if (!app.sim.active) this.releaseAll();
      this.syncEnabled();
    });
    window.addEventListener('keydown', () => this.syncKeys());
    window.addEventListener('keyup', () => this.syncKeys());
    this.rebuild();
  }

  /** Rebuild after the document changed (coalesced to one per frame). */
  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.rebuild();
    });
  }

  /** Let go of everything: zero every axis, release every key held with the mouse. */
  releaseAll(): void {
    for (const name of this.axisValues.keys()) this.setAxis(name, 0);
    for (const code of this.keyButtons.keys()) this.app.sim.keys.delete(code);
    this.syncKeys();
  }

  private setAxis(name: string, value: number): void {
    const v = Math.max(-1, Math.min(1, Math.round(value * 100) / 100));
    this.axisValues.set(name, v);
    this.app.sim.setAxis(name, v);
    const s = this.sliders.get(name);
    if (s) {
      s.range.value = String(v);
      s.out.textContent = (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
      s.range.style.setProperty('--fill', String(v));
    }
  }

  private rebuild(): void {
    const { keys, axes } = sceneControls(this.app.store.all());
    const sig = JSON.stringify([keys.map((k) => k.code), axes.map((a) => a.name)]);
    if (sig === this.signature) return; // same controls: keep the DOM (and a drag in progress)
    this.signature = sig;
    clear(this.axisBox);
    clear(this.keyBox);
    this.keyButtons.clear();
    this.sliders.clear();
    for (const name of [...this.axisValues.keys()]) {
      if (!axes.some((a) => a.name === name)) {
        this.app.sim.setAxis(name, 0);
        this.axisValues.delete(name);
      }
    }
    if (!axes.length) this.axisBox.append(h('div', { class: 'ctl-empty' }, 'No analog axes in this scene.'));
    for (const a of axes) this.axisBox.append(this.axisRow(a));
    if (!keys.length) this.keyBox.append(h('div', { class: 'ctl-empty' }, 'No keys are bound in this scene.'));
    for (const k of keys) this.keyBox.append(this.keyCap(k));
    this.syncEnabled();
  }

  private axisRow(a: AxisControl): HTMLElement {
    const range = h('input', {
      type: 'range',
      class: 'slider ctl-slider',
      min: '-1',
      max: '1',
      step: '0.01',
      value: String(this.axisValues.get(a.name) ?? 0),
      id: `ctl-axis-${slug(a.name)}`,
      'aria-label': `${a.name} axis`,
    });
    const out = h('output', { class: 'ctl-out', for: range.id }, '+0.00');
    this.sliders.set(a.name, { range, out });
    range.addEventListener('input', () => this.setAxis(a.name, Number(range.value)));
    const letGo = () => {
      if (this.spring.checked) this.setAxis(a.name, 0);
    };
    range.addEventListener('pointerup', letGo);
    range.addEventListener('keyup', letGo);
    range.addEventListener('dblclick', () => this.setAxis(a.name, 0));
    // the arrow keys are the slider's own; keep them away from the simulation's key set
    range.addEventListener('keydown', (e) => e.stopPropagation());
    const reset = h('button', { class: 'ctl-reset', type: 'button', title: `Set ${a.name} to zero` }, '0');
    reset.addEventListener('click', () => this.setAxis(a.name, 0));
    const row = h(
      'div',
      { class: 'ctl-row', title: a.uses.map(describeUse).join('\n') },
      h('label', { class: 'ctl-name', for: range.id }, a.name),
      range,
      out,
      reset,
    );
    this.setAxis(a.name, this.axisValues.get(a.name) ?? 0);
    return row;
  }

  private keyCap(k: KeyControl): HTMLElement {
    const btn = h(
      'button',
      { class: 'ctl-key', type: 'button', 'aria-pressed': 'false', title: k.uses.map(describeUse).join('\n') },
      h('kbd', null, keyLabel(k.code)),
      h('span', { class: 'ctl-key-what' }, [...new Set(k.uses.map((u) => u.fieldLabel))].join(' · ')),
    );
    this.keyButtons.set(k.code, btn);
    const press = () => {
      if (!this.app.sim.active) return;
      this.app.sim.keys.add(k.code);
      this.syncKeys();
    };
    const release = () => {
      this.app.sim.keys.delete(k.code);
      this.syncKeys();
    };
    btn.addEventListener('pointerdown', (e) => {
      btn.setPointerCapture(e.pointerId);
      press();
    });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Space / Enter press the cap, they are not the simulation's keys
      if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) press();
    });
    btn.addEventListener('keyup', (e) => {
      e.stopPropagation();
      if (e.code === 'Space' || e.code === 'Enter') release();
    });
    btn.addEventListener('blur', release);
    return btn;
  }

  private syncKeys(): void {
    for (const [code, btn] of this.keyButtons) {
      const on = this.app.sim.keys.has(code);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  private syncEnabled(): void {
    const active = this.app.sim.active;
    this.el.classList.toggle('idle', !active);
    for (const { range } of this.sliders.values()) range.disabled = !active;
    for (const b of this.keyButtons.values()) b.disabled = !active;
    for (const b of this.axisBox.querySelectorAll<HTMLButtonElement>('.ctl-reset')) b.disabled = !active;
    const any = this.keyButtons.size + this.sliders.size > 0;
    this.hint.textContent = !any
      ? 'Add a component with a key or an axis (an engine, a servo, a thruster …) and its controls appear here.'
      : active
        ? 'Hold a key cap or drag a slider; the keyboard works too.'
        : 'Press Play to use these controls.';
  }
}

/** The Controls tab of the telemetry dock. */
export const controlsPanel: PanelDef = {
  id: 'controls',
  label: 'Controls',
  icon: 'sliders',
  region: 'bottom',
  order: 30,
  title: 'The keys and analog axes (throttle, steering, collective …) that this scene listens to',
  build(app) {
    const view = new ControlsView(app);
    return { el: view.el };
  },
};

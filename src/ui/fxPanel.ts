/**
 * The Effects panel (right region): the switches and budgets of the visual effects, a preview strip, and a live
 * status line. The panel is a list of sections from a small registry, so the audio and feedback settings of later
 * packages add their own sections with `registerFxPanelSection` instead of editing this file.
 *
 * Everything shown is real: the toggles are `Prefs.fx` (persisted, validated on load), the previews fire the real
 * effects at the point the camera looks at, the status line reads the live particle pools.
 */
import type { PanelContext, PanelView } from '../app/registry/panels';
import type { App } from '../app/app';
import { Registry } from '../core/registry';
import type { FxQuality, FxSettings } from '../render/fx';
import { FX_INTENSITY_RANGE, resolveTier } from '../render/fx';
import { button, row, section, selectField, sliderField, toggleField } from './controls';
import { h } from './dom';

export interface FxPanelSection {
  id: string;
  /** Sections are sorted by this. */
  order: number;
  /** Build the section's DOM once. `update` runs on every preference change and about four times a second while the tab is visible. */
  build: (app: App) => { el: HTMLElement; update?: () => void };
}

export const fxPanelSections = new Registry<FxPanelSection>({
  kind: 'effects panel section',
  order: (s) => s.order,
  validate(s) {
    if (typeof s.build !== 'function') throw new Error(`effects panel section "${s.id}" needs a build() function`);
    if (!Number.isFinite(s.order)) throw new Error(`effects panel section "${s.id}" needs a numeric order`);
  },
});

export const registerFxPanelSection = (s: FxPanelSection): (() => void) => fxPanelSections.register(s);

// -- the particle-effects sections -------------------------------------------------------------------------------

const QUALITY_OPTIONS: { value: FxQuality; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const KINDS: { key: keyof FxSettings; label: string; hint: string }[] = [
  {
    key: 'impacts',
    label: 'Impact sparks & dust',
    hint: 'Sparks, dust, chips, shards and scuffs from collisions, scaled by the real impact energy',
  },
  {
    key: 'trails',
    label: 'Dust trails & tyre smoke',
    hint: 'Smoke from slipping wheels and dust behind fast bodies on the ground',
  },
  {
    key: 'skidMarks',
    label: 'Skid marks',
    hint: 'Persistent marks on the ground from slipping wheels and sliding bodies (cleared on Reset)',
  },
  {
    key: 'explosions',
    label: 'Explosions',
    hint: 'Fireball, shock ring, embers, smoke and a light flash for the Blast tool and hard projectile hits',
  },
  {
    key: 'debris',
    label: 'Debris chips',
    hint: 'Chunks that fly from very hard hits on brittle materials (glass, concrete, wood, ice)',
  },
  {
    key: 'physicalDebris',
    label: 'Physical debris bodies',
    hint: 'Also throw a few real rigid fragments from those hits. They collide, are capped by the quality tier and are removed after a few seconds. Runs with them are not reproducible frame for frame.',
  },
];

const PREVIEWS: { kind: Parameters<App['fxDirector']['preview']>[0]; label: string; title: string }[] = [
  { kind: 'sparks', label: 'Sparks', title: 'Steel hitting the ground' },
  { kind: 'dust', label: 'Dust', title: 'Concrete hitting the ground' },
  { kind: 'glass', label: 'Glass', title: 'Glass shattering on the ground' },
  { kind: 'tyre', label: 'Tyre smoke', title: 'A cloud of tyre smoke' },
  { kind: 'explosion', label: 'Explosion', title: 'A blast of radius 5 m' },
];

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

function masterSection(app: App) {
  const d = app.fxDirector;
  const on = toggleField({
    label: 'Visual effects',
    title:
      'Master switch: off means nothing is emitted, drawn or tracked, and the physics sends no contact events for the effects',
    onChange: (v) => d.setSettings({ enabled: v }),
  });
  const quality = selectField<FxQuality>({ options: QUALITY_OPTIONS, onChange: (v) => d.setSettings({ quality: v }) });
  const tierHint = h('p', { class: 'hint-text' });
  const intensity = sliderField({
    min: FX_INTENSITY_RANGE.min,
    max: FX_INTENSITY_RANGE.max,
    step: 0.05,
    digits: 2,
    unit: '×',
    onChange: (v) => d.setSettings({ intensity: v }),
  });
  const off = h(
    'p',
    { class: 'hint-text fx-off-note' },
    'Effects are off. Impacts, trails, skid marks and explosions are not drawn; the Blast tool shows its plain shock wave.',
  );
  const el = section(
    'Visual effects',
    [
      on.el,
      off,
      h(
        'div',
        { class: 'fx-dim-inner' },
        row('Quality', quality.el, 'Auto follows the graphics quality of the View menu'),
        tierHint,
        row('Intensity', intensity.el, 'Scales particle counts and sizes'),
      ),
    ],
    {
      id: 'fx-master',
    },
  );
  const update = () => {
    const s = app.prefs.value.fx;
    on.set(s.enabled);
    quality.set(s.quality);
    intensity.set(s.intensity);
    const tier = resolveTier(s.quality, app.prefs.value.quality);
    tierHint.textContent = `${s.quality === 'auto' ? `Auto → ${tier.label}` : tier.label}: ${tier.blurb}.`;
    el.classList.toggle('fx-disabled', !s.enabled);
  };
  return { el, update };
}

function kindsSection(app: App) {
  const d = app.fxDirector;
  const fields = KINDS.map((k) => {
    const f = toggleField({ label: k.label, title: k.hint, onChange: (v) => d.setSettings({ [k.key]: v }) });
    return { k, f, hint: h('p', { class: 'hint-text fx-kind-hint' }, k.hint) };
  });
  const el = section(
    'Effects',
    fields.flatMap(({ f, hint }) => [f.el, hint]),
    { id: 'fx-kinds' },
  );
  el.classList.add('fx-dim');
  const update = () => {
    const s = app.prefs.value.fx;
    for (const { k, f } of fields) f.set(!!s[k.key]);
    el.classList.toggle('fx-disabled', !s.enabled);
    // Physical debris needs the visual chips' source events, but works on its own; nothing else depends on another switch.
  };
  return { el, update };
}

function previewSection(app: App) {
  const d = app.fxDirector;
  const buttons = PREVIEWS.map((p) =>
    button(
      p.label,
      () => {
        if (!d.preview(p.kind)) {
          app.toast('Visual effects are switched off — turn them on in this panel to preview.', 'warn');
          return;
        }
        if (app.sim.mode === 'paused')
          app.toast('The simulation is paused: effects play when it resumes (Space).', 'info');
      },
      { cls: 'small', title: `${p.title}, where the camera looks` },
    ),
  );
  const clear = button(
    'Clear skid marks',
    () => {
      const n = app.fx.stats.skidSegments;
      app.fx.clearSkidMarks();
      app.toast(n ? 'Skid marks cleared.' : 'There are no skid marks to clear.', 'info');
    },
    { icon: 'trash', cls: 'small', title: 'Remove every skid mark from the ground' },
  );
  const el = section(
    'Preview',
    [
      h('div', { class: 'fx-previews' }, buttons),
      h(
        'p',
        { class: 'hint-text' },
        'Fires the real effect on the ground where the camera looks. Skid marks and explosions in a running simulation come from the physics.',
      ),
      h('div', { class: 'fx-previews' }, clear),
    ],
    { id: 'fx-preview' },
  );
  el.classList.add('fx-dim');
  return { el, update: () => el.classList.toggle('fx-disabled', !app.prefs.value.fx.enabled) };
}

function statusSection(app: App) {
  const line = (label: string) => {
    const v = h('span', { class: 'fx-stat-v' }, '—');
    return { el: h('div', { class: 'fx-stat' }, h('span', { class: 'fx-stat-l' }, label), v), v };
  };
  const particles = line('Particles');
  const bar = h('div', { class: 'fx-bar' }, h('div', { class: 'fx-bar-fill' }));
  const marks = line('Skid-mark segments');
  const fragments = line('Physical fragments');
  const contacts = line('Contact events');
  const el = section('Status', [particles.el, bar, marks.el, fragments.el, contacts.el], {
    id: 'fx-status',
    open: false,
  });
  const fill = bar.firstElementChild as HTMLElement;
  const update = () => {
    const s = app.fxDirector.stats;
    particles.v.textContent = `${fmtInt(s.live)} / ${fmtInt(s.budget)}`;
    fill.style.width = `${Math.min(100, (s.live / s.budget) * 100).toFixed(1)}%`;
    marks.v.textContent = fmtInt(s.skidSegments);
    fragments.v.textContent = fmtInt(s.fragments);
    contacts.v.textContent = s.contactsWatched ? 'on' : 'off';
  };
  return { el, update };
}

const BUILTIN: FxPanelSection[] = [
  { id: 'master', order: 10, build: masterSection },
  { id: 'kinds', order: 20, build: kindsSection },
  { id: 'preview', order: 30, build: previewSection },
  { id: 'status', order: 90, build: statusSection },
];

let builtinsDone = false;
export function registerFxPanelBuiltins(): void {
  if (builtinsDone) return;
  builtinsDone = true;
  for (const s of BUILTIN) fxPanelSections.register(s);
}

// -- the panel ---------------------------------------------------------------------------------------------------

export function buildFxPanel(app: App, ctx: PanelContext): PanelView {
  registerFxPanelBuiltins();
  const el = h('div', { class: 'panel-body fx-panel' });
  const built = new Map<string, { el: HTMLElement; update?: () => void }>();
  const render = () => {
    el.replaceChildren(
      ...fxPanelSections.list().map((s) => {
        let b = built.get(s.id);
        if (!b) built.set(s.id, (b = s.build(app)));
        return b.el;
      }),
    );
    update();
  };
  const update = () => {
    for (const b of built.values()) b.update?.();
  };
  fxPanelSections.onChange(render);
  app.prefs.on('change', (keys) => {
    if (keys.includes('fx') || keys.includes('quality')) update();
  });
  let acc = 0;
  app.on('frame', ({ dt }) => {
    acc += dt;
    if (acc < 0.25 || !ctx.active()) return;
    acc = 0;
    update();
  });
  render();
  return { el, onShow: update };
}

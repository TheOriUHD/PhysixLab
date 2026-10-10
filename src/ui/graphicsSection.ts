/**
 * The "Graphics" section of the World tab (VZ-22): quality tier (Auto / Low … Ultra) with the live governor readout,
 * anti-aliasing, resolution scale, shadows, instancing, and every post effect (VZ-20 / VZ-21) with its tier-follow
 * switch (Auto / On / Off) and its parameters. Everything is a per-user preference (`prefs.graphics`).
 */
import type { App } from '../app/app';
import {
  AA_MODES,
  DEFAULT_GRAPHICS,
  QUALITY_CHOICES,
  cloneGraphics,
  type AAMode,
  type EffectId,
  type GraphicsOptions,
  type QualityChoice,
} from '../render/graphics';
import type { HighlightOptions } from '../render/highlight';
import { button, row, section, selectField, sliderField, toggleField, type Field } from './controls';
import { h } from './dom';

type Tri = 'auto' | 'on' | 'off';
const triOf = (v: boolean | null): Tri => (v === null ? 'auto' : v ? 'on' : 'off');
const fromTri = (v: Tri): boolean | null => (v === 'auto' ? null : v === 'on');

const QUALITY_LABELS: Record<QualityChoice, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
};

interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  digits: number;
  unit?: string;
  hint?: string;
}

interface EffectSpec {
  id: EffectId;
  label: string;
  hint: string;
  params: ParamSpec[];
}

const EFFECTS: EffectSpec[] = [
  {
    id: 'ao',
    label: 'Ambient occlusion',
    hint: 'Ground-truth AO (GTAO): darkens creases and contact areas. Default: High and up.',
    params: [
      { key: 'radius', label: 'Radius', min: 0.1, max: 3, step: 0.05, digits: 2, unit: 'm' },
      { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, digits: 2 },
    ],
  },
  {
    id: 'bloom',
    label: 'Bloom',
    hint: 'Bright areas glow. Only HDR highlights above the threshold bloom, so a dull scene stays crisp. Default: High and up.',
    params: [
      { key: 'threshold', label: 'Threshold', min: 0, max: 3, step: 0.05, digits: 2 },
      { key: 'strength', label: 'Strength', min: 0, max: 3, step: 0.05, digits: 2 },
      { key: 'radius', label: 'Radius', min: 0, max: 1, step: 0.01, digits: 2 },
    ],
  },
  {
    id: 'ssr',
    label: 'Screen-space reflections',
    hint: 'Glossy and metallic bodies reflect what is on screen. Default: Ultra only (expensive).',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, digits: 2 },
      { key: 'maxDistance', label: 'Reach', min: 1, max: 100, step: 1, digits: 0, unit: 'm' },
    ],
  },
  {
    id: 'godRays',
    label: 'Light shafts',
    hint: 'Volumetric shafts from the sun and spotlights (screen-space). Default: Ultra only.',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 2, step: 0.05, digits: 2 },
      { key: 'decay', label: 'Decay', min: 0.8, max: 0.99, step: 0.005, digits: 3 },
    ],
  },
  {
    id: 'dof',
    label: 'Depth of field',
    hint: 'Blur everything away from the focus distance. Off unless you turn it on.',
    params: [
      { key: 'aperture', label: 'Blur amount', min: 0, max: 1, step: 0.01, digits: 2 },
      { key: 'maxBlur', label: 'Max blur', min: 1, max: 32, step: 1, digits: 0, unit: 'px' },
    ],
  },
  {
    id: 'motionBlur',
    label: 'Motion blur',
    hint: 'Streaks along camera and object motion (velocity buffer: translation of bodies, not their spin). Default: Ultra only.',
    params: [{ key: 'strength', label: 'Strength', min: 0, max: 2, step: 0.05, digits: 2 }],
  },
  {
    id: 'vignette',
    label: 'Vignette',
    hint: 'Darkens the corners. Default: Medium and up.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, digits: 2 },
      { key: 'softness', label: 'Softness', min: 0.1, max: 1, step: 0.01, digits: 2 },
    ],
  },
  {
    id: 'aberration',
    label: 'Chromatic aberration',
    hint: 'Colour fringes towards the screen edge. Off unless you turn it on.',
    params: [{ key: 'amount', label: 'Amount', min: 0, max: 0.02, step: 0.0005, digits: 4 }],
  },
  {
    id: 'grain',
    label: 'Film grain',
    hint: 'Animated noise. Off unless you turn it on.',
    params: [{ key: 'amount', label: 'Amount', min: 0, max: 0.3, step: 0.005, digits: 3 }],
  },
  {
    id: 'grading',
    label: 'Colour grading',
    hint: 'Exposure, contrast, saturation and warmth, applied in linear light before tone mapping.',
    params: [
      { key: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.05, digits: 2, unit: 'EV' },
      { key: 'contrast', label: 'Contrast', min: 0.5, max: 1.8, step: 0.01, digits: 2 },
      { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, digits: 2 },
      { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, digits: 2 },
    ],
  },
];

export interface GraphicsSection {
  el: HTMLElement;
  refresh: () => void;
}

export function buildGraphicsSection(app: App): GraphicsSection {
  const upd: (() => void)[] = [];
  const cur = (): GraphicsOptions => app.prefs.value.graphics;
  const write = (mut: (g: GraphicsOptions) => void): void => {
    const g = cloneGraphics(cur());
    mut(g);
    app.prefs.set({ graphics: g });
  };

  // ---- quality + status --------------------------------------------------------------------------------------
  const quality = selectField<QualityChoice>({
    options: QUALITY_CHOICES.map((q) => ({ value: q, label: QUALITY_LABELS[q] })),
    onChange: (v) => app.prefs.set({ quality: v }),
  });
  upd.push(() => quality.set(app.prefs.value.quality));
  const status = h('div', { class: 'gfx-status hint' });
  const updateStatus = () => {
    const i = app.viewport.graphicsInfo;
    const base = `In force: ${i.tier[0].toUpperCase()}${i.tier.slice(1)} · pixel ratio ${i.pixelRatio.toFixed(2)}`;
    status.textContent = i.auto
      ? `${base} · GPU probe: ${i.probe}${i.frameMs ? ` · ${i.frameMs.toFixed(1)} ms/frame` : ''}`
      : base;
  };
  upd.push(updateStatus);

  const aa = selectField<AAMode | 'auto'>({
    options: [
      { value: 'auto', label: 'Auto (by tier)' },
      ...AA_MODES.map((m) => ({ value: m, label: { none: 'Off', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' }[m] })),
    ],
    onChange: (v) => write((g) => (g.aa = v)),
  });
  upd.push(() => aa.set(cur().aa));

  const scale = sliderField({
    unit: '×',
    min: 0.5,
    max: 1,
    step: 0.05,
    digits: 2,
    onChange: (v) => write((g) => (g.resolutionScale = v)),
  });
  upd.push(() => scale.set(cur().resolutionScale));

  const shadows = selectField<Tri>({
    options: [
      { value: 'auto', label: 'Auto (off on Low)' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
    onChange: (v) => write((g) => (g.shadows.enabled = fromTri(v))),
  });
  upd.push(() => shadows.set(triOf(cur().shadows.enabled)));
  const shadowRes = selectField<string>({
    options: [
      { value: 'auto', label: 'Auto (by tier)' },
      ...[1024, 2048, 4096, 8192].map((r) => ({ value: String(r), label: `${r} px` })),
    ],
    onChange: (v) =>
      write((g) => (g.shadows.resolution = v === 'auto' ? 'auto' : (Number(v) as 1024 | 2048 | 4096 | 8192))),
  });
  upd.push(() => shadowRes.set(String(cur().shadows.resolution)));
  const softness = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    onChange: (v) => write((g) => (g.shadows.softness = v)),
  });
  upd.push(() => softness.set(cur().shadows.softness));

  const instancing = toggleField({
    label: 'Instanced rendering',
    title: 'Identical bodies share one draw call (8 or more of the same shape and material)',
    onChange: (v) => write((g) => (g.instancing = v)),
  });
  upd.push(() => instancing.set(cur().instancing));

  const lod = toggleField({
    label: 'Level of detail',
    title: 'Small or distant spheres, cylinders, cones and capsules use fewer triangles',
    onChange: (v) => write((g) => (g.lod = v)),
  });
  upd.push(() => lod.set(cur().lod));

  const reset = button(
    'Reset graphics',
    () => {
      app.prefs.set({ graphics: cloneGraphics(DEFAULT_GRAPHICS), quality: 'auto' });
    },
    { title: 'Back to Auto quality with every effect following its tier', cls: 'gfx-reset' },
  );

  // ---- effects -----------------------------------------------------------------------------------------------------
  const effectRows: HTMLElement[] = [];
  for (const fx of EFFECTS) {
    const tri = selectField<Tri>({
      options: [
        { value: 'auto', label: 'Auto (by tier)' },
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
      onChange: (v) => write((g) => (g[fx.id].on = fromTri(v))),
    });
    upd.push(() => tri.set(triOf(cur()[fx.id].on)));
    const body: HTMLElement[] = [row('Enabled', tri.el, fx.hint)];
    const fields: Field<number>[] = [];
    for (const p of fx.params) {
      const f = sliderField({
        min: p.min,
        max: p.max,
        step: p.step,
        digits: p.digits,
        unit: p.unit,
        onChange: (v) => write((g) => ((g[fx.id] as unknown as Record<string, number>)[p.key] = v)),
      });
      fields.push(f);
      body.push(row(p.label, f.el, p.hint ?? `${fx.label}: ${p.label.toLowerCase()}`));
      upd.push(() => f.set((cur()[fx.id] as unknown as Record<string, number>)[p.key]));
    }
    if (fx.id === 'dof') body.push(...focusControls(app, write, upd));
    const el = section(fx.label, body, { id: `gfx-${fx.id}`, open: false });
    const badge = h('span', { class: 'badge' }, '');
    el.querySelector('.section-head')?.append(badge);
    upd.push(() => {
      const on = app.viewport.resolvedGraphics[fx.id] !== null;
      badge.textContent = on ? 'on' : 'off';
      badge.classList.toggle('on', on);
    });
    effectRows.push(el);
  }

  // ---- selection highlight (VZ-40) ---------------------------------------------------------------------------
  const hl = (): HighlightOptions => app.prefs.value.highlight;
  const setHl = (patch: Partial<HighlightOptions>) => app.prefs.set({ highlight: { ...hl(), ...patch } });
  const palette = selectField<HighlightOptions['palette']>({
    options: [
      { value: 'default', label: 'Default' },
      { value: 'colorblind', label: 'Colour-blind safe' },
    ],
    onChange: (v) => setHl({ palette: v }),
  });
  upd.push(() => palette.set(hl().palette));
  const toggles = (
    [
      ['pulse', 'Pulse the selection outline', 'The outline breathes slowly'],
      ['bbox', 'Bounding box', 'Box around every selected body'],
      ['axes', 'Axis triad', 'Local axes of every selected body'],
      ['linked', 'Highlight linked bodies', 'Select a joint and the bodies it connects glow'],
    ] as const
  ).map(([key, label, title]) => {
    const t = toggleField({ label, title, onChange: (v) => setHl({ [key]: v }) });
    upd.push(() => t.set(hl()[key]));
    return t.el;
  });
  const highlight = section(
    'Selection highlight',
    [
      row(
        'Palette',
        palette.el,
        'Outline colours; the colour-blind-safe set keeps selection, hover, multi-selection and linked apart',
      ),
      ...toggles,
    ],
    {
      id: 'gfx-highlight',
      open: false,
    },
  );

  const dmgOn = toggleField({
    label: 'Impact damage',
    title:
      'Hard hits crack, scorch and dent surfaces (metal dents, glass cracks, wood splinters); resets with the simulation',
    onChange: (v) => app.prefs.set({ damage: { ...app.prefs.value.damage, enabled: v } }),
  });
  upd.push(() => dmgOn.set(app.prefs.value.damage.enabled));
  const dmgSens = sliderField({
    min: 0.25,
    max: 4,
    step: 0.05,
    digits: 2,
    unit: '×',
    log: true,
    onChange: (v) => app.prefs.set({ damage: { ...app.prefs.value.damage, sensitivity: v } }),
  });
  upd.push(() => dmgSens.set(app.prefs.value.damage.sensitivity));
  const damage = section(
    'Damage visuals',
    [dmgOn.el, row('Sensitivity', dmgSens.el, 'How quickly impacts damage surfaces')],
    {
      id: 'gfx-damage',
      open: false,
    },
  );

  const el = section(
    'Graphics',
    [
      row(
        'Quality',
        quality.el,
        'Auto probes the GPU and lowers or raises the tier and resolution to hold the frame rate',
      ),
      status,
      row('Anti-aliasing', aa.el, 'MSAA smooths geometry edges; FXAA / SMAA are post-process filters'),
      row('Resolution', scale.el, 'Scale of the render resolution relative to the screen (Auto lowers it under load)'),
      row('Shadows', shadows.el, 'Sun shadows; Auto turns them off only on the Low tier'),
      row('Shadow map', shadowRes.el, 'Resolution of the sun shadow map: sharper shadows, more GPU memory'),
      row('Soft edges', softness.el, 'Blur radius of shadow edges'),
      instancing.el,
      lod.el,
      ...effectRows,
      highlight,
      damage,
      h('div', { class: 'gfx-reset-row' }, reset),
    ],
    { id: 'world-graphics' },
  );

  const refresh = () => upd.forEach((u) => u());
  app.prefs.on('change', (keys) => {
    if (keys.includes('graphics') || keys.includes('quality')) refresh();
  });
  // The governor's state changes without any preference changing: keep the readout live while it is on screen.
  window.setInterval(() => {
    if (el.isConnected && el.classList.contains('open')) {
      updateStatus();
    }
  }, 600);
  refresh();
  return { el, refresh };
}

/** Focus mode + "pick focus point" for depth of field (the click is taken from the viewport once). */
function focusControls(app: App, write: (m: (g: GraphicsOptions) => void) => void, upd: (() => void)[]): HTMLElement[] {
  const mode = selectField<'target' | 'manual'>({
    options: [
      { value: 'target', label: 'Orbit target' },
      { value: 'manual', label: 'Fixed distance' },
    ],
    onChange: (v) => write((g) => (g.dof.focusMode = v)),
  });
  upd.push(() => mode.set(app.prefs.value.graphics.dof.focusMode));
  const dist = sliderField({
    min: 0.3,
    max: 200,
    step: 0.1,
    digits: 1,
    unit: 'm',
    log: true,
    onChange: (v) => write((g) => ((g.dof.focusMode = 'manual'), (g.dof.focusDistance = v))),
  });
  upd.push(() => dist.set(app.prefs.value.graphics.dof.focusDistance));
  let picking = false;
  const pick = button('Pick focus point', () => start(), { title: 'Click anything in the viewport to focus on it' });
  const finish = () => {
    picking = false;
    pick.classList.remove('active');
    app.viewport.dom.style.cursor = '';
  };
  const start = () => {
    if (picking) return finish();
    picking = true;
    pick.classList.add('active');
    app.viewport.dom.style.cursor = 'crosshair';
    app.viewport.dom.addEventListener(
      'pointerdown',
      (e) => {
        if (!picking) return;
        e.stopPropagation();
        e.preventDefault();
        const hit = app.pickEntity(e);
        let d = hit?.distance;
        if (d === undefined) {
          const p = app.picker.groundPoint(e);
          if (p) d = p.distanceTo(app.camera.position);
        }
        if (d !== undefined) {
          const distance = Math.max(0.3, Math.min(200, d));
          write((g) => {
            g.dof.on = true;
            g.dof.focusMode = 'manual';
            g.dof.focusDistance = distance;
          });
          app.toast(`Focus set to ${distance.toFixed(1)} m`, 'success');
        }
        finish();
      },
      { capture: true, once: true },
    );
  };
  return [row('Focus on', mode.el), row('Distance', dist.el), row('Pick', pick)];
}

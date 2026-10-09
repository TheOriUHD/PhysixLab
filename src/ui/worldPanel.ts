import type { App } from '../app/app';
import {
  colorField,
  numberField,
  row,
  rowStack,
  section,
  selectField,
  sliderField,
  toggleField,
  vec3Field,
} from './controls';
import { h } from './dom';

const GRAVITY_PRESETS: { id: string; label: string; g: number }[] = [
  { id: 'earth', label: 'Earth — 9.81 m/s²', g: 9.81 },
  { id: 'moon', label: 'Moon — 1.62 m/s²', g: 1.62 },
  { id: 'mars', label: 'Mars — 3.71 m/s²', g: 3.71 },
  { id: 'jupiter', label: 'Jupiter — 24.79 m/s²', g: 24.79 },
  { id: 'zero', label: 'Zero gravity', g: 0 },
];

/** Scene-wide physics + environment settings. */
export function buildWorldPanel(app: App): HTMLElement {
  const { store } = app;
  const el = h('div', { class: 'panel-body' });
  const upd: (() => void)[] = [];
  const set = (patch: Parameters<typeof store.updateSettings>[0], label: string) => store.updateSettings(patch, label);
  const grouped = (label: string) => ({ onStart: () => store.begin(label), onEnd: () => store.end() });

  // gravity
  const preset = selectField<string>({
    options: [
      ...GRAVITY_PRESETS.map((p) => ({ value: p.id, label: p.label })),
      { value: 'custom', label: 'Custom vector' },
    ],
    onChange: (v) => {
      const p = GRAVITY_PRESETS.find((x) => x.id === v);
      if (p) set({ gravity: [0, -p.g, 0] }, `Gravity: ${p.label}`);
    },
  });
  const gvec = vec3Field({
    step: 0.1,
    digits: 2,
    ...grouped('Edit gravity'),
    onChange: (v) => set({ gravity: v }, 'Edit gravity'),
  });
  upd.push(() => {
    const g = store.settings.gravity;
    gvec.set(g);
    const match = g[0] === 0 && g[2] === 0 ? GRAVITY_PRESETS.find((p) => Math.abs(-g[1] - p.g) < 1e-6) : undefined;
    preset.set(match ? match.id : 'custom');
  });

  const gr = (patch: Partial<typeof store.settings.ground>, label: string) =>
    set({ ground: { ...store.settings.ground, ...patch } }, label);
  const gEnabled = toggleField({ label: 'Ground plane', onChange: (v) => gr({ enabled: v }, 'Toggle ground') });
  const gFric = sliderField({
    min: 0,
    max: 2,
    step: 0.01,
    digits: 2,
    ...grouped('Ground friction'),
    onChange: (v) => gr({ friction: v }, 'Ground friction'),
  });
  const gRest = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    ...grouped('Ground bounciness'),
    onChange: (v) => gr({ restitution: v }, 'Ground bounciness'),
  });
  const gSize = numberField({
    step: 5,
    min: 5,
    max: 1000,
    unit: 'm',
    digits: 0,
    ...grouped('Ground size'),
    onChange: (v) => gr({ halfSize: v / 2 }, 'Ground size'),
  });
  const gColor = colorField({ ...grouped('Ground colour'), onChange: (v) => gr({ color: v }, 'Ground colour') });
  upd.push(() => {
    const g = store.settings.ground;
    gEnabled.set(g.enabled);
    gFric.set(g.friction);
    gRest.set(g.restitution);
    gSize.set(g.halfSize * 2);
    gColor.set(g.color);
  });

  const drag = sliderField({
    min: 0.001,
    max: 5,
    log: true,
    digits: 3,
    unit: '1/s',
    ...grouped('Air drag'),
    onChange: (v) => set({ airDrag: v < 0.0011 ? 0 : v }, 'Air drag'),
  });
  upd.push(() => drag.set(Math.max(0.001, store.settings.airDrag)));

  const hz = selectField<string>({
    options: [
      { value: '60', label: '60 Hz — fast' },
      { value: '120', label: '120 Hz — balanced' },
      { value: '240', label: '240 Hz — precise' },
      { value: '480', label: '480 Hz — extreme' },
    ],
    onChange: (v) => set({ physicsHz: Number(v) }, 'Physics rate'),
  });
  const iters = sliderField({
    min: 1,
    max: 32,
    step: 1,
    digits: 0,
    ...grouped('Solver iterations'),
    onChange: (v) => set({ solverIterations: Math.round(v) }, 'Solver iterations'),
  });
  upd.push(() => {
    hz.set(String(store.settings.physicsHz));
    iters.set(store.settings.solverIterations);
  });

  el.append(
    section('Gravity', [row('Preset', preset.el), rowStack('Vector (m/s²)', gvec.el)], { id: 'world-gravity' }),
    section(
      'Ground',
      [
        gEnabled.el,
        row('Friction', gFric.el),
        row('Bounciness', gRest.el),
        row('Size', gSize.el),
        row('Colour', gColor.el),
        h(
          'p',
          { class: 'hint-text' },
          'Objects that fall off the edge keep falling and are switched off far below. Pair friction is the average of the two surfaces; pair bounciness is the larger of the two.',
        ),
      ],
      { id: 'world-ground' },
    ),
    section(
      'Air',
      [
        row('Drag', drag.el, 'Extra linear damping applied to every dynamic body'),
        h('p', { class: 'hint-text' }, 'Slide fully left for a vacuum.'),
      ],
      { id: 'world-air' },
    ),
    section(
      'Solver',
      [
        row('Step rate', hz.el),
        row('Iterations', iters.el),
        h(
          'p',
          { class: 'hint-text' },
          'Higher rates and iteration counts make stacks, fast bodies and long joint chains more accurate, at a cost per step. Very large mass ratios across joints (e.g. a 1 kg link carrying a 1000 kg weight) need more iterations.',
        ),
      ],
      { id: 'world-solver' },
    ),
  );
  const refresh = () => upd.forEach((u) => u());
  store.on('change', refresh);
  refresh();
  return el;
}

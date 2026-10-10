/**
 * JT-B inspector sections for rigid bodies: collision layer + accepted layers + one-way platform (JT-30 / JT-31),
 * aerodynamic drag with a Cd·A·ρ helper (JT-32), mass / centre of mass / inertia overrides with the viewport handle
 * (JT-33) and the sleep threshold with a "wake all" button (JT-34).
 */
import type { Vec3 } from '../../core/math';
import { layerNames, effectiveMask } from '../../model/collisionLayers';
import { massEstimate } from '../../model/compound';
import { ALL_GROUPS } from '../../model/factory';
import { frontalArea, quadraticDragCoefficient, terminalSpeed } from '../../model/drag';
import type { BodyEntity } from '../../model/types';
import { button, fmt, numberField, row, rowStack, section, selectField, toggleField, vec3Field } from '../controls';
import { h } from '../dom';
import type { InspectorContext } from './shared';

const DIRS: { value: string; label: string; v: Vec3 }[] = [
  { value: '+y', label: 'Up (+Y)', v: [0, 1, 0] },
  { value: '-y', label: 'Down (−Y)', v: [0, -1, 0] },
  { value: '+x', label: '+X', v: [1, 0, 0] },
  { value: '-x', label: '−X', v: [-1, 0, 0] },
  { value: '+z', label: '+Z', v: [0, 0, 1] },
  { value: '-z', label: '−Z', v: [0, 0, -1] },
];
const dirKey = (v: Vec3 | undefined): string =>
  DIRS.find((d) => v && Math.abs(d.v[0] - v[0]) + Math.abs(d.v[1] - v[1]) + Math.abs(d.v[2] - v[2]) < 1e-6)?.value ??
  'custom';

export function bodyJtSections(ctx: InspectorContext, sel: BodyEntity[]): HTMLElement[] {
  const { app } = ctx;
  const ids = sel.map((b) => b.id);
  const multi = sel.length > 1;
  const cur = (): BodyEntity[] => ids.map((id) => app.store.body(id)).filter((b): b is BodyEntity => !!b);
  const first = (): BodyEntity => cur()[0];
  const edit = (label: string, fn: (b: BodyEntity) => Partial<BodyEntity>) => ctx.edit<BodyEntity>(ids, label, fn);
  const allDynamic = () => cur().every((b) => b.bodyType === 'dynamic');
  const out: HTMLElement[] = [];

  // ---- collision layers + one-way platform -----------------------------------------------------------------
  const names = () => layerNames(app.store.settings.layers);
  const layerSel = selectField<string>({
    options: names().map((n, i) => ({ value: String(i), label: `${i} · ${n}` })),
    onChange: (v) => edit('Set collision layer', (b) => ({ collision: { ...b.collision, group: Number(v) } })),
  });
  const chips: HTMLButtonElement[] = [];
  const grid = h('div', { class: 'mask-grid' });
  for (let i = 0; i < 16; i++) {
    const c = h('button', { class: 'chip', type: 'button' }, String(i));
    c.addEventListener('click', () => {
      const on = ((first().collision.mask >> i) & 1) === 1;
      edit('Edit accepted layers', (b) => ({
        collision: { ...b.collision, mask: on ? b.collision.mask & ~(1 << i) : b.collision.mask | (1 << i) },
      }));
    });
    chips.push(c);
    grid.appendChild(c);
  }
  const setMask = (mask: number) => edit('Edit accepted layers', (b) => ({ collision: { ...b.collision, mask } }));
  const maskButtons = h(
    'div',
    { class: 'chips' },
    button('All', () => setMask(ALL_GROUPS), { cls: 'small', title: 'Accept every layer' }),
    button('None', () => setMask(0), { cls: 'small', title: 'Accept no layer: this body collides with nothing' }),
  );
  const maskHint = h('p', { class: 'hint-text' });
  ctx.updaters.push(() => {
    const b = first();
    if (!b) return;
    const layers = app.store.settings.layers;
    const nm = names();
    const sel0 = layerSel.el.querySelector('select');
    if (sel0) {
      sel0.replaceChildren(
        ...nm.map((n, i) => {
          const o = document.createElement('option');
          o.value = String(i);
          o.textContent = `${i} · ${n}`;
          return o;
        }),
      );
    }
    layerSel.set(String(b.collision.group));
    const eff = effectiveMask(b.collision, layers);
    chips.forEach((c, i) => {
      c.classList.toggle('on', ((b.collision.mask >> i) & 1) === 1);
      const blocked = ((b.collision.mask >> i) & 1) === 1 && ((eff >> i) & 1) === 0;
      c.title = `${nm[i]}${blocked ? ' — switched off in the World tab matrix' : ''}`;
      c.style.opacity = blocked ? '0.45' : '';
    });
    maskHint.textContent =
      eff === (b.collision.mask & ALL_GROUPS)
        ? 'Layers this body collides with (the other body must accept this layer too).'
        : 'Faded layers are accepted here but switched off in the World tab matrix.';
  });
  const oneWay = toggleField({
    label: 'One-way platform',
    title: 'Other bodies pass through from the back and land on the solid side',
    onChange: (v) => edit('Toggle one-way platform', () => ({ oneWay: v ? ([0, 1, 0] as Vec3) : undefined })),
  });
  const dirSel = selectField<string>({
    options: [...DIRS.map((d) => ({ value: d.value, label: d.label })), { value: 'custom', label: 'Custom' }],
    onChange: (v) => {
      const d = DIRS.find((x) => x.value === v);
      if (d) edit('Set platform direction', () => ({ oneWay: d.v }));
    },
  });
  const dirRow = row(
    'Solid side',
    dirSel.el,
    'In the body’s own frame: bodies land on this side and pass through from the other',
  );
  ctx.updaters.push(() => {
    const b = first();
    if (!b) return;
    oneWay.set(b.oneWay !== undefined);
    dirRow.style.display = b.oneWay !== undefined ? '' : 'none';
    if (b.oneWay) dirSel.set(dirKey(b.oneWay));
  });
  out.push(
    section(
      'Collision filter',
      [
        row('Layer', layerSel.el, 'The layer this body lives on (names are edited in the World tab)'),
        rowStack('Collides with', h('div', { class: 'stack-col' }, grid, maskButtons, maskHint)),
        oneWay.el,
        dirRow,
      ],
      { id: 'body-collision', open: false },
    ),
  );

  // ---- aerodynamics ----------------------------------------------------------------------------------------
  const c2 = numberField({
    step: 0.01,
    min: 0,
    digits: 4,
    unit: 'N·s²/m²',
    ...ctx.grouped('Edit drag'),
    onChange: (v) => edit('Edit quadratic drag', (b) => ({ drag: { ...b.drag, linear2: v } })),
  });
  const w2 = numberField({
    step: 0.01,
    min: 0,
    digits: 4,
    unit: 'N·m·s²',
    ...ctx.grouped('Edit drag'),
    onChange: (v) => edit('Edit angular drag', (b) => ({ drag: { ...b.drag, angular2: v } })),
  });
  let rho = 1.2,
    cd = 0.47,
    area = 0;
  const rhoF = numberField({ step: 0.1, min: 0, digits: 3, unit: 'kg/m³', value: rho, onChange: (v) => (rho = v) });
  const cdF = numberField({ step: 0.05, min: 0, digits: 3, value: cd, onChange: (v) => (cd = v) });
  const areaF = numberField({ step: 0.01, min: 0, digits: 4, unit: 'm²', onChange: (v) => (area = v) });
  const apply = button(
    'Set c = ½·ρ·Cd·A',
    () =>
      edit('Set drag from Cd·A', (b) => ({ drag: { ...b.drag, linear2: quadraticDragCoefficient(rho, cd, area) } })),
    { cls: 'small', title: 'Quadratic drag coefficient from air density, drag coefficient and frontal area' },
  );
  const fromShape = button(
    'Area from size',
    () => {
      const b = first();
      areaF.set(frontalArea(b.shape.size));
      area = frontalArea(b.shape.size);
    },
    { cls: 'small', title: 'Frontal area of the bounding box seen from above' },
  );
  const vt = h('span', { class: 'readout' }, '—');
  ctx.updaters.push(() => {
    const b = first();
    if (!b) return;
    c2.set(b.drag.linear2);
    w2.set(b.drag.angular2);
    if (area === 0) {
      area = frontalArea(b.shape.size);
      areaF.set(area);
    }
    const m = app.sim.client.active ? (app.sim.client.info.mass[b.id] ?? massEstimate(b)) : massEstimate(b);
    const g = Math.hypot(...app.store.settings.gravity) * b.gravityScale;
    vt.textContent =
      b.drag.linear2 > 0 && g > 0
        ? `${fmt(terminalSpeed(m, Math.abs(g), b.drag.linear2), 2)} m/s`
        : 'no limit (no drag or no gravity)';
  });
  out.push(
    section(
      'Air resistance',
      [
        row('Drag c', c2.el, 'F = −c·|v|·v (relative to the wind). 0 = none'),
        row('Spin drag', w2.el, 'τ = −c·|ω|·ω'),
        row('Terminal speed', vt, '√(m·g / c) = √(2·m·g / (ρ·Cd·A))'),
        h('p', { class: 'hint-text' }, 'Helper: c = ½·ρ·Cd·A'),
        row('Air density ρ', rhoF.el),
        row('Drag coeff. Cd', cdF.el, 'Sphere ≈ 0.47, cube ≈ 1.05, streamlined ≈ 0.04'),
        row('Frontal area A', areaF.el),
        h('div', { class: 'chips' }, apply, fromShape),
        h(
          'p',
          { class: 'hint-text' },
          'Linear and angular damping (1/s) are in the Physics section; set a wind in the World tab.',
        ),
      ],
      { id: 'body-aero', open: false },
    ),
  );

  // ---- mass / centre of mass / inertia ---------------------------------------------------------------------
  const massOn = toggleField({
    label: 'Override mass',
    onChange: (v) =>
      edit('Toggle mass override', (b) => ({
        massOverride: v ? Math.max(0.01, +massEstimate(b).toFixed(3)) : undefined,
      })),
  });
  const massF = numberField({
    step: 0.5,
    min: 0.0001,
    digits: 3,
    unit: 'kg',
    ...ctx.grouped('Edit mass'),
    onChange: (v) => edit('Edit mass override', () => ({ massOverride: Math.max(0.0001, v) })),
  });
  const comOn = toggleField({
    label: 'Override centre of mass',
    onChange: (v) =>
      edit('Toggle centre-of-mass override', () => ({ comOverride: v ? ([0, 0, 0] as Vec3) : undefined })),
  });
  const comF = vec3Field({
    step: 0.01,
    digits: 3,
    unit: 'm',
    ...ctx.grouped('Edit centre of mass'),
    onChange: (v) => edit('Edit centre of mass', () => ({ comOverride: v })),
  });
  const handle = button(
    'Edit in viewport',
    () => {
      const g = app.gizmos.com;
      g.set(g.bodyId === ids[0] ? null : ids[0]);
    },
    { cls: 'small', title: 'Drag the centre of mass with the move gizmo' },
  );
  const handleOn = () => app.gizmos.com.bodyId === ids[0];
  app.on('comEdit', () => handle.classList.toggle('active', handleOn()));
  const inertia = numberField({
    step: 0.1,
    min: 0.001,
    max: 1000,
    digits: 3,
    ...ctx.grouped('Edit inertia'),
    onChange: (v) => edit('Edit inertia scale', () => ({ inertiaScale: Math.max(0.001, v) })),
  });
  const massBox = h('div', { class: 'stack-col' });
  const comBox = h('div', { class: 'stack-col' });
  massBox.append(row('Mass', massF.el));
  comBox.append(rowStack('Local position', comF.el), handle);
  ctx.updaters.push(() => {
    const b = first();
    if (!b) return;
    const dyn = allDynamic();
    massOn.set(b.massOverride !== undefined);
    massBox.style.display = b.massOverride !== undefined ? '' : 'none';
    if (b.massOverride !== undefined) massF.set(b.massOverride);
    comOn.set(b.comOverride !== undefined);
    comBox.style.display = b.comOverride !== undefined ? '' : 'none';
    if (b.comOverride) comF.set(b.comOverride);
    inertia.set(b.inertiaScale);
    handle.disabled = multi || !dyn;
  });
  out.push(
    section(
      'Mass properties',
      [
        massOn.el,
        massBox,
        comOn.el,
        comBox,
        row('Inertia scale', inertia.el, 'Scales the moments of inertia: <1 spins up easily, >1 resists rotation'),
        h(
          'p',
          { class: 'hint-text' },
          'Overrides apply to dynamic bodies. With a centre-of-mass override the body’s own inertia tensor is kept, about the new centre.',
        ),
      ],
      { id: 'body-mass', open: false },
    ),
  );

  // ---- sleep -----------------------------------------------------------------------------------------------
  const sleepOn = toggleField({
    label: 'Custom sleep threshold',
    title: 'Fall asleep once slower than this for half a second',
    onChange: (v) => edit('Toggle sleep threshold', () => ({ sleepThreshold: v ? 0.1 : undefined })),
  });
  const sleepF = numberField({
    step: 0.01,
    min: 0,
    digits: 3,
    unit: 'm/s',
    ...ctx.grouped('Edit sleep threshold'),
    onChange: (v) => edit('Edit sleep threshold', () => ({ sleepThreshold: Math.max(0, v) })),
  });
  const never = toggleField({
    label: 'Never sleep',
    title: 'Keep the body awake (it never stops being simulated)',
    onChange: (v) => edit('Toggle never sleep', () => ({ canSleep: !v })),
  });
  const wake = button('Wake all bodies', () => app.sim.client.op({ op: 'wakeAll' }), {
    cls: 'small',
    title: 'Wake every sleeping body in the running simulation',
  });
  const sleepBox = h('div', { class: 'stack-col' }, row('Threshold', sleepF.el));
  ctx.updaters.push(() => {
    const b = first();
    if (!b) return;
    sleepOn.set(b.sleepThreshold !== undefined);
    sleepBox.style.display = b.sleepThreshold !== undefined ? '' : 'none';
    if (b.sleepThreshold !== undefined) sleepF.set(b.sleepThreshold);
    never.set(!b.canSleep);
    wake.disabled = !app.sim.active;
  });
  out.push(
    section(
      'Sleep',
      [
        never.el,
        sleepOn.el,
        sleepBox,
        h('div', { class: 'chips' }, wake),
        h(
          'p',
          { class: 'hint-text' },
          'A body asleep costs nothing until something touches it. The threshold is the speed (of the body and of its surface when spinning) under which it settles.',
        ),
      ],
      { id: 'body-sleep', open: false },
    ),
  );
  return out;
}

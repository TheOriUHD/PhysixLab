/**
 * Inspector sections for one or more rigid bodies: transform, physics (type, material, damping,
 * locks, options), initial motion, thruster, appearance and the live readout while simulating.
 */
import { DEG, qfromEuler, qtoEuler, RAD, vlen } from '../../core/math';
import type { Vec3 } from '../../core/math';
import { MATERIAL_PRESETS, PRESET_BY_ID } from '../../model/materials';
import { normalizeSize, SHAPE_LABELS, shapeVolume } from '../../model/shapes';
import type { BodyEntity } from '../../model/types';
import {
  checkChips,
  colorField,
  fmt,
  keyField,
  numberField,
  row,
  rowStack,
  section,
  segmented,
  selectField,
  sliderField,
  toggleField,
  vec3Field,
} from '../controls';
import type { Field } from '../controls';
import { h } from '../dom';
import type { InspectorContext } from './shared';

export function bodyInspector(ctx: InspectorContext, sel: BodyEntity[]): HTMLElement[] {
  const { app } = ctx;
  const ids = sel.map((b) => b.id);
  const multi = sel.length > 1;
  const cur = (): BodyEntity[] => ids.map((id) => app.store.body(id)).filter((b): b is BodyEntity => !!b);
  const first = (): BodyEntity => cur()[0];
  const mixed = <T>(get: (b: BodyEntity) => T) => {
    const l = cur();
    return l.some((b) => JSON.stringify(get(b)) !== JSON.stringify(get(l[0])));
  };
  const live = app.sim.active;

  /** Register a field: `get` reads the first selection, `mixedOf` the multi-selection state. */
  const bind = <T>(f: Field<T>, get: (b: BodyEntity) => T) => {
    ctx.updaters.push(() => {
      if (cur().length) f.set(get(first()), multi && mixed(get));
    });
    return f.el;
  };
  const num = (
    label: string,
    get: (b: BodyEntity) => number,
    set: (b: BodyEntity, v: number) => Partial<BodyEntity>,
    o: { step?: number; min?: number; max?: number; unit?: string; digits?: number; hint?: string } = {},
  ) => {
    const g = ctx.grouped(`Edit ${label}`);
    const f = numberField({
      step: o.step ?? 0.1,
      min: o.min,
      max: o.max,
      unit: o.unit,
      digits: o.digits,
      ...g,
      onChange: (v) => ctx.edit<BodyEntity>(ids, `Edit ${label}`, (b) => set(b, v)),
    });
    return row(label, bind(f, get), o.hint);
  };
  const out: HTMLElement[] = [ctx.header(sel)];

  // ---- transform ----------------------------------------------------------------------------
  if (!multi) {
    const poseOf = () => app.sim.poseOf(ids[0]);
    const gp = ctx.grouped('Move');
    const pos = vec3Field({
      step: 0.05,
      unit: 'm',
      ...gp,
      onChange: (v) => {
        const p = poseOf();
        if (p) app.editor.setPose(ids[0], v, p.rotation);
      },
    });
    ctx.updaters.push(() => {
      const p = poseOf();
      if (p) pos.set(p.position);
    });
    const gr = ctx.grouped('Rotate');
    const rot = vec3Field({
      step: 1,
      unit: '°',
      digits: 2,
      ...gr,
      onChange: (v) => {
        const q = qfromEuler([v[0] * DEG, v[1] * DEG, v[2] * DEG]);
        const p = poseOf();
        if (p) app.editor.setPose(ids[0], p.position, q);
      },
    });
    ctx.updaters.push(() => {
      const p = poseOf();
      if (!p) return;
      const e = qtoEuler(p.rotation);
      const next: Vec3 = [e[0] * RAD, e[1] * RAD, e[2] * RAD];
      // keep the user's own representation while they are scrubbing
      if (document.activeElement && (document.activeElement as HTMLElement).closest('.vec3') === rot.el) return;
      rot.set(next);
    });
    const size = sizeFields(ctx, ids[0]);
    out.push(
      section(
        'Transform',
        [
          rowStack(
            'Position (m)',
            pos.el,
            live ? 'Live pose — editing moves the body in the running simulation only' : undefined,
          ),
          rowStack('Rotation (°)', rot.el),
          ...size,
        ],
        { id: 'transform' },
      ),
    );
  }

  // ---- physics ------------------------------------------------------------------------------
  const typeSeg = segmented<BodyEntity['bodyType']>({
    options: [
      { value: 'dynamic', label: 'Dynamic', title: 'Moves under forces and collisions' },
      { value: 'static', label: 'Static', title: 'Fixed in place; others collide with it' },
      { value: 'kinematic', label: 'Kinematic', title: 'Moves at a set velocity, unaffected by forces' },
    ],
    onChange: (v) => app.editor.setBodyType(ids, v),
  });
  ctx.updaters.push(() => {
    if (!mixed((b) => b.bodyType)) typeSeg.set(first().bodyType);
    else typeSeg.buttons.forEach((b) => b.classList.remove('on'));
  });

  const presetSel = selectField<string>({
    options: [...MATERIAL_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: 'Custom' }],
    onChange: (v) => {
      const p = PRESET_BY_ID.get(v);
      if (!p) return;
      ctx.edit<BodyEntity>(ids, `Material: ${p.label}`, () => ({
        material: {
          preset: p.id,
          density: p.density,
          friction: p.friction,
          restitution: p.restitution,
          color: p.color,
          metalness: p.metalness,
          roughness: p.roughness,
          opacity: p.opacity,
        },
      }));
    },
  });
  const matEdit = (label: string, patch: (m: BodyEntity['material']) => Partial<BodyEntity['material']>) =>
    ctx.edit<BodyEntity>(ids, label, (b) => ({
      material: { ...b.material, preset: 'custom', ...patch(b.material) },
    }));

  const density = sliderField({
    min: 5,
    max: 25000,
    log: true,
    unit: 'kg/m³',
    digits: 0,
    ...ctx.grouped('Edit density'),
    onChange: (v) => matEdit('Edit density', () => ({ density: Math.round(v) })),
  });
  const friction = sliderField({
    min: 0,
    max: 2,
    step: 0.01,
    digits: 2,
    ...ctx.grouped('Edit friction'),
    onChange: (v) => matEdit('Edit friction', () => ({ friction: v })),
  });
  const rest = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    ...ctx.grouped('Edit restitution'),
    onChange: (v) => matEdit('Edit restitution', () => ({ restitution: v })),
  });

  const massVal = h('span', { class: 'readout' });
  const massRow = row('Mass', massVal, 'Density × volume, from the engine once simulating');
  ctx.updaters.push(() => {
    const b = first();
    if (b.bodyType !== 'dynamic') {
      massVal.textContent = b.bodyType === 'static' ? 'static (immovable)' : 'kinematic (scripted)';
      return;
    }
    const liveMass = app.sim.client.active ? app.sim.client.info.mass[b.id] : undefined;
    const m = liveMass ?? cur().reduce((s, x) => s + x.material.density * shapeVolume(x.shape), 0);
    massVal.textContent = `${fmt(m, m < 10 ? 3 : m < 1000 ? 2 : 0)} kg`;
    massVal.title = `${fmt(shapeVolume(b.shape), 4)} m³ × ${b.material.density} kg/m³`;
  });

  out.push(
    section(
      'Physics',
      [
        rowStack('Type', typeSeg.el),
        row(
          'Material',
          bind(presetSel, (b) => b.material.preset),
        ),
        row(
          'Density',
          bind(density, (b) => b.material.density),
        ),
        row(
          'Friction',
          bind(friction, (b) => b.material.friction),
        ),
        row(
          'Bounciness',
          bind(rest, (b) => b.material.restitution),
          'Coefficient of restitution (1 = perfectly elastic)',
        ),
        massRow,
        num(
          'Lin. damping',
          (b) => b.linearDamping,
          (_b, v) => ({ linearDamping: v }),
          { step: 0.01, min: 0, digits: 3, unit: '1/s' },
        ),
        num(
          'Ang. damping',
          (b) => b.angularDamping,
          (_b, v) => ({ angularDamping: v }),
          { step: 0.01, min: 0, digits: 3, unit: '1/s' },
        ),
        num(
          'Gravity scale',
          (b) => b.gravityScale,
          (_b, v) => ({ gravityScale: v }),
          { step: 0.1, digits: 2, hint: '0 = weightless, negative = floats up' },
        ),
        row(
          'Lock move',
          bind(
            checkChips({
              items: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
              onChange: (v) =>
                ctx.edit<BodyEntity>(ids, 'Lock translation', () => ({
                  lockPosition: v as [boolean, boolean, boolean],
                })),
            }),
            (b) => [...b.lockPosition],
          ),
        ),
        row(
          'Lock rotate',
          bind(
            checkChips({
              items: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
              onChange: (v) =>
                ctx.edit<BodyEntity>(ids, 'Lock rotation', () => ({
                  lockRotation: v as [boolean, boolean, boolean],
                })),
            }),
            (b) => [...b.lockRotation],
          ),
        ),
        rowStack(
          'Options',
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', paddingBottom: '4px' } },
            bind(
              toggleField({
                label: 'Continuous collision (fast bodies)',
                onChange: (v) => ctx.edit<BodyEntity>(ids, 'Toggle CCD', () => ({ ccd: v })),
              }),
              (b) => b.ccd,
            ),
            bind(
              toggleField({
                label: 'Allow sleeping',
                onChange: (v) => ctx.edit<BodyEntity>(ids, 'Toggle sleeping', () => ({ canSleep: v })),
              }),
              (b) => b.canSleep,
            ),
            bind(
              toggleField({
                label: 'Ghost (no collisions, keeps mass)',
                onChange: (v) => ctx.edit<BodyEntity>(ids, 'Toggle ghost', () => ({ ghost: v })),
              }),
              (b) => b.ghost,
            ),
          ),
        ),
      ],
      { id: 'physics' },
    ),
  );

  // ---- motion -------------------------------------------------------------------------------
  const vel = vec3Field({
    step: 0.1,
    unit: 'm/s',
    ...ctx.grouped('Edit velocity'),
    onChange: (v) => ctx.edit<BodyEntity>(ids, 'Edit velocity', () => ({ velocity: v })),
  });
  const ang = vec3Field({
    step: 0.1,
    unit: 'rad/s',
    ...ctx.grouped('Edit spin'),
    onChange: (v) => ctx.edit<BodyEntity>(ids, 'Edit spin', () => ({ angularVelocity: v })),
  });
  out.push(
    section(
      'Initial motion',
      [
        h(
          'p',
          { class: 'hint-text' },
          'Dynamic bodies start with this velocity when the simulation begins. Kinematic bodies move with it continuously.',
        ),
        rowStack(
          'Velocity (m/s)',
          bind({ el: vel.el, set: (v: Vec3, m?: boolean) => vel.set(v, m) }, (b) => b.velocity),
        ),
        rowStack(
          'Spin (rad/s)',
          bind({ el: ang.el, set: (v: Vec3, m?: boolean) => ang.set(v, m) }, (b) => b.angularVelocity),
        ),
      ],
      { id: 'motion', open: false },
    ),
  );

  // ---- forces -------------------------------------------------------------------------------
  out.push(thrustSection(ctx, ids, cur, mixed));

  // ---- appearance ---------------------------------------------------------------------------
  const color = colorField({
    ...ctx.grouped('Edit colour'),
    onChange: (v) => matEdit('Edit colour', () => ({ color: v })),
  });
  const metal = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    ...ctx.grouped('Edit metalness'),
    onChange: (v) => matEdit('Edit metalness', () => ({ metalness: v })),
  });
  const rough = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    ...ctx.grouped('Edit roughness'),
    onChange: (v) => matEdit('Edit roughness', () => ({ roughness: v })),
  });
  const opac = sliderField({
    min: 0.05,
    max: 1,
    step: 0.01,
    digits: 2,
    ...ctx.grouped('Edit opacity'),
    onChange: (v) => matEdit('Edit opacity', () => ({ opacity: v })),
  });
  out.push(
    section(
      'Appearance',
      [
        row(
          'Colour',
          bind(color, (b) => b.material.color),
        ),
        row(
          'Metalness',
          bind(metal, (b) => b.material.metalness),
        ),
        row(
          'Roughness',
          bind(rough, (b) => b.material.roughness),
        ),
        row(
          'Opacity',
          bind(opac, (b) => b.material.opacity),
        ),
      ],
      { id: 'appearance', open: false },
    ),
  );

  // ---- live readout -------------------------------------------------------------------------
  if (live && !multi) out.push(liveBodySection(ctx, ids[0]));
  return out;
}

function sizeFields(ctx: InspectorContext, id: string): HTMLElement[] {
  const { app } = ctx;
  const get = () => app.store.body(id);
  const type = get()!.shape.type;
  const setSize = (axis: number, v: number) => {
    const b = get();
    if (!b) return;
    const next: Vec3 = [...b.shape.size] as Vec3;
    next[axis] = v;
    if ((type === 'cylinder' || type === 'cone' || type === 'capsule') && axis === 2) next[0] = v;
    if (type === 'sphere') {
      next[0] = next[1] = next[2] = v;
    }
    app.store.update(id, { shape: { ...b.shape, size: normalizeSize(type, next, b.shape.size) } }, 'Resize');
  };
  const mk = (label: string, axis: number, hint?: string) => {
    const f = numberField({
      step: 0.05,
      min: 0.02,
      unit: 'm',
      ...ctx.grouped('Resize'),
      onChange: (v) => setSize(axis, v),
    });
    ctx.updaters.push(() => {
      const b = get();
      if (b) f.set(b.shape.size[axis]);
    });
    return row(label, f.el, hint);
  };
  const rows: HTMLElement[] = [];
  switch (type) {
    case 'sphere':
      rows.push(mk('Diameter', 0));
      break;
    case 'cylinder':
    case 'cone':
    case 'capsule':
      rows.push(mk('Diameter', 0), mk('Height', 1));
      break;
    case 'prism': {
      rows.push(mk('Width', 0), mk('Height', 1), mk('Depth', 2));
      const sides = sliderField({
        min: 3,
        max: 32,
        step: 1,
        digits: 0,
        ...ctx.grouped('Prism sides'),
        onChange: (v) => {
          const b = get();
          if (b) app.store.update(id, { shape: { ...b.shape, sides: Math.round(v) } }, 'Prism sides');
        },
      });
      ctx.updaters.push(() => {
        const b = get();
        if (b) sides.set(b.shape.sides ?? 6);
      });
      rows.push(row('Sides', sides.el));
      break;
    }
    default:
      rows.push(mk('Width', 0), mk('Height', 1), mk('Depth', 2));
  }
  rows.unshift(row('Shape', h('span', { class: 'readout' }, SHAPE_LABELS[type])));
  return rows;
}

function thrustSection(
  ctx: InspectorContext,
  ids: string[],
  cur: () => BodyEntity[],
  mixed: <T>(g: (b: BodyEntity) => T) => boolean,
): HTMLElement {
  const { app } = ctx;
  const first = () => cur()[0];
  const wrap = h('div');
  const enabled = toggleField({
    label: 'Apply a force / torque (thruster, fan, rocket)',
    onChange: (v) =>
      ctx.edit<BodyEntity>(ids, 'Toggle thruster', (b) => ({
        thrust: v
          ? (b.thrust ?? {
              force: [0, 40 * Math.max(1, app.sim.client.info.mass[b.id] ?? 20), 0],
              torque: [0, 0, 0],
              mode: 'always',
              key: '',
            })
          : null,
      })),
  });
  const setT = (
    fn: (t: NonNullable<BodyEntity['thrust']>) => Partial<NonNullable<BodyEntity['thrust']>>,
    label: string,
  ) => ctx.edit<BodyEntity>(ids, label, (b) => (b.thrust ? { thrust: { ...b.thrust, ...fn(b.thrust) } } : {}));
  const force = vec3Field({
    step: 10,
    unit: 'N',
    digits: 1,
    ...ctx.grouped('Edit thrust'),
    onChange: (v) => setT(() => ({ force: v }), 'Edit thrust'),
  });
  const torque = vec3Field({
    step: 5,
    unit: 'N·m',
    digits: 1,
    ...ctx.grouped('Edit torque'),
    onChange: (v) => setT(() => ({ torque: v }), 'Edit torque'),
  });
  const mode = segmented<'always' | 'key'>({
    options: [
      { value: 'always', label: 'Always on' },
      { value: 'key', label: 'While key held' },
    ],
    onChange: (v) => setT(() => ({ mode: v }), 'Thrust mode'),
  });
  const key = keyField({
    onChange: (c) => setT(() => ({ key: c, mode: c ? 'key' : 'always' }), 'Thrust key'),
    placeholder: 'Pick key',
  });
  const details = h(
    'div',
    null,
    h(
      'p',
      { class: 'hint-text' },
      'Force and torque act in the body’s local frame, every simulation step, at its centre of mass.',
    ),
    rowStack('Force (N, local)', force.el),
    rowStack('Torque (N·m, local)', torque.el),
    rowStack('Trigger', mode.el),
    row('Key', key.el),
  );
  ctx.updaters.push(() => {
    const b = first();
    enabled.set(
      !!b.thrust,
      mixed((x) => !!x.thrust),
    );
    details.style.display = b.thrust ? '' : 'none';
    if (b.thrust) {
      force.set(b.thrust.force);
      torque.set(b.thrust.torque);
      mode.set(b.thrust.mode);
      key.set(b.thrust.key);
    }
  });
  wrap.append(enabled.el, details);
  return section('Forces', [wrap], { id: 'forces', open: false });
}

function liveBodySection(ctx: InspectorContext, id: string): HTMLElement {
  const { app } = ctx;
  const dl = h('dl', { class: 'readout' });
  const rows: Record<string, HTMLElement> = {};
  for (const [k, label] of [
    ['state', 'State'],
    ['pos', 'Height'],
    ['speed', 'Speed'],
    ['vel', 'Velocity'],
    ['ang', 'Spin'],
    ['ke', 'Kinetic energy'],
    ['mom', 'Momentum'],
    ['force', 'Net force'],
    ['accel', 'Acceleration'],
  ] as const) {
    const dd = h('dd', null, '—');
    rows[k] = dd;
    dl.append(h('dt', null, label), dd);
  }
  ctx.live.push(() => {
    const b = app.liveBody(id);
    const pose = app.sim.poseOf(id);
    if (!b || !pose) return;
    const v = vlen(b.vel);
    rows.state.textContent = b.state === 2 ? 'fell out of world' : b.state === 1 ? 'asleep' : 'awake';
    rows.pos.textContent = `${fmt(pose.position[1], 3)} m`;
    rows.speed.textContent = `${fmt(v, 3)} m/s`;
    rows.vel.textContent = b.vel.map((x) => fmt(x, 2)).join(', ');
    rows.ang.textContent = `${fmt(vlen(b.ang), 3)} rad/s`;
    rows.ke.textContent = `${fmt(b.ke, 2)} J`;
    rows.mom.textContent = `${fmt(v * b.mass, 2)} kg·m/s`;
    rows.force.textContent = `${fmt(vlen(b.force), 1)} N`;
    rows.accel.textContent =
      b.mass > 0 ? `${fmt(vlen(b.force) / b.mass, 2)} m/s² (${fmt(vlen(b.force) / b.mass / 9.81, 2)} g)` : '—';
  });
  return section('Live', [dl], { id: 'live', badge: 'LIVE' });
}

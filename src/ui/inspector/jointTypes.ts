/**
 * Inspector sections of the JT-A joint types (cone-twist, 6-DOF, universal, pulley, gear, belt, rack, screw, winch,
 * soft weld) and the live readout table of every joint type. Each section edits `JointEntity.params` through
 * `store.update` with a label, scrubs are one undo step (`grouped`), and every field refreshes from the document
 * through the inspector's updaters, so undo / redo and the viewport gizmo keep them in sync.
 */
import { DEG, RAD, qrot, vadd, vdist, vlen } from '../../core/math';
import type { Vec3 } from '../../core/math';
import { DOF_LABELS, type DofMode, type DofSpec, type JointParams } from '../../model/jointParams';
import type { JointEntity, JointType, MotorMode } from '../../model/types';
import type { App } from '../../app/app';
import {
  button,
  fmt,
  keyField,
  numberField,
  row,
  rowStack,
  section,
  segmented,
  sliderField,
  toggleField,
  vec3Field,
} from '../controls';
import type { Field } from '../controls';
import { h } from '../dom';
import { copyJointSettings } from '../../app/jointOps';
import { runMirror } from '../../app/builtin/jointCommands';
import { MIRROR_PLANES } from '../../model/jointMirror';
import { JOINT_TYPE_LABELS } from '../../model/factory';
import type { InspectorContext } from './shared';

/** What the sections need from the joint inspector. */
export interface JointUi {
  ctx: InspectorContext;
  app: App;
  id: string;
  get(): JointEntity;
  /** Register `f` to refresh from the document; returns its element. */
  bind<T>(f: Field<T>, g: (j: JointEntity) => T): HTMLElement;
  edit(label: string, fn: (j: JointEntity) => Partial<JointEntity>): void;
}

const hint = (text: string) => h('p', { class: 'hint-text' }, text);

/** The shaft / axis row's label per type. */
export const AXIS_LABELS: Partial<Record<JointType, { label: string; hint: string }>> = {
  hinge: { label: 'Axis (unit vector)', hint: 'Local to body A (world if A is the world)' },
  slider: { label: 'Axis (unit vector)', hint: 'Local to body A (world if A is the world)' },
  conetwist: { label: 'Twist axis (unit vector)', hint: 'The bone direction the cone opens around; local to body A' },
  sixdof: { label: 'Joint X axis (unit vector)', hint: 'The X axis of the joint frame; local to body A' },
  universal: { label: 'Shaft axis (unit vector)', hint: 'The shaft direction that cannot twist; local to body A' },
  screw: { label: 'Screw axis (unit vector)', hint: 'Turning about this axis moves B along it; local to body A' },
  rack: { label: 'Pinion shaft (unit vector)', hint: 'Rotation axis of the pinion on body A, local to A' },
  gear: { label: 'Shaft of A (unit vector)', hint: 'Rotation axis of gear A, local to body A' },
  belt: { label: 'Shaft of A (unit vector)', hint: 'Rotation axis of pulley A, local to body A' },
};

function setParams(ui: JointUi, label: string, p: Partial<JointParams>) {
  ui.edit(label, (j) => ({ params: { ...j.params, ...p } }));
}

const num = (ui: JointUi, label: string, o: Parameters<typeof numberField>[0]) =>
  numberField({ ...ui.ctx.grouped(label), ...o });

/** Second shaft in body B's frame, with "align to world" chips. */
function secondAxis(ui: JointUi, label: string, hintText: string): HTMLElement[] {
  const f = vec3Field({
    step: 0.1,
    digits: 3,
    ...ui.ctx.grouped('Edit second axis'),
    onChange: (v) => {
      const l = vlen(v) || 1;
      setParams(ui, 'Edit second axis', { axisB: [v[0] / l, v[1] / l, v[2] / l] });
    },
  });
  const chips = h('div', { class: 'chips' });
  for (const [name, w] of [
    ['X', [1, 0, 0]],
    ['Y', [0, 1, 0]],
    ['Z', [0, 0, 1]],
  ] as [string, Vec3][]) {
    const b = h('button', { class: 'chip', type: 'button', title: `Align the axis with world ${name}` }, name);
    b.addEventListener('click', () =>
      setParams(ui, 'Set second axis', { axisB: ui.app.editor.worldAxisToLocal(ui.get().bodyB, w) }),
    );
    chips.appendChild(b);
  }
  return [
    rowStack(
      label,
      ui.bind(f, (j) => j.params.axisB),
      hintText,
    ),
    row('Align to world', chips),
  ];
}

function worldAnchor(app: App, body: string | null, local: Vec3): Vec3 {
  const b = body ? app.store.body(body) : undefined;
  return b ? vadd(b.position, qrot(b.rotation, local)) : local;
}

// ---- cone-twist ----------------------------------------------------------------------------------------

function coneTwist(ui: JointUi): HTMLElement[] {
  const swing = num(ui, 'Edit swing cone', {
    step: 5,
    min: 0.1,
    max: 180,
    unit: '°',
    digits: 1,
    onChange: (v) => setParams(ui, 'Edit swing cone', { swing: v * DEG }),
  });
  const tmin = num(ui, 'Edit twist limit', {
    step: 5,
    min: -180,
    max: 180,
    unit: '°',
    digits: 1,
    onChange: (v) => setParams(ui, 'Edit twist limit', { twistMin: v * DEG }),
  });
  const tmax = num(ui, 'Edit twist limit', {
    step: 5,
    min: -180,
    max: 180,
    unit: '°',
    digits: 1,
    onChange: (v) => setParams(ui, 'Edit twist limit', { twistMax: v * DEG }),
  });
  return [
    section(
      'Cone & twist limits',
      [
        row(
          'Swing cone',
          ui.bind(swing, (j) => j.params.swing * RAD),
          'Half-angle of the cone body B may swing away from the axis',
        ),
        row(
          'Twist min',
          ui.bind(tmin, (j) => j.params.twistMin * RAD),
        ),
        row(
          'Twist max',
          ui.bind(tmax, (j) => j.params.twistMax * RAD),
        ),
        hint(
          'Swing is the angle between the two bodies’ axes; twist is the spin about the axis. Both are measured from the pose when the simulation starts. Shoulders and hips: 45–90° swing, ±30° twist.',
        ),
      ],
      { id: 'joint-conetwist' },
    ),
  ];
}

// ---- 6-DOF ---------------------------------------------------------------------------------------------

function sixDof(ui: JointUi): HTMLElement[] {
  const cards: HTMLElement[] = [];
  const setDof = (i: number, label: string, p: Partial<DofSpec>) =>
    ui.edit(label, (j) => ({
      params: { ...j.params, dof: j.params.dof.map((d, k) => (k === i ? { ...d, ...p } : d)) },
    }));
  for (let i = 0; i < 6; i++) {
    const lin = i < 3;
    const toUI = (v: number) => (lin ? v : v * RAD);
    const fromUI = (v: number) => (lin ? v : v * DEG);
    const label = `Edit ${DOF_LABELS[i]}`;
    const mode = segmented<DofMode>({
      compact: true,
      options: [
        { value: 'free', label: 'Free', title: 'Moves without resistance' },
        { value: 'limited', label: 'Limited', title: 'Moves within min … max' },
        { value: 'locked', label: 'Locked', title: 'Cannot move' },
      ],
      onChange: (v) => setDof(i, `${DOF_LABELS[i]} mode`, { mode: v }),
    });
    const field = (cap: string, f: Field<number>, cls = '') =>
      h('div', { class: `dof-f ${cls}` }, h('span', null, cap), f.el);
    const mn = num(ui, label, {
      step: lin ? 0.05 : 5,
      unit: lin ? 'm' : '°',
      digits: 2,
      onChange: (v) => setDof(i, label, { min: fromUI(v) }),
    });
    const mx = num(ui, label, {
      step: lin ? 0.05 : 5,
      unit: lin ? 'm' : '°',
      digits: 2,
      onChange: (v) => setDof(i, label, { max: fromUI(v) }),
    });
    const k = num(ui, label, {
      step: lin ? 100 : 10,
      min: 0,
      unit: lin ? 'N/m' : 'N·m/rad',
      digits: 0,
      onChange: (v) => setDof(i, label, { stiffness: v }),
    });
    const c = num(ui, label, {
      step: lin ? 5 : 1,
      min: 0,
      unit: lin ? 'N·s/m' : 'N·m·s/rad',
      digits: 1,
      onChange: (v) => setDof(i, label, { damping: v }),
    });
    const mv = num(ui, label, {
      step: 0.5,
      unit: lin ? 'm/s' : 'rad/s',
      digits: 2,
      onChange: (v) => setDof(i, label, { motorVelocity: v }),
    });
    const mf = num(ui, label, {
      step: lin ? 50 : 10,
      min: 0,
      unit: lin ? 'N' : 'N·m',
      digits: 0,
      onChange: (v) => setDof(i, label, { motorForce: v }),
    });
    const card = h(
      'div',
      { class: 'dof-card', dataset: { mode: 'locked', axis: String(i) } },
      h(
        'div',
        { class: 'dof-head' },
        h('div', { class: 'dof-name' }, DOF_LABELS[i], h('small', null, lin ? 'move' : 'rotate')),
        mode.el,
      ),
      h(
        'div',
        { class: 'dof-grid' },
        field('Min', mn, 'dof-limit'),
        field('Max', mx, 'dof-limit'),
        field('Spring', k),
        field('Damper', c),
        field('Motor speed', mv),
        field('Motor max force (0 = off)', mf),
      ),
    );
    ui.ctx.updaters.push(() => {
      const d = ui.get().params.dof[i];
      mode.set(d.mode);
      card.dataset.mode = d.mode;
      mn.set(toUI(d.min));
      mx.set(toUI(d.max));
      k.set(d.stiffness);
      c.set(d.damping);
      mv.set(d.motorVelocity);
      mf.set(d.motorForce);
    });
    cards.push(card);
  }
  return [
    section(
      'Six degrees of freedom',
      [
        hint(
          'Each axis is free, limited or locked. Limits are measured from the pose when the simulation starts; the spring pulls toward that pose; the motor drives toward a speed using at most its max force. The joint X axis is set by the axis above.',
        ),
        ...cards,
      ],
      { id: 'joint-sixdof' },
    ),
  ];
}

// ---- universal -----------------------------------------------------------------------------------------

function universal(): HTMLElement[] {
  return [
    section(
      'Universal joint',
      [
        hint(
          'A cardan joint: the two bodies can bend freely about both axes perpendicular to the shaft axis, but cannot spin about it relative to each other, so rotation is transmitted through the bend. Drive shafts, steering columns and gimbals.',
        ),
      ],
      { id: 'joint-universal' },
    ),
  ];
}

// ---- pulley --------------------------------------------------------------------------------------------

function pulley(ui: JointUi): HTMLElement[] {
  const pa = vec3Field({
    step: 0.1,
    unit: 'm',
    ...ui.ctx.grouped('Move pulley point'),
    onChange: (v) => setParams(ui, 'Move pulley point', { pulleyA: v }),
  });
  const pb = vec3Field({
    step: 0.1,
    unit: 'm',
    ...ui.ctx.grouped('Move pulley point'),
    onChange: (v) => setParams(ui, 'Move pulley point', { pulleyB: v }),
  });
  const ratio = num(ui, 'Edit pulley ratio', {
    step: 0.5,
    min: 0.01,
    max: 1000,
    digits: 2,
    unit: '×',
    onChange: (v) => setParams(ui, 'Edit pulley ratio', { ratio: v }),
  });
  const info = h('div', { class: 'jt-info' });
  ui.ctx.updaters.push(() => {
    const j = ui.get();
    const wa = worldAnchor(ui.app, j.bodyA, j.anchorA);
    const wb = worldAnchor(ui.app, j.bodyB, j.anchorB);
    const la = vdist(wa, j.params.pulleyA);
    const lb = vdist(wb, j.params.pulleyB);
    info.replaceChildren(
      'Rope length at start: ',
      h('b', null, `${fmt(la + j.params.ratio * lb, 3)} m`),
      ` (${fmt(la, 2)} m on A + ${fmt(j.params.ratio, 2)} × ${fmt(lb, 2)} m on B)`,
    );
  });
  return [
    section(
      'Pulley',
      [
        rowStack(
          'Fixed point over A (world, m)',
          ui.bind(pa, (j) => j.params.pulleyA),
          'Where the rope leaves body A’s side: a point fixed in the world',
        ),
        rowStack(
          'Fixed point over B (world, m)',
          ui.bind(pb, (j) => j.params.pulleyB),
          'Where the rope leaves body B’s side: a point fixed in the world',
        ),
        row(
          'Ratio',
          ui.bind(ratio, (j) => j.params.ratio),
          '1 = Atwood machine; 2 = B moves half as far as A',
        ),
        info,
        hint(
          'The rope runs from body A’s anchor up over the first point, across to the second and down to body B’s anchor. Its length is fixed at the pose where the simulation starts, so a rope that starts slack stays slack until it comes taut. Rope on A + ratio × rope on B stays constant; the tension shows under Live.',
        ),
      ],
      { id: 'joint-pulley' },
    ),
  ];
}

// ---- gear ----------------------------------------------------------------------------------------------

function gear(ui: JointUi): HTMLElement[] {
  const ratio = num(ui, 'Edit gear ratio', {
    step: 0.25,
    min: 0.01,
    max: 1000,
    digits: 3,
    unit: '×',
    onChange: (v) => setParams(ui, 'Edit gear ratio', { ratio: v }),
  });
  const rev = toggleField({
    label: 'Opposite directions (external mesh)',
    onChange: (v) => setParams(ui, 'Toggle gear direction', { reverse: v }),
  });
  const speak = h('div', { class: 'jt-info' });
  ui.ctx.updaters.push(() => {
    const p = ui.get().params;
    speak.replaceChildren(
      'B turns ',
      h('b', null, `${fmt(p.ratio, 3)}×`),
      p.reverse ? ' as fast as A, the opposite way' : ' as fast as A, the same way',
      ` · torque on B is ${fmt(p.ratio, 3)}× the torque on A`,
    );
  });
  return [
    section(
      'Gear pair',
      [
        row(
          'Ratio',
          ui.bind(ratio, (j) => j.params.ratio),
          'Speed of B relative to A (teeth of A ÷ teeth of B)',
        ),
        row(
          'Direction',
          ui.bind(rev, (j) => j.params.reverse),
        ),
        speak,
        ...secondAxis(ui, 'Shaft of B (unit vector)', 'Rotation axis of gear B, local to body B'),
        hint(
          'Couples the two shafts like meshed gears: a speed-up trades torque for speed and a reduction does the opposite. The bodies must each be mounted on a hinge of their own.',
        ),
      ],
      { id: 'joint-gear' },
    ),
  ];
}

// ---- belt / chain --------------------------------------------------------------------------------------

function belt(ui: JointUi): HTMLElement[] {
  const ra = num(ui, 'Edit pulley radius', {
    step: 0.05,
    min: 0.005,
    max: 100,
    digits: 3,
    unit: 'm',
    onChange: (v) => setParams(ui, 'Edit pulley radius', { radiusA: v }),
  });
  const rb = num(ui, 'Edit pulley radius', {
    step: 0.05,
    min: 0.005,
    max: 100,
    digits: 3,
    unit: 'm',
    onChange: (v) => setParams(ui, 'Edit pulley radius', { radiusB: v }),
  });
  const crossed = toggleField({
    label: 'Crossed (B turns the opposite way)',
    onChange: (v) => setParams(ui, 'Toggle belt crossing', { reverse: v }),
  });
  const slip = num(ui, 'Edit slip torque', {
    step: 5,
    min: 0,
    digits: 1,
    unit: 'N·m',
    onChange: (v) => setParams(ui, 'Edit slip torque', { slipTorque: v }),
  });
  const chain = toggleField({
    label: 'Draw as a chain',
    onChange: (v) => setParams(ui, 'Toggle chain', { chain: v }),
  });
  const calc = h('div', { class: 'jt-info' });
  ui.ctx.updaters.push(() => {
    const p = ui.get().params;
    const r = p.radiusA / p.radiusB;
    calc.replaceChildren('Ratio = rA ÷ rB = ', h('b', null, `${fmt(r, 3)}`), ` → B turns ${fmt(r, 3)}× as fast as A`);
  });
  return [
    section(
      'Belt / chain drive',
      [
        row(
          'Radius of A',
          ui.bind(ra, (j) => j.params.radiusA),
          'Pitch radius of the driver pulley',
        ),
        row(
          'Radius of B',
          ui.bind(rb, (j) => j.params.radiusB),
          'Pitch radius of the driven pulley',
        ),
        calc,
        row(
          'Belt',
          ui.bind(crossed, (j) => j.params.reverse),
        ),
        row(
          'Slip torque',
          ui.bind(slip, (j) => j.params.slipTorque),
          'Largest torque on pulley A before the belt slips. 0 = never slips',
        ),
        row(
          'Style',
          ui.bind(chain, (j) => j.params.chain),
          'Looks only: a chain and a belt behave the same',
        ),
        ...secondAxis(ui, 'Shaft of B (unit vector)', 'Rotation axis of pulley B, local to body B'),
        hint(
          'The speed ratio comes from the pulley radii. Above the slip torque the belt slides and the driven pulley falls behind; leave it 0 for a belt that never slips.',
        ),
      ],
      { id: 'joint-belt' },
    ),
  ];
}

// ---- rack and pinion -----------------------------------------------------------------------------------

function rack(ui: JointUi): HTMLElement[] {
  const r = num(ui, 'Edit pinion radius', {
    step: 0.05,
    min: 0.005,
    max: 100,
    digits: 3,
    unit: 'm',
    onChange: (v) => setParams(ui, 'Edit pinion radius', { radiusA: v }),
  });
  const rev = toggleField({
    label: 'Reverse travel direction',
    onChange: (v) => setParams(ui, 'Toggle rack direction', { reverse: v }),
  });
  return [
    section(
      'Rack & pinion',
      [
        row(
          'Pinion radius',
          ui.bind(r, (j) => j.params.radiusA),
          'Pitch radius: the rack moves radius × angular speed',
        ),
        row(
          'Direction',
          ui.bind(rev, (j) => j.params.reverse),
        ),
        ...secondAxis(ui, 'Rack direction (unit vector)', 'The line the rack slides along, local to body B'),
        hint(
          'The pinion (body A, on a hinge) and the rack (body B, on a slider) are coupled: the rack travels radius × angle. Torque on the pinion becomes force on the rack.',
        ),
      ],
      { id: 'joint-rack' },
    ),
  ];
}

// ---- screw ---------------------------------------------------------------------------------------------

function screw(ui: JointUi): HTMLElement[] {
  const pitch = num(ui, 'Edit screw pitch', {
    step: 0.01,
    min: 0.001,
    max: 100,
    digits: 3,
    unit: 'm/rev',
    onChange: (v) => setParams(ui, 'Edit screw pitch', { pitch: (ui.get().params.pitch < 0 ? -1 : 1) * v }),
  });
  const hand = segmented<'right' | 'left'>({
    options: [
      { value: 'right', label: 'Right-hand', title: 'Turning counter-clockwise about the axis moves B along +axis' },
      { value: 'left', label: 'Left-hand', title: 'Turning counter-clockwise about the axis moves B along −axis' },
    ],
    onChange: (v) =>
      setParams(ui, 'Set screw handedness', { pitch: (v === 'left' ? -1 : 1) * Math.abs(ui.get().params.pitch) }),
  });
  ui.ctx.updaters.push(() => hand.set(ui.get().params.pitch < 0 ? 'left' : 'right'));
  return [
    section(
      'Screw',
      [
        row(
          'Pitch',
          ui.bind(pitch, (j) => Math.abs(j.params.pitch)),
          'Travel per full revolution',
        ),
        rowStack('Thread', hand.el),
        hint(
          'Turning one body relative to the other about the axis moves it along the axis by pitch per revolution, and pushing it along the axis turns it (a lead screw or jack). Friction in a real thread is not modelled.',
        ),
      ],
      { id: 'joint-screw' },
    ),
  ];
}

// ---- winch ---------------------------------------------------------------------------------------------

function winch(ui: JointUi): HTMLElement[] {
  const get = () => ui.get();
  const rating = num(ui, 'Edit winch load rating', {
    step: 100,
    min: 0,
    digits: 0,
    unit: 'N',
    onChange: (v) => setParams(ui, 'Edit winch load rating', { loadRating: v }),
  });
  const setM = (label: string, p: Partial<JointEntity['motor']>) =>
    ui.edit(label, (j) => ({ motor: { ...j.motor, ...p } }));
  const mode = segmented<MotorMode>({
    options: [
      { value: 'off', label: 'Hold', title: 'The rope length stays as it is' },
      { value: 'velocity', label: 'Reel', title: 'Pull the rope in (or pay it out) at the speed below' },
    ],
    onChange: (v) => setM('Winch mode', { mode: v }),
  });
  const speed = num(ui, 'Edit winch speed', {
    step: 0.1,
    unit: 'm/s',
    digits: 2,
    onChange: (v) => setM('Edit winch speed', { targetVelocity: v }),
  });
  const kp = keyField({ onChange: (c) => setM('Winch key', { keyPos: c }), placeholder: 'None' });
  const kn = keyField({ onChange: (c) => setM('Winch key', { keyNeg: c }), placeholder: 'None' });
  const rowSpeed = row('Reel speed', speed.el, 'Metres of rope pulled in per second at full input');
  const rowKp = row('Key: reel in', kp.el);
  const rowKn = row('Key: pay out', kn.el);
  ui.ctx.updaters.push(() => {
    const m = get().motor;
    mode.set(m.mode === 'velocity' ? 'velocity' : 'off');
    speed.set(m.targetVelocity);
    kp.set(m.keyPos);
    kn.set(m.keyNeg);
    const on = m.mode === 'velocity';
    for (const el of [rowSpeed, rowKp, rowKn]) el.style.display = on ? '' : 'none';
  });
  return [
    section(
      'Winch',
      [
        row(
          'Load rating',
          ui.bind(rating, (j) => j.params.loadRating),
          'Rope tension the winch can hold. Above it the rope pays out. 0 = unlimited',
        ),
        rowStack('Drum', mode.el),
        rowSpeed,
        rowKp,
        rowKn,
        hint(
          'The rope runs from anchor A to anchor B. Its length at the start pose is the starting length; reeling shortens it. With keys bound the drum moves only while they are held; without keys, Reel mode pulls continuously (a negative speed pays the rope out).',
        ),
      ],
      { id: 'joint-winch' },
    ),
  ];
}

// ---- soft weld -----------------------------------------------------------------------------------------

function softWeld(ui: JointUi): HTMLElement[] {
  const slider = (
    label: string,
    key: 'linStiffness' | 'linDamping' | 'angStiffness' | 'angDamping',
    unit: string,
    hintText: string,
  ) => {
    const f = sliderField({
      min: 1,
      max: 1e7,
      log: true,
      unit,
      digits: 0,
      ...ui.ctx.grouped(`Edit ${label.toLowerCase()}`),
      onChange: (v) => setParams(ui, `Edit ${label.toLowerCase()}`, { [key]: Math.round(v) }),
    });
    return rowStack(
      label,
      ui.bind(f, (j) => Math.max(1, j.params[key])),
      hintText,
    );
  };
  return [
    section(
      'Soft weld',
      [
        slider('Stiffness', 'linStiffness', 'N/m', 'How hard the weld resists the ends moving apart'),
        slider('Damping', 'linDamping', 'N·s/m', 'Damps the relative motion of the ends'),
        slider('Bend stiffness', 'angStiffness', 'N·m/rad', 'How hard the weld resists bending and twisting'),
        slider('Bend damping', 'angDamping', 'N·m·s/rad', 'Damps the relative rotation'),
        hint(
          'A fixed joint that flexes: the bodies spring back to their start pose. Soft welds make beams that sag, bridges that bounce and flexible chassis. Very high stiffness approaches a rigid weld.',
        ),
      ],
      { id: 'joint-softweld' },
    ),
  ];
}

/** The type-specific sections to insert after "Anchors" (none for the classic types). */
export function jointTypeSections(ui: JointUi, type: JointType): HTMLElement[] {
  switch (type) {
    case 'conetwist':
      return coneTwist(ui);
    case 'sixdof':
      return sixDof(ui);
    case 'universal':
      return universal();
    case 'pulley':
      return pulley(ui);
    case 'gear':
      return gear(ui);
    case 'belt':
      return belt(ui);
    case 'rack':
      return rack(ui);
    case 'screw':
      return screw(ui);
    case 'winch':
      return winch(ui);
    case 'softweld':
      return softWeld(ui);
    default:
      return [];
  }
}

// ---- live readouts -------------------------------------------------------------------------------------

export interface LiveDef {
  key: 'value' | 'speed' | 'force';
  label: string;
  format: (v: number) => string;
}

const deg = (v: number) => `${fmt(v * RAD, 1)}°`;
const metres = (v: number) => `${fmt(v, 3)} m`;
const angSpeed = (v: number) => `${fmt(v, 2)} rad/s (${fmt((v * 60) / (2 * Math.PI), 1)} rpm)`;
const linSpeed = (v: number) => `${fmt(v, 3)} m/s`;
const newtons = (v: number) => `${fmt(v, 1)} N`;
const torque = (v: number) => `${fmt(v, 1)} N·m`;

/** The "Live" rows of each type: which of the joint's three live numbers to show, and how. */
export function liveDefs(type: JointType): LiveDef[] {
  switch (type) {
    case 'hinge':
      return [
        { key: 'value', label: 'Angle', format: deg },
        { key: 'speed', label: 'Speed', format: angSpeed },
      ];
    case 'slider':
      return [
        { key: 'value', label: 'Position', format: metres },
        { key: 'speed', label: 'Speed', format: linSpeed },
      ];
    case 'spring':
      return [
        { key: 'value', label: 'Length', format: metres },
        { key: 'speed', label: 'Rate', format: linSpeed },
        { key: 'force', label: 'Force', format: (v) => `${newtons(v)} ${v > 0 ? '(tension)' : '(compression)'}` },
      ];
    case 'rope':
      return [{ key: 'value', label: 'Distance', format: metres }];
    case 'conetwist':
      return [
        { key: 'value', label: 'Swing', format: deg },
        { key: 'speed', label: 'Twist', format: deg },
      ];
    case 'sixdof':
      return [{ key: 'value', label: 'Linear offset', format: metres }];
    case 'pulley':
      return [
        { key: 'value', label: 'Rope used', format: metres },
        { key: 'force', label: 'Rope tension', format: newtons },
      ];
    case 'gear':
      return [
        { key: 'value', label: 'Angle of A', format: deg },
        { key: 'speed', label: 'Speed of A', format: angSpeed },
        { key: 'force', label: 'Torque on B', format: torque },
      ];
    case 'belt':
      return [
        { key: 'value', label: 'Angle of A', format: deg },
        { key: 'speed', label: 'Speed of A', format: angSpeed },
        { key: 'force', label: 'Belt torque', format: torque },
      ];
    case 'rack':
      return [
        { key: 'value', label: 'Travel', format: metres },
        { key: 'speed', label: 'Speed', format: linSpeed },
        { key: 'force', label: 'Force on rack', format: newtons },
      ];
    case 'screw':
      return [
        { key: 'value', label: 'Relative angle', format: deg },
        { key: 'speed', label: 'Relative speed', format: angSpeed },
        { key: 'force', label: 'Thread load', format: newtons },
      ];
    case 'winch':
      return [
        { key: 'value', label: 'Rope length', format: metres },
        { key: 'speed', label: 'Reel rate', format: (v) => linSpeed(-v) },
        { key: 'force', label: 'Rope tension', format: newtons },
      ];
    case 'softweld':
      return [
        { key: 'value', label: 'Offset', format: metres },
        { key: 'force', label: 'Load', format: (v) => `${fmt(v, 1)} (N + N·m terms)` },
      ];
    default:
      return [];
  }
}

// ---- several joints selected ---------------------------------------------------------------------------

/** Inspector for a selection of two or more joints: copy settings from the first, mirror. */
export function jointSelectionInspector(ctx: InspectorContext, sel: JointEntity[]): HTMLElement[] {
  const { app } = ctx;
  const first = sel[0];
  const same = sel.filter((j) => j.type === first.type);
  const copy = button(
    `Copy settings of “${first.name}” to the other ${same.length - 1}`,
    () => {
      if (!copyJointSettings(app)) app.toast('Select two or more joints of the same type', 'warn');
    },
    { cls: 'small', title: 'Copies limits, motor, spring and behaviour settings (not positions or axes)' },
  );
  copy.disabled = same.length < 2;
  const mirror = (axis: 'x' | 'y' | 'z', label: string) =>
    button(label, () => runMirror(app, MIRROR_PLANES[axis], `${axis.toUpperCase()} = 0`), {
      cls: 'small',
      title: `Mirror the selected joints across the plane ${axis.toUpperCase()} = 0 (they attach to the mirrored twins of their bodies)`,
    });
  const updateEnabled = () => {
    for (const b of mirrors) b.disabled = app.sim.active;
  };
  const mirrors = [mirror('x', 'X = 0'), mirror('y', 'Y = 0'), mirror('z', 'Z = 0')];
  ctx.updaters.push(updateEnabled);
  return [
    ctx.header(sel),
    section(
      `${sel.length} joints`,
      [
        h(
          'p',
          { class: 'hint-text' },
          same.length === sel.length
            ? `All ${JOINT_TYPE_LABELS[first.type]} joints. The first one selected is the source for “Copy settings”.`
            : `Mixed types: only the ${same.length} ${JOINT_TYPE_LABELS[first.type]} joint(s) can share settings.`,
        ),
        h('div', { class: 'jt-actions' }, copy),
        rowStack('Mirror across plane', h('div', { class: 'jt-actions' }, mirrors)),
        h(
          'p',
          { class: 'hint-text' },
          'Mirroring attaches each joint to the mirrored twin of its bodies (a body that was mirrored earlier or lies on the plane). To mirror bodies and joints together, select them all and use Edit ▸ Mirror.',
        ),
      ],
      { id: 'joint-multi' },
    ),
  ];
}

/**
 * What the powered parts look like (package CP), decided without any drawing code: from the document, the poses and
 * the numbers the components publish, `planComponentFx` returns a flat list of things to show —
 *
 *   flame   a rocket or jet exhaust: where, which way, how long, how bright
 *   disc    the blades of a propeller or rotor, fading into a blur as the speed rises (and tilting with the cyclic)
 *   dial    the angle of a servo or stepper against its target and its travel
 *   slide   the stroke of a linear actuator or hydraulic cylinder against its target and its travel
 *   ring    a brake disc that glows with the pedal
 *
 * `componentFx.ts` turns the list into three.js objects. Keeping the decisions here makes them testable in Node.
 * Flames and discs show while the simulation runs (and as a faint preview for the selected owner while editing);
 * the dials, slides and rings are gauges, shown while running and for the selected owner.
 */
import { clamp, DEG, qrot, vadd, vcross, vnorm, vscale, type Quat, type Vec3 } from '../core/math';
import type { BodyEntity, ComponentSpec, JointEntity } from '../model/types';

export interface FxSource {
  bodies(): readonly BodyEntity[];
  joints(): readonly JointEntity[];
  /** Pose of a body in the world (the live frame while simulating, the document otherwise). */
  pose(id: string): { position: Vec3; rotation: Quat } | null;
  /** The numbers a component published (`ctx.state.set`), or null. */
  values(componentId: string): ArrayLike<number> | null;
  /** Is a simulation running (or paused)? */
  live(): boolean;
  selected(id: string): boolean;
}

export interface FlameFx {
  kind: 'flame';
  key: string;
  /** Where the exhaust leaves the nozzle (world). */
  at: Vec3;
  /** Unit direction the exhaust travels (world): opposite to the thrust. */
  dir: Vec3;
  length: number;
  width: number;
  color: string;
  /** 0 … 1.2: brightness. */
  intensity: number;
  afterburner: boolean;
  /** A faint edit-mode preview rather than a live flame. */
  preview: boolean;
}

export interface DiscFx {
  kind: 'disc';
  key: string;
  at: Vec3;
  /** Unit axis the blades turn about (world), after any cyclic tilt. */
  axis: Vec3;
  radius: number;
  rpm: number;
  blades: number;
  color: string;
  preview: boolean;
}

export interface DialFx {
  kind: 'dial';
  key: string;
  at: Vec3;
  axis: Vec3;
  /** Unit direction of angle zero (world): perpendicular to the axis, fixed to the joint's first body. */
  ref: Vec3;
  radius: number;
  /** Radians about the axis. */
  current: number;
  target: number | null;
  min: number | null;
  max: number | null;
}

export interface SlideFx {
  kind: 'slide';
  key: string;
  at: Vec3;
  axis: Vec3;
  min: number;
  max: number;
  current: number;
  target: number | null;
}

export interface RingFx {
  kind: 'ring';
  key: string;
  at: Vec3;
  axis: Vec3;
  radius: number;
  /** 0 … 1: how hard the brake is on. */
  heat: number;
}

export type Fx = FlameFx | DiscFx | DialFx | SlideFx | RingFx;

const num = (c: ComponentSpec, k: string, d = 0): number => (typeof c.params[k] === 'number' ? c.params[k] : d);
const str = (c: ComponentSpec, k: string, d = ''): string => (typeof c.params[k] === 'string' ? c.params[k] : d);
const bool = (c: ComponentSpec, k: string, d = false): boolean => (typeof c.params[k] === 'boolean' ? c.params[k] : d);
const vec = (c: ComponentSpec, k: string, d: Vec3): Vec3 => {
  const v = c.params[k];
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? (v as Vec3) : d;
};

/** A unit vector perpendicular to `n`. */
export function perpendicular(n: Vec3): Vec3 {
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return vnorm(vcross(n, a), [0, 0, 1]);
}

interface JointFrame {
  at: Vec3;
  axis: Vec3;
  ref: Vec3;
}

function jointFrame(j: JointEntity, src: FxSource): JointFrame | null {
  const axisLocal = vnorm(j.axis, [0, 0, 1]);
  const refLocal = perpendicular(axisLocal);
  if (!j.bodyA) return { at: j.anchorA, axis: axisLocal, ref: refLocal };
  const p = src.pose(j.bodyA);
  if (!p) return null;
  return {
    at: vadd(p.position, qrot(p.rotation, j.anchorA)),
    axis: qrot(p.rotation, axisLocal),
    ref: qrot(p.rotation, refLocal),
  };
}

/** Everything worth drawing right now. */
export function planComponentFx(src: FxSource): Fx[] {
  const out: Fx[] = [];
  const live = src.live();

  for (const b of src.bodies()) {
    if (!b.components.length || b.hidden) continue;
    const selected = src.selected(b.id);
    if (!live && !selected) continue;
    const pose = src.pose(b.id);
    if (!pose) continue;
    for (const c of b.components) {
      if (!c.enabled) continue;
      if (c.type === 'thruster' || c.type === 'jet') flame(out, c, pose, src, live);
      else if (c.type === 'propeller' || c.type === 'rotor') {
        const dir = vnorm(vec(c, 'direction', [0, 1, 0]), [0, 1, 0]);
        const at = vadd(pose.position, qrot(pose.rotation, vec(c, 'position', [0, 0, 0])));
        disc(out, c, at, qrot(pose.rotation, dir), qrot(pose.rotation, vec(c, 'forward', [1, 0, 0])), src, live);
      }
    }
  }

  for (const j of src.joints()) {
    if (!j.components.length || j.hidden) continue;
    const selected = src.selected(j.id);
    if (!live && !selected) continue;
    const frame = jointFrame(j, src);
    if (!frame) continue;
    for (const c of j.components) {
      if (!c.enabled) continue;
      const v = src.values(c.id);
      switch (c.type) {
        case 'servo':
          out.push({
            kind: 'dial',
            key: c.id,
            ...frame,
            radius: 0.4,
            current: (v?.[0] ?? 0) * DEG,
            target: v ? v[1] * DEG : num(c, 'target') * DEG,
            min: num(c, 'minAngle', -90) * DEG,
            max: num(c, 'maxAngle', 90) * DEG,
          });
          break;
        case 'stepper':
          out.push({
            kind: 'dial',
            key: c.id,
            ...frame,
            radius: 0.4,
            current: (v?.[2] ?? 0) * DEG,
            target: v ? v[1] * DEG : null,
            min: null,
            max: null,
          });
          break;
        case 'linearActuator':
          out.push({
            kind: 'slide',
            key: c.id,
            at: frame.at,
            axis: frame.axis,
            min: num(c, 'min'),
            max: num(c, 'max', 1),
            current: v?.[0] ?? 0,
            target: v ? v[1] : num(c, 'target'),
          });
          break;
        case 'hydraulicCylinder':
          out.push({
            kind: 'slide',
            key: c.id,
            at: frame.at,
            axis: frame.axis,
            min: num(c, 'min'),
            max: num(c, 'max', 1),
            current: (v?.[0] ?? 0) / 1000, // published in mm
            target: null,
          });
          break;
        case 'brake':
          out.push({
            kind: 'ring',
            key: c.id,
            at: frame.at,
            axis: frame.axis,
            radius: 0.3,
            heat: v ? clamp(Math.max(v[1] / 100, v[2]), 0, 1) : 0,
          });
          break;
        case 'propeller':
        case 'rotor':
          disc(out, c, frame.at, frame.axis, frame.ref, src, live);
          break;
      }
    }
  }
  return out;
}

function flame(out: Fx[], c: ComponentSpec, pose: { position: Vec3; rotation: Quat }, src: FxSource, live: boolean) {
  if (!bool(c, 'flame', true)) return;
  const v = live ? src.values(c.id) : null;
  const jet = c.type === 'jet';
  // thruster: [thrust N, throttle %, …]; jet: [thrust N, engine speed %, afterburner 0|1, …]: the flame follows the
  // thrust actually produced, relative to the rated thrust (so an empty tank has no flame and an afterburner a long one)
  const rated = num(c, 'thrust', 0);
  const intensity = v ? clamp(rated > 0 ? v[0] / rated : v[1] / 100, 0, 1.2) : live ? 0 : 0.5;
  const afterburner = jet && !!v && v[2] > 0.5;
  if (intensity < 0.02) return;
  const dir = vnorm(vec(c, 'direction', [0, 1, 0]), [0, 1, 0]);
  const length = num(c, 'flameLength', 1.5) * intensity * (afterburner ? 1.7 : 1);
  out.push({
    kind: 'flame',
    key: c.id,
    at: vadd(pose.position, qrot(pose.rotation, vec(c, 'position', [0, 0, 0]))),
    dir: vscale(qrot(pose.rotation, dir), -1),
    length,
    width: 0.12 + 0.07 * num(c, 'flameLength', 1.5),
    color: afterburner ? '#ff9d4a' : str(c, 'flameColor', jet ? '#8fd3ff' : '#ffa94d'),
    intensity,
    afterburner,
    preview: !live,
  });
}

function disc(
  out: Fx[],
  c: ComponentSpec,
  at: Vec3,
  axisWorld: Vec3,
  forwardWorld: Vec3,
  src: FxSource,
  live: boolean,
) {
  const rotor = c.type === 'rotor';
  if (!bool(c, 'blur', true)) return;
  const v = live ? src.values(c.id) : null;
  let axis = vnorm(axisWorld, [0, 1, 0]);
  if (rotor && v) {
    // the cyclic leans the disc: the same construction as the runtime's (forward made perpendicular to the axis)
    const fwd = vnorm(vcross(vcross(axis, forwardWorld), axis), [1, 0, 0]);
    const right = vnorm(vcross(fwd, axis), [0, 0, 1]);
    const lean = vadd(vscale(fwd, Math.tan(v[3] * DEG)), vscale(right, Math.tan(v[4] * DEG)));
    axis = vnorm(vadd(axis, lean), axis);
  }
  out.push({
    kind: 'disc',
    key: c.id,
    at,
    axis,
    radius: rotor ? num(c, 'radius', 1.5) : num(c, 'diameter', 1) / 2,
    rpm: v ? v[0] : 0,
    blades: Math.max(1, Math.round(num(c, 'blades', rotor ? 3 : 2))),
    color: str(c, 'bladeColor', '#d6e4f2'),
    preview: !live,
  });
}

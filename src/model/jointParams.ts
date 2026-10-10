/**
 * Type-specific settings of the JT-A joint types (cone-twist, 6-DOF, pulley, rack, gear, belt, universal,
 * screw, winch, soft weld) in one sub-object of `JointEntity.params`, with the defaults, the sanitiser and the
 * per-type metadata (which types couple two independent anchors, which use a second axis, …).
 * Kept in its own file so the shared model files only carry one field and one call.
 */
import type { Vec3 } from '../core/math';
import { clampNum, isVec3 } from './paramUtil';
import type { JointType } from './types';

export type DofMode = 'free' | 'limited' | 'locked';

/** One of the six axes of a 6-DOF joint (lin x/y/z then ang x/y/z, in the joint frame of body A). */
export interface DofSpec {
  mode: DofMode;
  /** Limits (m or rad) relative to the pose at build time, used when `mode` is `limited`. */
  min: number;
  max: number;
  /** Spring toward the reference pose (N/m or N·m/rad); 0 = none. Active on free and limited axes. */
  stiffness: number;
  /** Damping (N·s/m or N·m·s/rad); 0 = none. */
  damping: number;
  /** Velocity motor target (m/s or rad/s) and the largest force / torque it may use (0 = motor off). */
  motorVelocity: number;
  motorForce: number;
}

export interface JointParams {
  // cone-twist
  /** Half angle of the swing cone, radians. */
  swing: number;
  twistMin: number;
  twistMax: number;
  // 6-DOF
  dof: DofSpec[];
  // gear / belt / pulley / rack
  /** Speed ratio: gear `ωB = ∓ratio·ωA`; pulley `Δ(rope on B side) = ratio·Δ(rope on A side)`. */
  ratio: number;
  /** Gear / belt: the second body turns the opposite way (external mesh, crossed belt). */
  reverse: boolean;
  /** Pitch / pulley / spool radii in metres (rack: `radiusA` is the pinion pitch radius). */
  radiusA: number;
  radiusB: number;
  /** Second axis in body B's local frame (gear, belt, rack travel direction, universal second shaft). */
  axisB: Vec3;
  /** Belt: largest torque on the driver pulley before the belt slips (N·m, 0 = never slips). */
  slipTorque: number;
  /** Belt: draw a chain instead of a belt (same mechanics). */
  chain: boolean;
  // pulley: the two fixed points the rope runs over (world space)
  pulleyA: Vec3;
  pulleyB: Vec3;
  // screw: travel per revolution (m)
  pitch: number;
  // winch: rope tension the winch can hold (N, 0 = unlimited) and the live rope length (set at build)
  loadRating: number;
  // reference pose (JT-22): the build pose sits `refOffset` (rad for a hinge, m for a slider) away from the joint's
  // zero, so limits, the motor's position target and the live readout are all relative to that zero.
  refOffset: number;
  /** The reference pose is locked: "re-zero" is refused until it is unlocked. */
  refLocked: boolean;
  // soft weld
  linStiffness: number;
  linDamping: number;
  angStiffness: number;
  angDamping: number;
}

export const DOF_LABELS = ['X', 'Y', 'Z', 'Rot X', 'Rot Y', 'Rot Z'] as const;

export function defaultDof(): DofSpec[] {
  return Array.from({ length: 6 }, (_, i) => ({
    mode: 'locked',
    min: i < 3 ? -0.5 : -Math.PI / 4,
    max: i < 3 ? 0.5 : Math.PI / 4,
    stiffness: 0,
    damping: 0,
    motorVelocity: 0,
    motorForce: 0,
  }));
}

export function defaultParams(): JointParams {
  return {
    swing: Math.PI / 4,
    twistMin: -Math.PI / 6,
    twistMax: Math.PI / 6,
    dof: defaultDof(),
    ratio: 1,
    reverse: true,
    radiusA: 0.5,
    radiusB: 0.5,
    axisB: [0, 0, 1],
    slipTorque: 0,
    chain: false,
    pulleyA: [0, 4, 0],
    pulleyB: [1, 4, 0],
    pitch: 0.2,
    loadRating: 0,
    refOffset: 0,
    refLocked: false,
    linStiffness: 2000,
    linDamping: 60,
    angStiffness: 400,
    angDamping: 12,
  };
}

const MODES: DofMode[] = ['free', 'limited', 'locked'];

/** Repair whatever a file holds into valid params (missing fields take their defaults). */
export function sanitizeParams(raw: unknown): JointParams {
  const d = defaultParams();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dofRaw = Array.isArray(r.dof) ? r.dof : [];
  const dof = d.dof.map((base, i) => {
    const x = (dofRaw[i] && typeof dofRaw[i] === 'object' ? dofRaw[i] : {}) as Record<string, unknown>;
    return {
      mode: MODES.includes(x.mode as DofMode) ? (x.mode as DofMode) : base.mode,
      min: clampNum(x.min, base.min, -1e4, 1e4),
      max: clampNum(x.max, base.max, -1e4, 1e4),
      stiffness: clampNum(x.stiffness, 0, 0, 1e9),
      damping: clampNum(x.damping, 0, 0, 1e9),
      motorVelocity: clampNum(x.motorVelocity, 0, -1e4, 1e4),
      motorForce: clampNum(x.motorForce, 0, 0, 1e9),
    };
  });
  const vec = (v: unknown, fb: Vec3): Vec3 => (isVec3(v) ? [v[0], v[1], v[2]] : [...fb]);
  return {
    swing: clampNum(r.swing, d.swing, 0.001, Math.PI),
    twistMin: clampNum(r.twistMin, d.twistMin, -Math.PI, Math.PI),
    twistMax: clampNum(r.twistMax, d.twistMax, -Math.PI, Math.PI),
    dof,
    ratio: clampNum(r.ratio, d.ratio, 0.01, 1000),
    reverse: typeof r.reverse === 'boolean' ? r.reverse : d.reverse,
    radiusA: clampNum(r.radiusA, d.radiusA, 0.005, 100),
    radiusB: clampNum(r.radiusB, d.radiusB, 0.005, 100),
    axisB: vec(r.axisB, d.axisB),
    slipTorque: clampNum(r.slipTorque, 0, 0, 1e9),
    chain: typeof r.chain === 'boolean' ? r.chain : false,
    pulleyA: vec(r.pulleyA, d.pulleyA),
    pulleyB: vec(r.pulleyB, d.pulleyB),
    pitch: clampNum(r.pitch, d.pitch, -100, 100) || d.pitch,
    loadRating: clampNum(r.loadRating, 0, 0, 1e9),
    refOffset: clampNum(r.refOffset, 0, -1e4, 1e4),
    refLocked: typeof r.refLocked === 'boolean' ? r.refLocked : false,
    linStiffness: clampNum(r.linStiffness, d.linStiffness, 0, 1e9),
    linDamping: clampNum(r.linDamping, d.linDamping, 0, 1e9),
    angStiffness: clampNum(r.angStiffness, d.angStiffness, 0, 1e9),
    angDamping: clampNum(r.angDamping, d.angDamping, 0, 1e9),
  };
}

// ---- per-type facts shared by the factory, the physics world, the gizmos and the tools --------------------

/** Types whose end B is its own point (every other type derives B from A so the joint starts satisfied). */
export const INDEPENDENT_ANCHOR_TYPES: readonly JointType[] = [
  'spring',
  'rope',
  'pulley',
  'rack',
  'gear',
  'belt',
  'winch',
];
/** Types that couple two otherwise-independent mechanisms (no common pivot). */
export const COUPLING_TYPES: readonly JointType[] = ['pulley', 'rack', 'gear', 'belt'];
/** Types that use `axis` as a shaft / hinge axis in A's frame. */
export const AXIS_TYPES: readonly JointType[] = [
  'hinge',
  'slider',
  'conetwist',
  'sixdof',
  'universal',
  'screw',
  'rack',
  'gear',
  'belt',
];
/** Types that read the second axis `params.axisB` (in B's local frame). */
export const AXIS_B_TYPES: readonly JointType[] = ['rack', 'gear', 'belt'];

export const hasIndependentAnchors = (t: JointType): boolean => INDEPENDENT_ANCHOR_TYPES.includes(t);

/** Types added by package JT-A (the picker groups them, the conversion table knows them). */
export const JT_A_TYPES: readonly JointType[] = [
  'conetwist',
  'sixdof',
  'pulley',
  'rack',
  'gear',
  'belt',
  'universal',
  'screw',
  'winch',
  'softweld',
];

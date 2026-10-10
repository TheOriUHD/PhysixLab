/**
 * Quick conversion between joint types (JT-9). `convertJoint` is pure: it returns a *patch* for `store.update`, so
 * bodies, anchors and every field it does not name (including fields other packages add to joints, such as break
 * thresholds) stay exactly as they are, and the conversion is one undo step. `convertibleTo` says which targets make
 * sense for a given joint and why not.
 */
import { qrot, qrotInv, vadd, vsub, type Quat, type Vec3 } from '../core/math';
import { JOINT_TYPE_LABELS } from './factory';
import { AXIS_TYPES, INDEPENDENT_ANCHOR_TYPES } from './jointParams';
import type { DofSpec, JointParams } from './jointParams';
import type { JointEntity, JointType } from './types';

/** The picker's groups, in display order. */
export const JOINT_GROUPS: readonly { id: string; label: string; types: readonly JointType[] }[] = [
  { id: 'rigid', label: 'Rigid & flexible', types: ['fixed', 'softweld'] },
  { id: 'rotating', label: 'Rotating', types: ['hinge', 'universal', 'ball', 'conetwist'] },
  { id: 'linear', label: 'Linear', types: ['slider', 'screw'] },
  { id: 'free', label: 'Free-form', types: ['sixdof'] },
  { id: 'elastic', label: 'Elastic', types: ['spring', 'rope'] },
  { id: 'mechanisms', label: 'Mechanisms', types: ['pulley', 'winch', 'gear', 'rack', 'belt'] },
];

/** Types that couple two mechanisms and make no sense with the world on either side. */
const NEEDS_TWO_BODIES: readonly JointType[] = ['pulley', 'rack', 'gear', 'belt'];

export interface ConvertTarget {
  type: JointType;
  ok: boolean;
  /** Why the conversion is not offered (when `ok` is false). */
  reason?: string;
}

export const jointGroupTypes = (): JointType[] => JOINT_GROUPS.flatMap((g) => [...g.types]);

/** Every type, with whether `j` can become it. The joint's own type is not convertible ("already this type"). */
export function convertibleTo(j: Pick<JointEntity, 'type' | 'bodyA' | 'bodyB'>): ConvertTarget[] {
  return jointGroupTypes().map((type) => {
    if (type === j.type) return { type, ok: false, reason: 'This joint already has this type' };
    if (NEEDS_TWO_BODIES.includes(type) && (!j.bodyA || !j.bodyB))
      return {
        type,
        ok: false,
        reason: `${JOINT_TYPE_LABELS[type]} couples two bodies; both ends of this joint must be bodies, not the world`,
      };
    return { type, ok: true };
  });
}

/** Does the joint use the unit-axis fields of its limit / motor in radians (hinge) or metres (slider)? */
const unitOf = (t: JointType): 'rad' | 'm' | null => (t === 'hinge' ? 'rad' : t === 'slider' ? 'm' : null);

/**
 * End B of an independent-anchor type, in B's local frame, so the converted joint starts where the old one was: for
 * types that derive B from A the two ends coincide in the world, so B's anchor is A's world anchor expressed in B.
 * Pass the bodies' poses (null = the world).
 */
export function anchorBFromGeometry(
  j: Pick<JointEntity, 'anchorA'>,
  poseA: { position: Vec3; rotation: Quat } | null,
  poseB: { position: Vec3; rotation: Quat } | null,
): Vec3 {
  const world = poseA ? vadd(poseA.position, qrot(poseA.rotation, j.anchorA)) : j.anchorA;
  return poseB ? qrotInv(poseB.rotation, vsub(world, poseB.position)) : world;
}

export interface ConvertOptions {
  /**
   * Resolved end B for a target with independent anchors, when the source derives B from A (see
   * `anchorBFromGeometry`). Without it end B is kept as the joint has it.
   */
  anchorB?: Vec3;
  /** Current distance between the two anchors (m); becomes a spring's rest length / rope's length when known. */
  distance?: number;
}

const clampRatio = (v: number) => Math.min(1000, Math.max(0.01, v));

/** The patch that turns `j` into a `to` joint. Empty when it already is one. */
export function convertJoint(j: JointEntity, to: JointType, opts: ConvertOptions = {}): Partial<JointEntity> {
  const from = j.type;
  if (from === to) return {};
  const patch: Partial<JointEntity> = { type: to };
  // A name that is still the old type's default label (optionally with a number) follows the type.
  const m = new RegExp(`^${JOINT_TYPE_LABELS[from]}( \\d+)?$`).exec(j.name);
  if (m) patch.name = `${JOINT_TYPE_LABELS[to]}${m[1] ?? ''}`;

  // -- limit / motor: kept; the numbers of a hinge (rad) and a slider (m) do not translate, so they reset --
  const uf = unitOf(from);
  const ut = unitOf(to);
  if (uf && ut && uf !== ut) {
    patch.limit = {
      enabled: j.limit.enabled,
      min: ut === 'rad' ? -Math.PI / 2 : -0.5,
      max: ut === 'rad' ? Math.PI / 2 : 0.5,
    };
    patch.motor = { ...j.motor, targetPosition: 0 };
  }
  if (to === 'winch' && j.motor.mode === 'position') patch.motor = { ...(patch.motor ?? j.motor), mode: 'velocity' };

  // -- 6-DOF -> hinge / slider: the limited (or free) X axis becomes the limit --
  if (from === 'sixdof' && ut) {
    const d = j.params.dof[ut === 'rad' ? 3 : 0];
    patch.limit = { enabled: d.mode === 'limited', min: d.min, max: d.max };
  }

  // -- spring <-> rope: the length carries over --
  if (to === 'rope' && from === 'spring') patch.ropeLength = Math.max(0.05, opts.distance ?? j.spring.restLength);
  if (to === 'rope' && from !== 'spring' && opts.distance !== undefined)
    patch.ropeLength = Math.max(0.05, opts.distance);
  if (to === 'spring' && from === 'rope') patch.spring = { ...j.spring, restLength: j.ropeLength };
  if (to === 'spring' && from !== 'rope' && opts.distance !== undefined)
    patch.spring = { ...j.spring, restLength: Math.max(0.01, opts.distance) };

  // -- independent end B --
  if (INDEPENDENT_ANCHOR_TYPES.includes(to) && !INDEPENDENT_ANCHOR_TYPES.includes(from) && opts.anchorB)
    patch.anchorB = [...opts.anchorB];

  // -- params --
  const params = convertParams(j, to);
  if (params) patch.params = params;
  return patch;
}

function convertParams(j: JointEntity, to: JointType): JointParams | null {
  const from = j.type;
  const p: JointParams = { ...j.params, dof: j.params.dof.map((d) => ({ ...d })) };
  let changed = false;
  // gear <-> belt: the speed ratio and the radii are two views of one number
  if (from === 'gear' && to === 'belt') {
    p.radiusA = Math.min(100, Math.max(0.005, p.ratio * p.radiusB));
    changed = true;
  }
  if (from === 'belt' && to === 'gear') {
    p.ratio = clampRatio(p.radiusA / p.radiusB);
    changed = true;
  }
  // into a 6-DOF joint: lock everything, then free (or limit) what the old joint allowed
  if (to === 'sixdof') {
    const dof: DofSpec[] = p.dof.map((d) => ({ ...d, mode: 'locked' as const }));
    const open = (i: number, limited: boolean, min?: number, max?: number) => {
      dof[i] = { ...dof[i], mode: limited ? 'limited' : 'free', ...(limited ? { min, max } : {}) };
    };
    const lim = j.limit;
    if (from === 'hinge') open(3, lim.enabled, lim.min, lim.max);
    else if (from === 'slider') open(0, lim.enabled, lim.min, lim.max);
    else if (from === 'ball' || from === 'conetwist') [3, 4, 5].forEach((i) => open(i, false));
    else if (from === 'universal') [4, 5].forEach((i) => open(i, false));
    else if (from === 'screw') {
      open(0, false);
      open(3, false);
    } else if (from === 'softweld' || from === 'fixed') {
      /* all locked */
    } else return changed ? p : null;
    p.dof = dof;
    changed = true;
  }
  return changed ? p : null;
}

/** Does converting keep the axis (both types use `axis`)? Exposed for the UI hint. */
export const keepsAxis = (from: JointType, to: JointType): boolean =>
  AXIS_TYPES.includes(from) && AXIS_TYPES.includes(to);

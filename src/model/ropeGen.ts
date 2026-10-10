/**
 * Rope and chain generator (SF-3): a string of rigid capsule links joined by ball joints (rope) or cone-twist joints
 * (chain), laid out between two points and optionally fastened to a body at either end. Pure document code — the
 * result is ordinary bodies and joints that the editor adds as one undo step.
 *
 * Heavy loads on light links make impulse joints stretch and jitter, so `massGuard` reports the load / link mass
 * ratio and `generateChain` raises the link mass until the ratio is at most `MAX_MASS_RATIO` (the caller can read the
 * adjustment from `result.linkMass` / `result.guarded`).
 */
import {
  qfromAxisAngle,
  qfromUnitVectors,
  qmul,
  vadd,
  vdist,
  vlen,
  vnorm,
  vscale,
  vsub,
  type Quat,
  type Vec3,
} from '../core/math';
import { createBody, createJoint } from './factory';
import type { BodyEntity, JointEntity } from './types';

/** Largest load : link mass ratio the generator accepts before it makes the links heavier. */
export const MAX_MASS_RATIO = 12;

export interface ChainSpec {
  kind: 'rope' | 'chain';
  start: Vec3;
  end: Vec3;
  /** Number of links (≥ 2). */
  links: number;
  /** Total mass of the rope in kg. */
  mass?: number;
  /** Link thickness (capsule diameter), metres. */
  thickness?: number;
  /** Body fastened to the first / last link (its id); null = the first / last link is pinned to the world point. */
  startBody?: string | null;
  endBody?: string | null;
  /** Anchor on that body (its local frame) — defaults to the world point. */
  startAnchor?: Vec3;
  endAnchor?: Vec3;
  /** Mass hanging from the rope (kg), used by the guard only. */
  load?: number;
  /** Slack: the links are laid on a catenary-like sag of this depth (m) so a taut line does not start straining. */
  sag?: number;
  color?: string;
}

export interface ChainResult {
  bodies: BodyEntity[];
  joints: JointEntity[];
  linkMass: number;
  linkLength: number;
  /** The requested link mass was raised to satisfy the mass-ratio guard. */
  guarded: boolean;
  warnings: string[];
}

/** Load : link mass ratio of a rope — above `MAX_MASS_RATIO` impulse joints stretch. */
export function massGuard(linkMass: number, load: number): number {
  return load / Math.max(1e-6, linkMass);
}

/** Rotation taking +Y (the capsule axis) onto `dir`. */
const alignY = (dir: Vec3): Quat => qfromUnitVectors([0, 1, 0], vnorm(dir, [0, -1, 0]));

export function generateChain(spec: ChainSpec): ChainResult {
  const warnings: string[] = [];
  const links = Math.max(2, Math.round(spec.links));
  const total = vdist(spec.start, spec.end);
  const sag = Math.max(0, spec.sag ?? 0);
  const thickness = spec.thickness ?? (spec.kind === 'chain' ? 0.08 : 0.05);
  // Path length including the sag (parabola arc length ≈ chord + 8 s² / (3 chord)).
  const length = total + (total > 1e-6 ? (8 * sag * sag) / (3 * total) : 0);
  const linkLength = Math.max(length / links, thickness * 1.2);
  let linkMass = (spec.mass ?? Math.max(0.05, length * (spec.kind === 'chain' ? 1.2 : 0.3))) / links;
  const load = spec.load ?? 0;
  let guarded = false;
  if (massGuard(linkMass, load) > MAX_MASS_RATIO) {
    linkMass = load / MAX_MASS_RATIO;
    guarded = true;
    warnings.push(
      `The ${load.toFixed(1)} kg load is more than ${MAX_MASS_RATIO}× a link; links were made ${linkMass.toFixed(2)} kg each so the ${spec.kind} does not stretch.`,
    );
  }
  const radius = thickness / 2;
  const shaft = Math.max(0.001, linkLength - thickness); // capsule: height includes both caps
  const volume = Math.PI * radius * radius * shaft + (4 / 3) * Math.PI * radius ** 3;
  const density = linkMass / volume;
  const point = (t: number): Vec3 => {
    const p = vadd(spec.start, vscale(vsub(spec.end, spec.start), t));
    return [p[0], p[1] - 4 * sag * t * (1 - t), p[2]];
  };

  const bodies: BodyEntity[] = [];
  const joints: JointEntity[] = [];
  const half = linkLength / 2;
  for (let i = 0; i < links; i++) {
    const a = point(i / links),
      b = point((i + 1) / links);
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    let rot = alignY(vsub(b, a));
    // A chain's alternate links stand turned 90° about their axis, like real interlocking rings.
    if (spec.kind === 'chain' && i % 2) rot = qmul(rot, qfromAxisAngle([0, 1, 0], Math.PI / 2));
    bodies.push(
      createBody({
        name: `${spec.kind === 'chain' ? 'Chain' : 'Rope'} link ${i + 1}`,
        shape: { type: 'capsule', size: [thickness, linkLength, thickness] },
        position: mid,
        rotation: rot,
        material: {
          preset: 'custom',
          density,
          friction: 0.5,
          color: spec.color ?? (spec.kind === 'chain' ? '#9aa4b2' : '#c8a46a'),
        },
        linearDamping: 0.02,
        angularDamping: 0.3,
      }),
    );
  }
  const jt = spec.kind === 'chain' ? 'conetwist' : 'ball';
  for (let i = 0; i + 1 < links; i++) {
    joints.push(
      createJoint({
        name: `${spec.kind === 'chain' ? 'Chain' : 'Rope'} joint ${i + 1}`,
        type: jt,
        bodyA: bodies[i].id,
        bodyB: bodies[i + 1].id,
        anchorA: [0, half, 0],
        anchorB: [0, -half, 0],
      }),
    );
  }
  // Ends: to a body at its anchor, or pinned to the world point.
  const endJoint = (first: boolean): JointEntity => {
    const link = first ? bodies[0] : bodies[links - 1];
    const body = first ? spec.startBody : spec.endBody;
    const anchor = first ? spec.startAnchor : spec.endAnchor;
    const world = first ? spec.start : spec.end;
    return createJoint({
      name: first ? 'Rope start' : 'Rope end',
      type: 'ball',
      bodyA: body ?? null,
      bodyB: link.id,
      anchorA: body ? (anchor ?? [0, 0, 0]) : world,
      anchorB: [0, first ? half : -half, 0],
    });
  };
  joints.push(endJoint(true)); // the start is always fastened (to a body, or to the world point)
  if (spec.endBody !== undefined) joints.push(endJoint(false)); // undefined = free end; null = pinned to the world point
  if (vlen(vsub(spec.end, spec.start)) < 1e-3) warnings.push('The two ends are at the same point.');
  return { bodies, joints, linkMass, linkLength, guarded, warnings };
}

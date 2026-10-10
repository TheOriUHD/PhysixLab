/**
 * Pure helpers shared by the soft-body tools (SF-1 attach, SF-2 cut, SF-3 rope): frame conversions, attachment
 * records, the cutting triangle, rope / cable layout. No DOM, no three.js — unit-tested in tests/softTools.test.ts.
 */
import {
  qfromUnitVectors,
  qrot,
  qrotInv,
  vadd,
  vdist,
  vnorm,
  vscale,
  vsub,
  type Quat,
  type Vec3,
} from '../../core/math';
import { uid } from '../../model/factory';
import { tyreGeometry } from '../../model/softMesh';
import { softSpacing } from '../../model/softMaterial';
import type { BodyEntity, JointEntity, SoftAttachment, SoftEntity } from '../../model/types';

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

/** World point -> local frame of `pose`. */
export const worldToLocal = (pose: Pose, p: Vec3): Vec3 => qrotInv(pose.rotation, vsub(p, pose.position));
/** Local point of `pose` -> world. */
export const localToWorld = (pose: Pose, p: Vec3): Vec3 => vadd(pose.position, qrot(pose.rotation, p));

/** Default region radius of an attachment: 1.5 lattice spacings (never below 5 cm). */
export function defaultAttachRadius(soft: Pick<SoftEntity, 'type' | 'size' | 'resolution' | 'cell'>): number {
  const h = softSpacing(soft);
  return Math.max(0.05, 1.5 * (Number.isFinite(h) ? h : 0.1));
}

/** Soft-local rest point of a world hit point (the editor shows the un-deformed lattice at the document pose). */
export const restPointFromHit = (soft: Pose, hitWorld: Vec3): Vec3 => worldToLocal(soft, hitWorld);

/** The attachment record for "soft region around `hitWorld` fastened to a body". */
export function regionAttachment(
  soft: SoftEntity,
  hitWorld: Vec3,
  body: Pick<BodyEntity, 'id' | 'position' | 'rotation'>,
  joint?: string,
): SoftAttachment {
  const att: SoftAttachment = {
    id: uid('sa'),
    body: body.id,
    kind: 'region',
    center: restPointFromHit(soft, hitWorld),
    radius: defaultAttachRadius(soft),
    offset: worldToLocal(body, hitWorld),
  };
  if (joint) att.joint = joint;
  return att;
}

/** Hub fastening of a tyre: the rim ring, `offset` = body-local position of the tyre centre. */
export function rimAttachment(
  tyre: SoftEntity,
  body: Pick<BodyEntity, 'id' | 'position' | 'rotation'>,
): SoftAttachment {
  return {
    id: uid('sa'),
    body: body.id,
    kind: 'rim',
    center: [0, 0, 0],
    radius: Math.max(0.05, tyreGeometry(tyre.size).rimRadius),
    offset: worldToLocal(body, tyre.position),
  };
}

/** The rigid body a joint stands for: its non-world end (a dynamic one if both ends are bodies). */
export function jointBodyOf(
  j: Pick<JointEntity, 'bodyA' | 'bodyB'>,
  isDynamic: (id: string) => boolean,
): string | null {
  if (j.bodyA && !j.bodyB) return j.bodyA;
  if (j.bodyB && !j.bodyA) return j.bodyB;
  if (!j.bodyA || !j.bodyB) return null;
  return isDynamic(j.bodyB) || !isDynamic(j.bodyA) ? j.bodyB : j.bodyA;
}

/**
 * The cutting triangle: the viewer position and the two ends of the dragged line, pushed along the camera rays
 * to `distance + margin` so the triangle reaches beyond the cloth (a cut surface is the volume behind the line).
 */
export function cutTriangle(
  origin: Vec3,
  dirA: Vec3,
  dirB: Vec3,
  distance: number,
  margin = 5,
): { origin: Vec3; a: Vec3; b: Vec3 } {
  const d = Math.max(0.1, distance) + margin;
  return {
    origin,
    a: vadd(origin, vscale(vnorm(dirA, [0, 0, -1]), d)),
    b: vadd(origin, vscale(vnorm(dirB, [0, 0, -1]), d)),
  };
}

/** Distance from point `p` to segment `a`-`b` in 2D. */
export function distToSegment2(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

/** One link per 0.25 m, clamped to 4 … 40. */
export const ropeLinkCount = (distance: number): number => Math.max(4, Math.min(40, Math.round(distance / 0.25)));

/** Pose / size of a soft cable stretched between two points (local X along the cable, centred at the midpoint). */
export function cableBetween(
  start: Vec3,
  end: Vec3,
): Pick<SoftEntity, 'position' | 'rotation' | 'size' | 'resolution'> {
  const d = vdist(start, end);
  const dir = vnorm(vsub(end, start), [1, 0, 0]);
  return {
    position: vscale(vadd(start, end), 0.5),
    rotation: qfromUnitVectors([1, 0, 0], dir),
    size: [d, 0, 0],
    resolution: Math.max(4, Math.min(120, Math.round(d * 8))),
  };
}

/** Fasten an end of a cable to a body: an 8 cm region at the cable end, offset = body-local hit point. */
export function cableEndAttachment(
  cable: Pick<SoftEntity, 'size'>,
  atStart: boolean,
  hitWorld: Vec3,
  body: Pick<BodyEntity, 'id' | 'position' | 'rotation'>,
): SoftAttachment {
  return {
    id: uid('sa'),
    body: body.id,
    kind: 'region',
    center: [atStart ? -cable.size[0] / 2 : cable.size[0] / 2, 0, 0],
    radius: 0.08,
    offset: worldToLocal(body, hitWorld),
  };
}

/** Overrides for a soft copy of a rigid body (a mesh jelly with the same shape, size and pose). */
export function softCopyOf(b: BodyEntity, name: string): Partial<SoftEntity> {
  return {
    name,
    shape: { ...b.shape, size: [...b.shape.size] },
    size: [...b.shape.size],
    position: [...b.position],
    rotation: [...b.rotation],
  };
}

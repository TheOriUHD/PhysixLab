/**
 * Scaling a group about its pivot (pure, no store). Members keep their *world* pose in the document, so scaling a
 * group means: every posed descendant moves to `pivot + R·(F ⊙ R⁻¹(p − pivot))` (R = the group's rotation, F = the
 * factor along the group's own axes) and is resized to match.
 *
 * Exactness: a uniform factor is exact for everything. A non-uniform factor is exact for members whose axes line up
 * with the group's axes (the usual case: boxes in an axis-aligned assembly); a member turned by some other angle cannot
 * be sheared, so it gets the length each of its own axes takes after the scaling (the same rule `scaleParts` uses
 * for compound parts). `scaleGroupPatches` reports `approximate: true` in that case so the UI can say so.
 */
import { qconj, qmul, qrot, qrotInv, vadd, vlen, vnorm, vsub, type Quat, type Vec3 } from '../../core/math';
import { scaleParts } from '../compound';
import { childIndex } from '../groups';
import { normalizeShapeSize, shapeVolume } from '../shapeRegistry';
import type { Entity, GroupEntity, JointEntity, SoftEntity } from '../types';
import { isBody, isGroup, isJoint, isLight, isPath, isPosed, isSoft } from '../types';

export interface GroupScaleResult {
  patches: [string, Partial<Entity>][];
  /** Some member could not follow a non-uniform factor exactly (it is turned against the group's axes). */
  approximate: boolean;
  /** Locked members (and everything inside a locked sub-group) that were left alone. */
  skippedLocked: number;
}

/** Smallest factor along any axis (a group cannot be flattened or mirrored by this operation). */
export const MIN_GROUP_SCALE = 0.05;
export const MAX_GROUP_SCALE = 50;

export const clampFactor = (f: Vec3): Vec3 =>
  f.map((v) => Math.min(MAX_GROUP_SCALE, Math.max(MIN_GROUP_SCALE, Number.isFinite(v) ? v : 1))) as Vec3;

const geoMean = (f: Vec3): number => Math.cbrt(f[0] * f[1] * f[2]);

/** Per-local-axis factor of an entity turned by `rel` relative to the group's frame. */
export function localFactor(rel: Quat, F: Vec3): { f: Vec3; aligned: boolean } {
  const f: Vec3 = [1, 1, 1];
  let aligned = true;
  for (let i = 0; i < 3; i++) {
    const e: Vec3 = [0, 0, 0];
    e[i] = 1;
    const a = qrot(rel, e);
    f[i] = Math.hypot(a[0] * F[0], a[1] * F[1], a[2] * F[2]);
    // aligned = the axis lies on one group axis
    const big = a.filter((c) => Math.abs(c) > 1e-6).length;
    if (big > 1) aligned = false;
  }
  return { f, aligned };
}

/**
 * The patches that scale group `groupId` by `factor` (along the group's axes) about its pivot. The group itself
 * keeps pose and identity. Empty when the factor is 1 or the group does not exist.
 */
export function scaleGroupPatches(entities: readonly Entity[], groupId: string, factorIn: Vec3): GroupScaleResult {
  const group = entities.find((e): e is GroupEntity => e.id === groupId && isGroup(e));
  const none: GroupScaleResult = { patches: [], approximate: false, skippedLocked: 0 };
  if (!group) return none;
  const F = clampFactor(factorIn);
  if (F.every((v) => Math.abs(v - 1) < 1e-12)) return none;
  const uniform = Math.abs(F[0] - F[1]) < 1e-9 && Math.abs(F[1] - F[2]) < 1e-9;
  const P = group.position;
  const Rg = group.rotation;
  const point = (p: Vec3): Vec3 => {
    const l = qrotInv(Rg, vsub(p, P));
    return vadd(P, qrot(Rg, [l[0] * F[0], l[1] * F[1], l[2] * F[2]]));
  };
  const dir = (d: Vec3): Vec3 => {
    const l = qrotInv(Rg, d);
    return vnorm(qrot(Rg, [l[0] * F[0], l[1] * F[1], l[2] * F[2]]), d);
  };
  const index = childIndex(entities);
  const byId = new Map(entities.map((e) => [e.id, e]));
  // Locked members stay as they are (a locked sub-group keeps everything inside it); hidden ones scale.
  const moved = new Set<string>();
  const lockedSkip = new Set<string>();
  const walk = (id: string, locked: boolean) => {
    for (const cid of index.get(id) ?? []) {
      const c = byId.get(cid);
      if (!c || moved.has(cid) || lockedSkip.has(cid)) continue;
      const lock = locked || (isPosed(c) && !!c.locked);
      if (lock) lockedSkip.add(cid);
      else moved.add(cid);
      walk(cid, lock);
    }
  };
  walk(groupId, false);
  let skippedLocked = 0;
  for (const id of lockedSkip) {
    const e = byId.get(id);
    if (e && isPosed(e) && !isGroup(e)) skippedLocked++;
  }
  const patches: [string, Partial<Entity>][] = [];
  let approximate = false;
  /** body id → its per-local-axis size factor (after shape normalisation). */
  const bodyFactor = new Map<string, Vec3>();

  const relOf = (q: Quat): Quat => qmul(qconj(Rg), q);

  for (const id of moved) {
    const e = byId.get(id);
    if (!e || !isPosed(e)) continue;
    const position = point(e.position);
    if (isBody(e)) {
      const { f, aligned } = localFactor(relOf(e.rotation), F);
      if (!uniform && !aligned) approximate = true;
      const raw: Vec3 = [e.shape.size[0] * f[0], e.shape.size[1] * f[1], e.shape.size[2] * f[2]];
      const size = normalizeShapeSize(e.shape.type, raw, e.shape.params, e.shape.size);
      const eff = size.map((v, i) => (e.shape.size[i] > 1e-12 ? v / e.shape.size[i] : 1)) as Vec3;
      bodyFactor.set(e.id, eff);
      const shape = { ...e.shape, size };
      const patch: Partial<typeof e> = { position, shape };
      if (e.parts?.length) patch.parts = scaleParts(e.parts, eff);
      const vol = shapeVolume(e.shape);
      if (e.massOverride !== undefined && vol > 0) patch.massOverride = (e.massOverride * shapeVolume(shape)) / vol;
      if (e.comOverride)
        patch.comOverride = [e.comOverride[0] * eff[0], e.comOverride[1] * eff[1], e.comOverride[2] * eff[2]];
      patches.push([id, patch]);
    } else if (isSoft(e)) {
      const { f, aligned } = localFactor(relOf(e.rotation), F);
      if (!uniform && !aligned) approximate = true;
      patches.push([id, { position, ...softScale(e, f) }]);
    } else if (isPath(e)) {
      const { f, aligned } = localFactor(relOf(e.rotation), F);
      if (!uniform && !aligned) approximate = true;
      patches.push([id, { position, points: e.points.map((p) => [p[0] * f[0], p[1] * f[1], p[2] * f[2]] as Vec3) }]);
    } else if (isLight(e)) {
      const k = geoMean(F);
      const patch: Partial<typeof e> = { position };
      if (e.range > 0) patch.range = e.range * k;
      patch.size = [e.size[0] * k, e.size[1] * k];
      patches.push([id, patch]);
    } else {
      patches.push([id, { position }]); // sub-group pivot
    }
  }

  // Joints: body-local anchors follow their body's resize; world-frame ends follow the pivot scaling.
  const worldPos = (j: JointEntity, side: 'A' | 'B', anchor: Vec3, scaled: boolean): Vec3 | null => {
    const bodyId = side === 'A' ? j.bodyA : j.bodyB;
    if (bodyId === null) return scaled ? point(anchor) : anchor;
    const b = byId.get(bodyId);
    if (!b || !isBody(b)) return null;
    if (!scaled) return vadd(b.position, qrot(b.rotation, anchor));
    const f = bodyFactor.get(bodyId);
    if (!f) return vadd(b.position, qrot(b.rotation, anchor)); // outside the group: unchanged
    return vadd(point(b.position), qrot(b.rotation, [anchor[0] * f[0], anchor[1] * f[1], anchor[2] * f[2]]));
  };
  for (const j of entities) {
    if (!isJoint(j)) continue;
    const aIn = j.bodyA !== null && moved.has(j.bodyA);
    const bIn = j.bodyB !== null && moved.has(j.bodyB);
    const worldOnly = (j.bodyA === null && bIn) || (j.bodyB === null && aIn);
    if (!aIn && !bIn) continue;
    const patch: Partial<JointEntity> = {};
    if (aIn) {
      const f = bodyFactor.get(j.bodyA!)!;
      patch.anchorA = [j.anchorA[0] * f[0], j.anchorA[1] * f[1], j.anchorA[2] * f[2]];
      const ax: Vec3 = [j.axis[0] * f[0], j.axis[1] * f[1], j.axis[2] * f[2]];
      patch.axis = vnorm(ax, j.axis);
    } else if (j.bodyA === null && worldOnly) {
      patch.anchorA = point(j.anchorA);
      patch.axis = dir(j.axis);
    }
    if (bIn) {
      const f = bodyFactor.get(j.bodyB!)!;
      patch.anchorB = [j.anchorB[0] * f[0], j.anchorB[1] * f[1], j.anchorB[2] * f[2]];
    } else if (j.bodyB === null && worldOnly) patch.anchorB = point(j.anchorB);

    // Lengths: follow the real distance between the two anchors when both are known, else the mean factor.
    const before = (() => {
      const a = worldPos(j, 'A', j.anchorA, false);
      const b = worldPos(j, 'B', j.anchorB, false);
      return a && b ? vlen(vsub(a, b)) : 0;
    })();
    const after = (() => {
      const a = worldPos(j, 'A', j.anchorA, true);
      const b = worldPos(j, 'B', j.anchorB, true);
      return a && b ? vlen(vsub(a, b)) : 0;
    })();
    const ratio = before > 1e-6 && after > 0 ? after / before : geoMean(F);
    if (j.type === 'spring') patch.spring = { ...j.spring, restLength: j.spring.restLength * ratio };
    if (j.type === 'rope') patch.ropeLength = j.ropeLength * ratio;
    if (j.type === 'slider') {
      const f = aIn ? bodyFactor.get(j.bodyA!)! : ([1, 1, 1] as Vec3);
      const k = Math.hypot(j.axis[0] * f[0], j.axis[1] * f[1], j.axis[2] * f[2]) / Math.max(1e-9, vlen(j.axis));
      patch.limit = { ...j.limit, min: j.limit.min * k, max: j.limit.max * k };
      patch.motor = { ...j.motor, targetPosition: j.motor.targetPosition * k };
    }
    patches.push([j.id, patch]);
  }
  return { patches, approximate, skippedLocked };
}

/** Size / mass of a soft body scaled by per-local-axis factors `f`. */
function softScale(e: SoftEntity, f: Vec3): Partial<SoftEntity> {
  const m = (v: number) => Math.max(0.1, v);
  switch (e.type) {
    // mesh / tyre soft bodies: extents scale per axis like a jelly (their cell size / resolution fields are left as set)
    case 'jelly':
    case 'mesh':
    case 'tyre':
      return {
        size: [m(e.size[0] * f[0]), m(e.size[1] * f[1]), m(e.size[2] * f[2])],
        mass: e.mass * f[0] * f[1] * f[2],
      };
    case 'balloon': {
      const k = geoMean(f);
      return { size: [m(e.size[0] * k), m(e.size[1] * k), m(e.size[2] * k)], mass: e.mass * k * k };
    }
    case 'cloth':
      return { size: [m(e.size[0] * f[0]), 0, m(e.size[2] * f[2])], mass: e.mass * f[0] * f[2] };
    case 'cable':
      return { size: [m(e.size[0] * f[0]), 0, 0], mass: e.mass * f[0] };
  }
}

/**
 * Parse a typed scale factor: "2", "×1.5", "2 1 2" or "2,1,2" (x y z along the group's axes, a comma may be a
 * decimal comma only in the single-number form). Null for anything that is not 1 or 3 positive numbers.
 */
export function parseScaleFactor(text: string): Vec3 | null {
  const t = text.trim().replace(/^[x×*]\s*/i, '');
  if (!t) return null;
  const parts =
    t.includes(';') || /\s/.test(t) || (t.match(/,/g)?.length ?? 0) >= 2 ? t.split(/[\s,;]+/) : [t.replace(',', '.')];
  const nums = parts.filter((p) => p !== '').map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  if (nums.length === 1) return [nums[0], nums[0], nums[0]];
  if (nums.length === 3) return [nums[0], nums[1], nums[2]];
  return null;
}

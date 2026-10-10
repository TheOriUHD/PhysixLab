/**
 * ED-12: array tools (pure — no DOM, no three.js, no Rapier).
 *
 * A *placement* says where the reference frame of the source set goes for one copy: the reference point `ref` (the
 * centre of the selected objects) moves to `position`, and the set is turned by `rotation` and scaled by `scale`
 * about it. Every generator returns one placement per copy; the first placement of a linear, grid or radial array is
 * the identity (the original itself), a path array places `count` copies on the path and leaves the original alone.
 *
 *   linear   copy k at ref + k·offset, turned by k·stepRotation, scaled by stepScale^k
 *   grid     copy (i, j, k) at ref + (i·sx, j·sy, k·sz)
 *   radial   copy k turned by k·step about the axis through `center` (full circle: step = 360°/count, no copy at the
 *            end; an arc: step = angle/(count−1), both ends occupied); `orient` turns the copy with the circle
 *   path     copy k at arc length k·L/count (closed) or k·L/(count−1) (open) along the path, `orient`ed so the
 *            original's forward axis follows the tangent, the up axis kept as upright as the path allows
 *
 * `instantiateArray` clones the source set once per placement and moves each clone rigidly: poses, velocities
 * (rotated with the copy), world-anchored joint ends; joints inside the set are cloned per instance, joints to
 * bodies outside the set are not (a copy cannot share a hinge with the original). A *linked* array
 * (`buildLinkedArray` / `regenerateArray`) puts the copies under a group that stores the definition.
 */
import {
  DEG,
  qfromAxisAngle,
  qfromEuler,
  qmul,
  qnorm,
  qrot,
  vadd,
  vcross,
  vdot,
  vlen,
  vnorm,
  vscale,
  vsub,
  type Quat,
  type Vec3,
} from '../../core/math';
import { scaleParts } from '../compound';
import { createGroup } from '../factory';
import { descendantIds, childIndex, topLevel, withDescendants } from '../groups';
import { normalizeShapeSize } from '../shapeRegistry';
import { cloneEntities } from '../store';
import type { BodyEntity, Entity, GroupEntity, JointEntity, PathEntity, PosedEntity, SoftEntity } from '../types';
import { isBody, isGroup, isJoint, isPath, isPosed, isSoft } from '../types';
import { pathCurveOf } from '../path';
import {
  MAX_ARRAY_INSTANCES,
  specInstanceCount,
  type ArrayDef,
  type ArraySpec,
  type GridSpec,
  type LinearSpec,
  type PathArraySpec,
  type RadialSpec,
} from './arraySpec';

export interface Placement {
  /** Where the reference point goes. */
  position: Vec3;
  /** Rotation about the reference point. */
  rotation: Quat;
  /** Uniform scale about the reference point. */
  scale: number;
}

const IDENT: Quat = [0, 0, 0, 1];

// ── generators ──────────────────────────────────────────────────────────────────────────────────────────────

export function linearPlacements(s: LinearSpec, ref: Vec3): Placement[] {
  const out: Placement[] = [];
  const step = qfromEuler([s.stepRotation[0] * DEG, s.stepRotation[1] * DEG, s.stepRotation[2] * DEG]);
  let rot: Quat = IDENT;
  let scale = 1;
  for (let k = 0; k < s.count; k++) {
    out.push({ position: vadd(ref, vscale(s.offset, k)), rotation: rot, scale });
    rot = qnorm(qmul(step, rot));
    scale *= s.stepScale;
  }
  return out;
}

export function gridPlacements(s: GridSpec, ref: Vec3): Placement[] {
  const out: Placement[] = [];
  for (let k = 0; k < s.counts[2]; k++)
    for (let j = 0; j < s.counts[1]; j++)
      for (let i = 0; i < s.counts[0]; i++)
        out.push({
          position: [ref[0] + i * s.spacing[0], ref[1] + j * s.spacing[1], ref[2] + k * s.spacing[2]],
          rotation: IDENT,
          scale: 1,
        });
  return out;
}

export function radialPlacements(s: RadialSpec, ref: Vec3): Placement[] {
  const axis = vnorm(s.axis, [0, 1, 0]);
  const full = Math.abs(s.angle) >= 360 - 1e-9;
  const step = s.count <= 1 ? 0 : (full ? s.angle / s.count : s.angle / (s.count - 1)) * DEG;
  const rel = vsub(ref, s.center);
  const out: Placement[] = [];
  for (let k = 0; k < s.count; k++) {
    const r = qfromAxisAngle(axis, step * k);
    out.push({ position: vadd(s.center, qrot(r, rel)), rotation: s.orient ? r : IDENT, scale: 1 });
  }
  return out;
}

/** Rotation taking the local `forward` axis onto the unit vector `f`, with the local Y (Z for a Y-forward) axis kept upright. */
export function frameFromForward(f: Vec3, forward: 'x' | 'y' | 'z'): Quat {
  const up: Vec3 = forward === 'y' ? [0, 0, 1] : [0, 1, 0];
  let u = vsub(up, vscale(f, vdot(up, f)));
  if (vlen(u) < 1e-6) u = vsub(forward === 'y' ? [1, 0, 0] : [0, 0, 1], vscale(f, f[forward === 'y' ? 0 : 2]));
  u = vnorm(u);
  const w = vcross(f, u); // (f, u, w) is right-handed
  let X: Vec3, Y: Vec3, Z: Vec3;
  if (forward === 'x') [X, Y, Z] = [f, u, w];
  else if (forward === 'z')
    [X, Y, Z] = [vscale(w, -1), u, f]; // X = Y × Z
  else [X, Y, Z] = [w, f, u]; // Y forward, Z up: X = Y × Z
  return basisToQuat(X, Y, Z);
}

/** Quaternion of the rotation whose columns are the orthonormal right-handed vectors X, Y, Z. */
export function basisToQuat(X: Vec3, Y: Vec3, Z: Vec3): Quat {
  const m00 = X[0],
    m10 = X[1],
    m20 = X[2];
  const m01 = Y[0],
    m11 = Y[1],
    m21 = Y[2];
  const m02 = Z[0],
    m12 = Z[1],
    m22 = Z[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return qnorm([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return qnorm([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return qnorm([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return qnorm([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}

/** Copies along a path at equal arc-length spacing. An unknown / degenerate path yields no placements. */
export function pathPlacements(s: PathArraySpec, path: PathEntity | undefined): Placement[] {
  if (!path || path.points.length < 2) return [];
  const curve = pathCurveOf(path);
  const L = curve.length;
  if (!(L > 0)) return [];
  const closed = curve.closed;
  const out: Placement[] = [];
  for (let k = 0; k < s.count; k++) {
    const d = s.count <= 1 ? 0 : closed ? (k * L) / s.count : (k * L) / (s.count - 1);
    const p = curve.positionAtDistance(d);
    if (s.orient) {
      const rot = frameFromForward(curve.tangentAtDistance(d), s.forward);
      out.push({ position: vadd(p, qrot(rot, s.offset)), rotation: rot, scale: 1 });
    } else {
      out.push({ position: vadd(p, s.offset), rotation: IDENT, scale: 1 });
    }
  }
  return out;
}

/** All placements of a spec (the original's own slot included for linear / grid / radial). */
export function placementsFor(spec: ArraySpec, ref: Vec3, pathOf: (id: string) => PathEntity | undefined): Placement[] {
  switch (spec.kind) {
    case 'linear':
      return linearPlacements(spec, ref);
    case 'grid':
      return gridPlacements(spec, ref);
    case 'radial':
      return radialPlacements(spec, ref);
    case 'path':
      return pathPlacements(spec, pathOf(spec.pathId));
  }
}

/** The placements that need new objects: the original already occupies the first slot of linear / grid / radial. */
export function newPlacements(spec: ArraySpec, ref: Vec3, pathOf: (id: string) => PathEntity | undefined): Placement[] {
  const all = placementsFor(spec, ref, pathOf);
  return spec.kind === 'path' ? all : all.slice(1);
}

/** Centre of the source set: the mean position of its top-level objects. */
export function referencePoint(all: readonly Entity[], ids: readonly string[]): Vec3 {
  const byId = new Map(all.map((e) => [e.id, e]));
  const roots = topLevel((id) => byId.get(id), [...ids])
    .map((id) => byId.get(id))
    .filter((e): e is PosedEntity => isPosed(e));
  if (!roots.length) return [0, 0, 0];
  const sum = roots.reduce<Vec3>((a, e) => vadd(a, e.position), [0, 0, 0]);
  return vscale(sum, 1 / roots.length);
}

// ── moving a cloned set ─────────────────────────────────────────────────────────────────────────────────────

const scale3 = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

/**
 * Apply a placement to freshly cloned entities (mutates and returns the same objects): positions move as
 * `position + scale·R·(p − ref)`, rotations compose, initial velocities rotate, sizes / anchors / lengths scale,
 * world-anchored joint ends move like points.
 */
export function placeEntities(list: Entity[], ref: Vec3, pl: Placement): Entity[] {
  const R = pl.rotation;
  const s = pl.scale;
  const turns = Math.abs(R[0]) + Math.abs(R[1]) + Math.abs(R[2]) > 1e-12;
  const point = (p: Vec3): Vec3 => vadd(pl.position, scale3(qrot(R, vsub(p, ref)), s));
  const dir = (d: Vec3): Vec3 => qrot(R, d);
  const scaled = s !== 1;
  for (const e of list) {
    if (isJoint(e)) {
      const j: JointEntity = e;
      if (j.bodyA === null) {
        j.anchorA = point(j.anchorA);
        j.axis = dir(j.axis);
      } else if (scaled) j.anchorA = scale3(j.anchorA, s);
      if (j.bodyB === null) j.anchorB = point(j.anchorB);
      else if (scaled) j.anchorB = scale3(j.anchorB, s);
      if (scaled) {
        j.ropeLength *= s;
        j.spring = { ...j.spring, restLength: j.spring.restLength * s };
      }
      continue;
    }
    if (!isPosed(e)) continue;
    e.position = point(e.position);
    e.rotation = qnorm(qmul(R, e.rotation));
    if (isBody(e)) {
      const b: BodyEntity = e;
      if (turns) {
        b.velocity = dir(b.velocity);
        b.angularVelocity = dir(b.angularVelocity);
      }
      if (scaled) {
        const size = normalizeShapeSize(b.shape.type, scale3(b.shape.size, s), b.shape.params, b.shape.size);
        b.shape = { ...b.shape, size };
        if (b.parts?.length) b.parts = scaleParts(b.parts, [s, s, s]);
        if (b.comOverride) b.comOverride = scale3(b.comOverride, s);
        if (b.massOverride !== undefined) b.massOverride *= s * s * s;
      }
    } else if (isSoft(e) && scaled) {
      const so: SoftEntity = e;
      so.size = scale3(so.size, s);
      so.mass *= s * s * s;
    } else if (isPath(e) && scaled) {
      e.points = e.points.map((p) => scale3(p, s));
    }
  }
  return list;
}

// ── instantiating ───────────────────────────────────────────────────────────────────────────────────────────

export interface InstantiateOptions {
  /** Group the top-level copies of every instance are put under (the linked array's group). */
  parent?: string;
  /** Name of a copy of `name` made for placement `index` (default: keep the name). */
  rename?: (name: string, index: number) => string;
}

export interface Instances {
  /** Everything to add, instance by instance (posed entities first, then their joints). */
  entities: Entity[];
  /** Top-level copies (not inside another copy). */
  roots: string[];
}

/** The sources and what travels with them: their descendants and every joint (cloneEntities decides which count). */
function sourceSubset(all: readonly Entity[], ids: readonly string[]): { sub: Entity[]; set: Set<string> } {
  const list = [...all];
  const set = withDescendants(list, ids);
  return { sub: list.filter((e) => isJoint(e) || set.has(e.id)), set };
}

/**
 * One rigid copy of the source set per placement. `ids` are the source objects (a group brings its members).
 * Joints between bodies of the set are cloned per copy; joints to bodies outside the set are not.
 */
export function instantiateArray(
  all: readonly Entity[],
  ids: readonly string[],
  placements: readonly Placement[],
  ref: Vec3,
  opts: InstantiateOptions = {},
): Instances {
  const { sub } = sourceSubset(all, ids);
  const entities: Entity[] = [];
  const roots: string[] = [];
  placements.forEach((pl, index) => {
    const idMap = new Map<string, string>();
    const clones = cloneEntities(sub, [...ids], [0, 0, 0], idMap);
    const cloned = new Set(clones.map((c) => c.id));
    placeEntities(clones, ref, pl);
    for (const c of clones) {
      if (!isPosed(c)) continue;
      if (opts.rename) c.name = opts.rename(c.name, index);
      if (c.parent === undefined || !cloned.has(c.parent)) {
        roots.push(c.id);
        if (opts.parent !== undefined) c.parent = opts.parent;
      }
    }
    entities.push(...clones);
  });
  return { entities, roots };
}

/** Why an array cannot be generated, or null. */
export function arrayProblem(all: readonly Entity[], ids: readonly string[], spec: ArraySpec): string | null {
  const byId = new Map(all.map((e) => [e.id, e]));
  if (!ids.length || !ids.every((id) => byId.has(id))) return 'The original objects are gone.';
  if (spec.kind === 'path') {
    const p = byId.get(spec.pathId);
    if (!isPath(p)) return 'Pick a path to follow (add one from Add ▸ Path).';
    if (p.points.length < 2) return 'The path needs at least two points.';
    if (ids.includes(spec.pathId)) return 'A path cannot be arrayed along itself.';
  }
  const { set } = sourceSubset(all, ids);
  if (specInstanceCount(spec) * Math.max(1, set.size) > MAX_ARRAY_INSTANCES * 4)
    return `That would create too many objects (limit ${MAX_ARRAY_INSTANCES * 4}).`;
  return null;
}

// ── linked arrays ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A linked array: a group at the reference point whose children are the generated copies, and which stores the
 * definition (`group.array`). The source objects stay where they are, outside the group.
 */
export function buildLinkedArray(
  all: readonly Entity[],
  ids: readonly string[],
  spec: ArraySpec,
  name = 'Array',
): { group: GroupEntity; entities: Entity[] } {
  const roots = topLevel((id) => all.find((e) => e.id === id), [...ids]);
  const ref = referencePoint(all, roots);
  const pathOf = (id: string) => all.find((e): e is PathEntity => e.id === id && isPath(e));
  const group = createGroup({ name, position: ref, array: { sourceIds: roots, spec } });
  const placements = newPlacements(spec, ref, pathOf);
  const inst = instantiateArray(all, roots, placements, ref, { parent: group.id });
  return { group, entities: inst.entities };
}

export interface Regeneration {
  /** Ids to remove (the current copies, joints included). */
  remove: string[];
  /** The fresh copies. */
  add: Entity[];
  /** New pivot of the group. */
  group: Partial<GroupEntity>;
}

/**
 * Rebuild the copies of the linked array held by group `groupId` (after its parameters or its sources changed).
 * Returns null when the id is not a linked array; throws an Error with a user-readable message when the sources or
 * the path are gone.
 */
export function regenerateArray(all: readonly Entity[], groupId: string, spec?: ArraySpec): Regeneration | null {
  const group = all.find((e): e is GroupEntity => e.id === groupId && isGroup(e));
  if (!group?.array) return null;
  const def: ArrayDef = { sourceIds: group.array.sourceIds, spec: spec ?? group.array.spec };
  const problem = arrayProblem(all, def.sourceIds, def.spec);
  if (problem) throw new Error(problem);
  const index = childIndex(all);
  const below = new Set(descendantIds(index, groupId));
  const sources = def.sourceIds.filter((id) => !below.has(id));
  const rest = all.filter(
    (e) => !below.has(e.id) && !(isJoint(e) && (below.has(e.bodyA ?? '') || below.has(e.bodyB ?? ''))),
  );
  const ref = referencePoint(rest, sources);
  const pathOf = (id: string) => rest.find((e): e is PathEntity => e.id === id && isPath(e));
  const placements = newPlacements(def.spec, ref, pathOf);
  const inst = instantiateArray(rest, sources, placements, ref, { parent: groupId });
  // Every joint attached to a removed body goes with it (the store does that too; list them for the caller's labels).
  const remove = [
    ...below,
    ...all.filter((e) => isJoint(e) && (below.has(e.bodyA ?? '') || below.has(e.bodyB ?? ''))).map((e) => e.id),
  ];
  return {
    remove: [...new Set(remove)],
    add: inst.entities,
    group: { array: { sourceIds: sources, spec: def.spec }, position: ref },
  };
}

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────

/** An oriented box in world space. */
export interface OrientedBox {
  center: Vec3;
  rotation: Quat;
  half: Vec3;
}

function aabbOfPoints(pts: Vec3[]): { c: Vec3; h: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  return {
    c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    h: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2],
  };
}

const CORNERS: Vec3[] = [
  [-1, -1, -1],
  [1, -1, -1],
  [-1, 1, -1],
  [1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [-1, 1, 1],
  [1, 1, 1],
];
const EDGES: [number, number][] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** Boxes (in world space) that outline the source set: one per body / soft body / light / path below `ids`. */
export function sourceBoxes(all: readonly Entity[], ids: readonly string[]): OrientedBox[] {
  const set = withDescendants([...all], ids);
  const out: OrientedBox[] = [];
  for (const e of all) {
    if (!set.has(e.id) || !isPosed(e) || isGroup(e)) continue;
    let local: { c: Vec3; h: Vec3 };
    if (isBody(e)) {
      if (e.parts?.length) {
        const pts: Vec3[] = [];
        for (const p of e.parts)
          for (const k of CORNERS)
            pts.push(
              vadd(
                p.position,
                qrot(p.rotation, [
                  (k[0] * p.shape.size[0]) / 2,
                  (k[1] * p.shape.size[1]) / 2,
                  (k[2] * p.shape.size[2]) / 2,
                ]),
              ),
            );
        local = aabbOfPoints(pts);
      } else local = { c: [0, 0, 0], h: scale3(e.shape.size, 0.5) };
    } else if (isSoft(e)) {
      const [x, y, z] = e.size;
      const dims: Vec3 =
        e.type === 'cloth'
          ? [x, 0.04, z]
          : e.type === 'cable'
            ? [x, 0.06, 0.06]
            : e.type === 'balloon'
              ? [x, x, x]
              : [x, y, z];
      local = { c: [0, 0, 0], h: scale3(dims, 0.5) };
    } else if (isPath(e)) {
      local = aabbOfPoints(e.points.length ? e.points : [[0, 0, 0]]);
      local.h = [Math.max(local.h[0], 0.05), Math.max(local.h[1], 0.05), Math.max(local.h[2], 0.05)];
    } else local = { c: [0, 0, 0], h: [0.15, 0.15, 0.15] };
    out.push({ center: vadd(e.position, qrot(e.rotation, local.c)), rotation: e.rotation, half: local.h });
  }
  return out;
}

/**
 * Line segments (x, y, z pairs) outlining every box at every placement — the live preview. At most `maxBoxes` boxes
 * are drawn in total (the rest of the placements are skipped, `truncated` says so).
 */
export function previewSegments(
  boxes: readonly OrientedBox[],
  placements: readonly Placement[],
  ref: Vec3,
  maxBoxes = 4000,
): { positions: Float32Array; boxes: number; truncated: boolean } {
  const total = Math.min(maxBoxes, boxes.length * placements.length);
  const positions = new Float32Array(total * 24 * 3);
  let n = 0;
  let o = 0;
  const corner: Vec3[] = CORNERS.map(() => [0, 0, 0] as Vec3);
  outer: for (const pl of placements) {
    for (const b of boxes) {
      if (n >= total) break outer;
      const c = vadd(pl.position, scale3(qrot(pl.rotation, vsub(b.center, ref)), pl.scale));
      const r = qnorm(qmul(pl.rotation, b.rotation));
      for (let k = 0; k < 8; k++) {
        const q = qrot(r, [
          CORNERS[k][0] * b.half[0] * pl.scale,
          CORNERS[k][1] * b.half[1] * pl.scale,
          CORNERS[k][2] * b.half[2] * pl.scale,
        ]);
        corner[k] = [c[0] + q[0], c[1] + q[1], c[2] + q[2]];
      }
      for (const [a, bIdx] of EDGES) {
        positions.set(corner[a], o);
        positions.set(corner[bIdx], o + 3);
        o += 6;
      }
      n++;
    }
  }
  return { positions, boxes: n, truncated: boxes.length * placements.length > total };
}

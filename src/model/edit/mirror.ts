/**
 * ED-11: mirroring (pure — no DOM, no three.js, no Rapier).
 *
 * # The geometry
 *
 * A reflection `S = I − 2·n·nᵀ` about a plane is improper (det −1), but a rigid body can only be rotated. The mirror
 * image of a body B (pose `p, R`, colliders given in its local frame) is therefore the body whose colliders are the
 * image of B's colliders. We get it by absorbing the reflection into a *local* flip `M_i` of one body axis `i`
 * (x → −x, say) that is a symmetry of the body's collider set:
 *
 *     new position   p′ = S·p
 *     new rotation   R′ = S·R·M_i          (det = (−1)(+1)(−1) = +1, a proper rotation)
 *     collider at local point r  ↦  local point M_i·r    (identity for a shape that is symmetric under M_i)
 *
 * because `p′ + R′·(M_i·r) = S·p + S·R·r = S·(p + R·r)`. Writing `S = −P_n` and `M_i = −P_i` (`P_v` = half-turn about
 * the axis v, quaternion `(v, 0)`) the minus signs cancel: **q′ = P_n · q · P_i**. Both reflections are involutions,
 * so mirroring twice with the same `i` returns the original.
 *
 * Which axis `i`? Any symmetry axis of the body's collider set works, and each gives an equally exact mirror image;
 * the one chosen is the one that turns the body least (a box at identity mirrored about X stays at identity).
 *   - box / sphere / icosahedron / compound bodies: any axis (a compound's parts are flipped instead, see below);
 *   - cylinder / capsule: any axis; cone: x or z; wedge: x (its slope is along z);
 *   - prism: x and y, and z when it has an even number of sides — found by testing the hull's vertices;
 *   - soft bodies, lights, paths, groups: see `softAxes` / `lightAxes`.
 * A *chiral* part list is handled exactly: part `k` at `(pos, rot)` becomes `(M_i·pos, P_i·rot·P_j)` where `j` is a
 * symmetry axis of that part's own shape. An unknown plugin shape without `convexPoints` is mirrored about its local
 * x axis and reported as `approximate`.
 *
 * Vector quantities follow their type: points and polar vectors (velocity, force, slider axis) reflect with S, axial
 * vectors (angular velocity, torque, hinge axis) with −S. A hinge keeps its limits, motor sign and angle convention:
 * the mirror image of "B turns by θ about a" is "B′ turns by θ about −M_i·a".
 */
import { qangle, qmul, qnorm, vdot, vlen, vnorm, vscale, vsub, type Quat, type Vec3 } from '../../core/math';
import { decodeMesh, makeMeshAsset } from '../assets';
import { shapeConvexPoints } from '../shapeRegistry';
import { cloneEntities } from '../store';
import { withDescendants } from '../groups';
import type {
  BodyEntity,
  ColliderPart,
  ComponentSpec,
  Entity,
  GroupEntity,
  JointEntity,
  LightEntity,
  MeshAsset,
  PathEntity,
  PosedEntity,
  ShapeSpec,
  SoftEntity,
} from '../types';
import { isBody, isJoint, isLight, isPath, isPosed, isSoft } from '../types';

export type Axis = 0 | 1 | 2;
export const AXES: readonly Axis[] = [0, 1, 2];
export const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/** A mirror plane: all points `p` with `(p − point)·normal = 0`. `normal` has unit length. */
export interface MirrorPlane {
  point: Vec3;
  normal: Vec3;
}

/** The plane perpendicular to a world axis at `offset` metres along it (axis 0 = the YZ plane x = offset …). */
export function axisPlane(axis: Axis, offset = 0): MirrorPlane {
  const normal: Vec3 = [0, 0, 0];
  normal[axis] = 1;
  const point: Vec3 = [0, 0, 0];
  point[axis] = offset;
  return { point, normal };
}

/** A plane through `point` with the given (any length) normal; a zero normal falls back to +X. */
export function makePlane(point: Vec3, normal: Vec3): MirrorPlane {
  return { point: [...point], normal: vnorm(normal, [1, 0, 0]) };
}

/** Mirror image of a point. */
export function reflectPoint(pl: MirrorPlane, p: Vec3): Vec3 {
  const d = vdot(vsub(p, pl.point), pl.normal);
  return vsub(p, vscale(pl.normal, 2 * d));
}

/** Mirror image of a polar vector (velocity, force, a direction). */
export function reflectDir(pl: MirrorPlane, v: Vec3): Vec3 {
  return vsub(v, vscale(pl.normal, 2 * vdot(v, pl.normal)));
}

/** Mirror image of an axial vector (angular velocity, torque, a rotation axis): `−S·v`. */
export function reflectAxial(pl: MirrorPlane, v: Vec3): Vec3 {
  return vscale(reflectDir(pl, v), -1);
}

/** Flip component `i` of a local-frame vector (the local mirror `M_i`). */
export function flipLocal(v: Vec3, i: Axis): Vec3 {
  const o: Vec3 = [v[0], v[1], v[2]];
  o[i] = -o[i];
  return o;
}

/** Local flip of an axial vector (`−M_i·v`). */
const flipLocalAxial = (v: Vec3, i: Axis): Vec3 => vscale(flipLocal(v, i), -1);

/** Half-turn about the unit vector `v` as a quaternion. */
const half = (v: Vec3): Quat => [v[0], v[1], v[2], 0];
const unitAxis = (i: Axis): Quat => {
  const q: Quat = [0, 0, 0, 0];
  q[i] = 1;
  return q;
};

/** `q′ = P_n · q · P_i` — the rotation of the mirror image of a body at rotation `q` (see the file comment). */
export function mirrorRotation(pl: MirrorPlane, q: Quat, i: Axis): Quat {
  return qnorm(qmul(qmul(half(pl.normal), q), unitAxis(i)));
}

/** Pose of the mirror image of a body pose about `pl` with local flip axis `i`. */
export function mirrorPose(
  pl: MirrorPlane,
  position: Vec3,
  rotation: Quat,
  i: Axis,
): { position: Vec3; rotation: Quat } {
  return { position: reflectPoint(pl, position), rotation: mirrorRotation(pl, rotation, i) };
}

/** Of the allowed local axes, the one whose mirror image turns the body least. */
export function chooseAxis(pl: MirrorPlane, q: Quat, allowed: readonly Axis[]): Axis {
  let best: Axis = allowed[0] ?? 0;
  let bestAngle = Infinity;
  for (const i of allowed) {
    const a = qangle(mirrorRotation(pl, q, i), q);
    if (a < bestAngle - 1e-9) {
      bestAngle = a;
      best = i;
    }
  }
  return best;
}

// ── which local flips are symmetries? ───────────────────────────────────────────────────────────────────────

/** Shapes whose symmetry is known without looking at points (they have no `convexPoints`). */
const KNOWN_SYMMETRY: Record<string, readonly Axis[]> = {
  sphere: [0, 1, 2],
  cylinder: [0, 1, 2],
  capsule: [0, 1, 2],
  cone: [0, 2],
};

export interface ShapeSymmetry {
  axes: readonly Axis[];
  /** False when nothing is known about the shape (a plugin shape without `convexPoints`): x is assumed. */
  exact: boolean;
}

/** Local axes `i` for which the shape is mapped onto itself by x_i → −x_i. */
export function shapeSymmetry(spec: ShapeSpec): ShapeSymmetry {
  const known = KNOWN_SYMMETRY[spec.type];
  if (known) return { axes: known, exact: true };
  const pts = shapeConvexPoints(spec);
  if (!pts || !pts.length) return { axes: [0], exact: false };
  const scale = Math.max(1e-6, ...pts.map((p) => vlen(p)));
  const tol = 1e-6 * scale + 1e-9;
  const axes = AXES.filter((i) =>
    pts.every((p) => {
      const f = flipLocal(p, i);
      return pts.some((q) => Math.abs(q[0] - f[0]) < tol && Math.abs(q[1] - f[1]) < tol && Math.abs(q[2] - f[2]) < tol);
    }),
  );
  return { axes: axes.length ? axes : [0], exact: axes.length > 0 };
}

/** Symmetry axes of a soft body's lattice *including its pin pattern* (so the pinned particles stay the pinned ones). */
export function softAxes(s: SoftEntity): readonly Axis[] {
  switch (s.type) {
    case 'jelly':
    case 'balloon':
    case 'tyre': // a torus: symmetric under every coordinate flip
      return [0, 1, 2];
    case 'mesh':
      return [...shapeSymmetry(s.shape).axes];
    case 'cloth':
      // Lies in local XZ with its pinned edge at local z = −depth/2: x and y flips keep that edge, z does not.
      return s.pin === 'none' || s.pin === 'corners4' ? [0, 1, 2] : [0, 1];
    case 'cable':
      // Runs along local x with its first particle at x = −L/2: an x flip would move a one-end pin to the other end.
      return s.pin === 'none' || s.pin === 'ends' ? [0, 1, 2] : [1, 2];
  }
}

/** A light shines along local −Z: flips of x and y keep the cone (and the rectangle of an area light). */
export const lightAxes = (l: LightEntity): readonly Axis[] => (l.lightType === 'point' ? [0, 1, 2] : [0, 1]);

/** Allowed local flip axes of any posed entity, and whether the answer is exact. */
export function symmetryAxes(e: PosedEntity): ShapeSymmetry {
  if (isBody(e)) {
    if (e.parts && e.parts.length)
      return { axes: [0, 1, 2], exact: e.parts.every((p) => shapeSymmetry(p.shape).exact) };
    return shapeSymmetry(e.shape);
  }
  if (isSoft(e)) return { axes: softAxes(e), exact: true };
  if (isLight(e)) return { axes: lightAxes(e), exact: true };
  return { axes: [0, 1, 2], exact: true };
}

// ── components ──────────────────────────────────────────────────────────────────────────────────────────────

/** What a component hook gets: the plane and the local flip axis of the body that owns the component. */
export interface ComponentMirrorContext {
  plane: MirrorPlane;
  axis: Axis;
}
/** Mirrors the `params` of one component type (returns the parameters of the mirror image). */
export type ComponentMirror = (params: ComponentSpec['params'], ctx: ComponentMirrorContext) => ComponentSpec['params'];

const componentMirrors = new Map<string, ComponentMirror>();

/** Teach mirroring about a component type whose parameters hold directions or body-frame points. */
export function registerComponentMirror(type: string, fn: ComponentMirror): () => void {
  componentMirrors.set(type, fn);
  return () => componentMirrors.delete(type);
}

const asVec = (v: unknown): Vec3 | null =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? (v as Vec3) : null;

// constantForce: force/torque in world axes (S / −S) or body axes (M_i / −M_i); `point` is a body-frame point.
registerComponentMirror('constantForce', (p, { plane, axis }) => {
  const out = { ...p };
  const local = p.space === 'local';
  const f = asVec(p.force);
  const t = asVec(p.torque);
  const pt = asVec(p.point);
  if (f) out.force = local ? flipLocal(f, axis) : reflectDir(plane, f);
  if (t) out.torque = local ? flipLocalAxial(t, axis) : reflectAxial(plane, t);
  if (pt) out.point = flipLocal(pt, axis);
  return out;
});
// sineMover: a world direction of travel.
registerComponentMirror('sineMover', (p, { plane }) => {
  const a = asVec(p.axis);
  return a ? { ...p, axis: reflectDir(plane, a) } : { ...p };
});

/** The components of a mirrored body: same ids, mirrored parameters. Unknown types are copied unchanged. */
export function mirrorComponents(
  components: readonly ComponentSpec[],
  plane: MirrorPlane,
  axis: Axis,
): ComponentSpec[] {
  return components.map((c) => {
    const fn = componentMirrors.get(c.type);
    return fn ? { ...c, params: fn(c.params, { plane, axis }) } : { ...c, params: { ...c.params } };
  });
}

// ── per-entity mirrored fields ──────────────────────────────────────────────────────────────────────────────

export interface MirrorOptions {
  /** Asset id of the mirror image of a mesh (flipped along local axis `axis`); undefined = keep the original. */
  mirrorMesh?: (meshId: string, axis: Axis) => string | undefined;
}

/** Parts of a compound, mirrored about the body-local flip `i` (see the file comment). */
export function mirrorParts(parts: readonly ColliderPart[], i: Axis): ColliderPart[] {
  return parts.map((p) => {
    const sym = shapeSymmetry(p.shape);
    // Part shape symmetry axis j chosen so the part turns least: R″ = M_i·R_p·M_j  ⇒  q″ = P_i·q_p·P_j.
    let best: Axis = sym.axes[0] ?? 0;
    let bestAngle = Infinity;
    for (const j of sym.axes) {
      const q = qnorm(qmul(qmul(unitAxis(i), p.rotation), unitAxis(j)));
      const a = qangle(q, p.rotation);
      if (a < bestAngle - 1e-9) {
        bestAngle = a;
        best = j;
      }
    }
    return {
      ...p,
      position: flipLocal(p.position, i),
      rotation: qnorm(qmul(qmul(unitAxis(i), p.rotation), unitAxis(best))),
    };
  });
}

/**
 * The fields of `e` that change when it is mirrored with local flip axis `i`; everything else (shape, material,
 * name …) is identical in the mirror image. Components keep their ids here — the callers that need new ids clone
 * first. Joints are handled by `mirrorJointFields`.
 */
export function mirrorFields(e: PosedEntity, pl: MirrorPlane, i: Axis, opts: MirrorOptions = {}): Partial<Entity> {
  const pose = mirrorPose(pl, e.position, e.rotation, i);
  if (isBody(e)) {
    const f: Partial<BodyEntity> = {
      ...pose,
      velocity: reflectDir(pl, e.velocity),
      angularVelocity: reflectAxial(pl, e.angularVelocity),
    };
    if (e.thrust)
      f.thrust = { ...e.thrust, force: flipLocal(e.thrust.force, i), torque: flipLocalAxial(e.thrust.torque, i) };
    if (e.comOverride) f.comOverride = flipLocal(e.comOverride, i);
    if (e.parts && e.parts.length) f.parts = mirrorParts(e.parts, i);
    if (e.meshId && opts.mirrorMesh) {
      const m = opts.mirrorMesh(e.meshId, i);
      if (m) f.meshId = m;
    }
    if (e.components.length) f.components = mirrorComponents(e.components, pl, i);
    return f;
  }
  if (isPath(e)) {
    const f: Partial<PathEntity> = { ...pose, points: e.points.map((p) => flipLocal(p, i)) };
    return f;
  }
  const f: Partial<SoftEntity | LightEntity | GroupEntity> = pose;
  return f;
}

/**
 * The mirrored anchors and axis of a joint. `axisA` / `axisB` are the local flip axes of the bodies on each side
 * (`undefined` = that side's body is not mirrored and keeps its local frame); a world-anchored side (`bodyA`/`bodyB`
 * null) has its world coordinates reflected instead. Limits, motor and spring need no change (file comment).
 */
export function mirrorJointFields(
  j: JointEntity,
  pl: MirrorPlane,
  axisA: Axis | undefined,
  axisB: Axis | undefined,
): Partial<JointEntity> {
  const f: Partial<JointEntity> = {};
  if (j.bodyA === null) f.anchorA = reflectPoint(pl, j.anchorA);
  else if (axisA !== undefined) f.anchorA = flipLocal(j.anchorA, axisA);
  if (j.bodyB === null) f.anchorB = reflectPoint(pl, j.anchorB);
  else if (axisB !== undefined) f.anchorB = flipLocal(j.anchorB, axisB);
  // The axis lives in A's frame (world frame for a world-anchored A). A hinge axis is axial, a slider axis polar.
  const axial = j.type === 'hinge';
  if (j.bodyA === null) f.axis = axial ? reflectAxial(pl, j.axis) : reflectDir(pl, j.axis);
  else if (axisA !== undefined) f.axis = axial ? flipLocalAxial(j.axis, axisA) : flipLocal(j.axis, axisA);
  return f;
}

// ── soft-body attachments (SF) ───────────────────────────────────────────────────────────────────────────────

/**
 * Attachments of a mirrored soft body: the fastening region (soft rest frame) flips with the soft body's own axis,
 * the body-local offset flips with the attached body's axis. Attachments to bodies that are not mirrored cannot
 * follow (the fastening point would not coincide) and are dropped. `rename` maps a body / joint id to its mirror
 * image (copy mode) or returns it unchanged (flip mode).
 */
function mirrorAttachments(
  s: SoftEntity,
  softAxis: Axis,
  bodyAxis: (id: string) => Axis | undefined,
  rename: (id: string) => string | undefined,
): SoftEntity['attachments'] {
  const out: SoftEntity['attachments'] = [];
  for (const a of s.attachments ?? []) {
    const ax = bodyAxis(a.body);
    const body = rename(a.body);
    if (ax === undefined || body === undefined) continue;
    const joint = a.joint === undefined ? undefined : rename(a.joint);
    const { joint: _old, ...rest } = a;
    out.push({
      ...rest,
      body,
      center: flipLocal(a.center, softAxis),
      offset: flipLocal(a.offset, ax),
      ...(joint ? { joint } : {}),
    });
  }
  return out;
}

// ── mesh assets ─────────────────────────────────────────────────────────────────────────────────────────────

/** The mirror image of a mesh asset: vertex (and normal) component `axis` negated, triangle winding reversed. */
export function mirrorMeshAsset(a: MeshAsset, axis: Axis): ReturnType<typeof makeMeshAsset> {
  const d = decodeMesh(a);
  const positions = Float32Array.from(d.positions);
  for (let k = axis; k < positions.length; k += 3) positions[k] = -positions[k];
  const indices = Uint32Array.from(d.indices);
  for (let k = 0; k + 2 < indices.length; k += 3) {
    const t = indices[k + 1];
    indices[k + 1] = indices[k + 2];
    indices[k + 2] = t;
  }
  let normals: Float32Array | undefined;
  if (d.normals) {
    normals = Float32Array.from(d.normals);
    for (let k = axis; k < normals.length; k += 3) normals[k] = -normals[k];
  }
  return makeMeshAsset(`${a.name} (mirrored)`, {
    positions,
    indices,
    ...(normals ? { normals } : {}),
    ...(d.uvs ? { uvs: d.uvs } : {}),
    ...(a.materials ? { materials: a.materials } : {}),
    ...(a.groups ? { groups: a.groups } : {}),
  });
}

// ── mirror copy / flip of a set ─────────────────────────────────────────────────────────────────────────────

export interface MirrorResult {
  /** Copy mode: the new entities (bodies, …, and the joints that connect only mirrored bodies). */
  entities: Entity[];
  /** Flip mode: patches to apply with `store.updateMany`. */
  patches: [string, Partial<Entity>][];
  /** Original id → id of its mirror image (copy mode) — the symmetry pairs. */
  idMap: Map<string, string>;
  /** Original id → local flip axis used for it. */
  axes: Map<string, Axis>;
  /** Joints left out of a copy because one end is a body that was not mirrored. */
  skippedJoints: number;
  /** Locked entities a flip left alone. */
  skippedLocked: number;
  /** Entities mirrored about the local x axis only because the shape's symmetry is unknown. */
  approximate: number;
}

const emptyResult = (): MirrorResult => ({
  entities: [],
  patches: [],
  idMap: new Map(),
  axes: new Map(),
  skippedJoints: 0,
  skippedLocked: 0,
  approximate: 0,
});

function pickAxes(
  all: readonly Entity[],
  ids: Set<string>,
  pl: MirrorPlane,
  res: MirrorResult,
  skipLocked: boolean,
): void {
  for (const e of all) {
    if (!isPosed(e) || !ids.has(e.id)) continue;
    if (skipLocked && e.locked) {
      res.skippedLocked++;
      continue;
    }
    const sym = symmetryAxes(e);
    if (!sym.exact) res.approximate++;
    res.axes.set(e.id, chooseAxis(pl, e.rotation, sym.axes));
  }
}

/**
 * Mirror copy: new entities (new ids, components with new ids) that are the mirror image of `ids` (and everything
 * grouped below them) about `plane`. Joints between mirrored bodies — and world-anchored joints whose bodies are all
 * mirrored — are copied with their anchors, axes and world ends mirrored; a joint to a body outside the set is left
 * out (counted in `skippedJoints`). The copies get the same group structure as the originals.
 */
export function mirrorCopy(
  all: readonly Entity[],
  ids: readonly string[],
  pl: MirrorPlane,
  opts: MirrorOptions = {},
): MirrorResult {
  const res = emptyResult();
  const list = [...all];
  const set = withDescendants(list, ids);
  pickAxes(list, set, pl, res, false);
  const clones = cloneEntities(list, [...ids], [0, 0, 0], res.idMap);
  const origOf = new Map<string, string>();
  for (const [o, n] of res.idMap) origOf.set(n, o);
  const newAxes = new Map<string, Axis>(); // new body id → axis
  for (const [o, ax] of res.axes) {
    const n = res.idMap.get(o);
    if (n) newAxes.set(n, ax);
  }
  const byId = new Map(list.map((e) => [e.id, e]));
  for (const c of clones) {
    const o = byId.get(origOf.get(c.id) ?? '');
    if (isPosed(c) && isPosed(o)) {
      const ax = res.axes.get(o.id) ?? 0;
      // Fields of the original (components keep their original ids → replace by the clone's, with mirrored params).
      const f = mirrorFields(o, pl, ax, opts) as Record<string, unknown>;
      if (isBody(c) && isBody(o)) {
        delete f.components;
        c.components = mirrorComponents(c.components, pl, ax);
      }
      if (isSoft(c) && isSoft(o) && o.attachments?.length) {
        c.attachments = mirrorAttachments(
          o,
          ax,
          (id) => res.axes.get(id),
          (id) => res.idMap.get(id),
        );
      }
      Object.assign(c, f);
    } else if (isJoint(c) && isJoint(o)) {
      Object.assign(
        c,
        mirrorJointFields(
          o,
          pl,
          c.bodyA ? newAxes.get(c.bodyA) : undefined,
          c.bodyB ? newAxes.get(c.bodyB) : undefined,
        ),
      );
    }
  }
  res.entities = clones;
  const copied = new Set(clones.map((c) => origOf.get(c.id)));
  for (const j of list) {
    if (!isJoint(j) || copied.has(j.id)) continue;
    const touches = [j.bodyA, j.bodyB].some((b) => b !== null && set.has(b));
    if (touches) res.skippedJoints++;
  }
  return res;
}

/**
 * Flip in place: patches that replace `ids` (and what is grouped below them) by their mirror image about `plane`.
 * Locked entities are left alone. A joint with both ends on flipped bodies is mirrored completely; a joint with one
 * end on an unflipped body keeps that end and mirrors the other (it follows the flipped feature); a joint that only
 * touches the world is mirrored when all its bodies flip.
 */
export function mirrorFlip(
  all: readonly Entity[],
  ids: readonly string[],
  pl: MirrorPlane,
  opts: MirrorOptions = {},
): MirrorResult {
  const res = emptyResult();
  const list = [...all];
  const set = withDescendants(list, ids);
  pickAxes(list, set, pl, res, true);
  for (const e of list) {
    if (!isPosed(e)) continue;
    const ax = res.axes.get(e.id);
    if (ax === undefined) continue;
    const fields = mirrorFields(e, pl, ax, opts);
    if (isSoft(e) && e.attachments?.length) {
      (fields as Partial<SoftEntity>).attachments = mirrorAttachments(
        e,
        ax,
        (id) => res.axes.get(id),
        (id) => id,
      );
    }
    res.patches.push([e.id, fields]);
  }
  for (const j of list) {
    if (!isJoint(j)) continue;
    const a = j.bodyA ? res.axes.get(j.bodyA) : undefined;
    const b = j.bodyB ? res.axes.get(j.bodyB) : undefined;
    const bodies = [j.bodyA, j.bodyB].filter((x): x is string => x !== null);
    if (!bodies.length) continue;
    const flipped = bodies.filter((x) => res.axes.has(x));
    if (!flipped.length) continue;
    // World ends are only reflected when every body of the joint flips with them.
    const worldFollows = flipped.length === bodies.length;
    const f = mirrorJointFields(j, pl, a, b);
    if (!worldFollows) {
      if (j.bodyA === null) {
        delete f.anchorA;
        delete f.axis;
      }
      if (j.bodyB === null) delete f.anchorB;
    }
    if (Object.keys(f).length) res.patches.push([j.id, f]);
  }
  return res;
}

// ── pairs (for symmetry mode) ───────────────────────────────────────────────────────────────────────────────

export interface MirrorPair {
  /** Id of the partner. */
  other: string;
  /** Local flip axis relating the two (the same in both directions). */
  axis: Axis;
}

const sameShape = (a: ShapeSpec, b: ShapeSpec, tol: number): boolean =>
  a.type === b.type &&
  a.size.every((v, k) => Math.abs(v - b.size[k]) <= tol) &&
  JSON.stringify(a.params ?? {}) === JSON.stringify(b.params ?? {});

/** Could `b` be the mirror image of `a` (same kind and content-level equality, not yet checked for pose)? */
function compatible(a: PosedEntity, b: PosedEntity, tol: number): boolean {
  if (a.kind !== b.kind) return false;
  if (isBody(a) && isBody(b)) {
    return (
      sameShape(a.shape, b.shape, tol) && a.bodyType === b.bodyType && (a.parts?.length ?? 0) === (b.parts?.length ?? 0)
    );
  }
  if (isSoft(a) && isSoft(b))
    return a.type === b.type && a.pin === b.pin && a.size.every((v, k) => Math.abs(v - b.size[k]) <= tol);
  if (isLight(a) && isLight(b)) return a.lightType === b.lightType;
  if (isPath(a) && isPath(b)) return a.points.length === b.points.length;
  return true;
}

export interface PairOptions {
  /** Position tolerance, metres (default 5 mm). */
  posTol?: number;
  /** Rotation tolerance, radians (default 0.02). */
  rotTol?: number;
  /** Pairs that already exist (kept; their members are not paired again). */
  existing?: ReadonlyMap<string, MirrorPair>;
}

/**
 * Find the mirror-image pairs among `all` about `plane`: two entities of the same kind and content whose poses are
 * mirror images (positions within `posTol`, orientations within `rotTol` for one of the allowed local flips). An
 * entity on the plane that is its own mirror image gets no partner. Joints pair when their bodies pair. The map
 * holds both directions.
 */
export function findMirrorPairs(
  all: readonly Entity[],
  pl: MirrorPlane,
  opts: PairOptions = {},
): Map<string, MirrorPair> {
  const posTol = opts.posTol ?? 0.005;
  const rotTol = opts.rotTol ?? 0.02;
  const pairs = new Map<string, MirrorPair>(opts.existing ?? []);
  const cell = Math.max(posTol * 4, 1e-3);
  const key = (p: Vec3): string => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  const grid = new Map<string, PosedEntity[]>();
  const posed = all.filter(isPosed);
  for (const e of posed) {
    if (pairs.has(e.id)) continue;
    const k = key(e.position);
    const l = grid.get(k);
    if (l) l.push(e);
    else grid.set(k, [e]);
  }
  for (const a of posed) {
    if (pairs.has(a.id)) continue;
    const m = reflectPoint(pl, a.position);
    if (Math.hypot(m[0] - a.position[0], m[1] - a.position[1], m[2] - a.position[2]) <= posTol) continue; // on the plane
    const cx = Math.floor(m[0] / cell);
    const cy = Math.floor(m[1] / cell);
    const cz = Math.floor(m[2] / cell);
    const sym = symmetryAxes(a);
    let found: MirrorPair | null = null;
    for (let dx = -1; dx <= 1 && !found; dx++)
      for (let dy = -1; dy <= 1 && !found; dy++)
        for (let dz = -1; dz <= 1 && !found; dz++) {
          for (const b of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (b.id === a.id || pairs.has(b.id) || !compatible(a, b, 1e-3)) continue;
            if (Math.hypot(b.position[0] - m[0], b.position[1] - m[1], b.position[2] - m[2]) > posTol) continue;
            const ax = sym.axes.find((i) => qangle(mirrorRotation(pl, a.rotation, i), b.rotation) <= rotTol);
            if (ax === undefined) continue;
            found = { other: b.id, axis: ax };
            break;
          }
        }
    if (found) {
      pairs.set(a.id, found);
      pairs.set(found.other, { other: a.id, axis: found.axis });
    }
  }
  // Joints: a joint pairs with the joint that connects the partners of its bodies (world ends map to world ends).
  const joints = all.filter(isJoint);
  const used = new Set<string>();
  for (const j of joints) {
    if (pairs.has(j.id)) continue;
    const pa = j.bodyA === null ? null : (pairs.get(j.bodyA)?.other ?? undefined);
    const pb = j.bodyB === null ? null : (pairs.get(j.bodyB)?.other ?? undefined);
    if (pa === undefined || pb === undefined) continue;
    const twin = joints.find(
      (t) =>
        !used.has(t.id) && t.id !== j.id && !pairs.has(t.id) && t.type === j.type && t.bodyA === pa && t.bodyB === pb,
    );
    if (!twin) continue;
    used.add(twin.id);
    const axis = (j.bodyA ? pairs.get(j.bodyA)?.axis : undefined) ?? 0;
    pairs.set(j.id, { other: twin.id, axis });
    pairs.set(twin.id, { other: j.id, axis });
  }
  return pairs;
}

/** Whether an entity lies on the plane and is its own mirror image (no partner needed). */
export function onPlane(e: PosedEntity, pl: MirrorPlane, tol = 0.005): boolean {
  return Math.abs(vdot(vsub(e.position, pl.point), pl.normal)) <= tol;
}

/** Translate a vector of the plane's own point along its normal (used by symmetry to move the plane). */
export const planeOffset = (pl: MirrorPlane): number => vdot(pl.point, pl.normal);

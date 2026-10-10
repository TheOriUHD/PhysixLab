/**
 * The cut tool's geometry and document edit (ED-41): split a solid body with a plane into two convex-hull
 * `chunk` bodies, each with the right volume, mass, centre and the original's material, velocity and flags.
 *
 * How a body is cut:
 *  1. Its local convex points are taken from the shape (`convexPoints`); round shapes that have none (sphere,
 *     cylinder, capsule, cone) are sampled with a dense point cloud (Fibonacci sphere / rings) — an inscribed
 *     polyhedron, so the halves are slightly smaller than the analytic solid (docs/LIMITATIONS.md). Total mass is
 *     conserved anyway: densities are rescaled so the two halves weigh exactly what the original did.
 *  2. The points are moved to the world and clipped with the plane (`clipConvexByPlane`); each side is hulled,
 *     which gives the cap face for free.
 *  3. Each half becomes a `chunk` body whose origin is the half's volume centroid, whose rotation is the original
 *     rotation (the points are stored in the body's own frame about the new origin) and whose size is the local
 *     extents. A body with a `massOverride` splits it in proportion to the halves' volumes.
 *  4. Velocity: both halves keep the original velocity plus ω × (centroid − origin), so a spinning body flies
 *     apart consistently. Static bodies stay static. `comOverride` is dropped (it has no meaning for a new shape).
 *  5. Joints: a joint on the original stays on whichever half contains its anchor point (the half the anchor is
 *     on the side of; anchors exactly on the cut go to the side the plane normal points to). The anchor is
 *     re-expressed in the half's frame, so the mechanism keeps its geometry. Components are copied to both halves.
 */
import { convexHull, hullMoments, clipConvexByPlane, type Hull } from '../core/convexHull';
import { qrot, qrotInv, vadd, vcross, vdot, vlen, vscale, vsub, type Vec3 } from '../core/math';
import { createBody } from '../model/factory';
import { cloneComponents } from '../model/componentRegistry';
import { shapeConvexPoints, shapeVolume } from '../model/shapeRegistry';
import { encodeChunkPoints } from '../model/shapes/chunk';
import { boxCorners, clampDims } from '../model/shapes/helpers';
import type { SceneStore } from '../model/store';
import type { BodyEntity, JointEntity } from '../model/types';

export interface CutPlane {
  point: Vec3;
  normal: Vec3;
}

export interface CutResult {
  /** The half on the side the plane normal points to. */
  a: BodyEntity;
  /** The half on the other side. */
  b: BodyEntity;
  /** The original's joints, re-attached to the half that holds their anchor. */
  joints: JointEntity[];
}

export interface CutContext {
  /** Joints attached to the original body. */
  joints?: readonly JointEntity[];
  /** Look a body up by id (needed to find the world anchor of a joint whose other end is on the original). */
  body?: (id: string) => BodyEntity | undefined;
}

/** A body the tool may cut: a plain, unlocked, visible body (compound bodies have several colliders — skipped). */
export function canCut(b: BodyEntity): boolean {
  return !b.parts?.length && !b.locked && !b.hidden;
}

// ── sampling round shapes ───────────────────────────────────────────────────────────────────────────

const SPHERE_SAMPLES = 160;
const RING_SAMPLES = 48;

function fibonacciSphere(n: number): Vec3[] {
  const out: Vec3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out.push([Math.cos(ga * i) * r, y, Math.sin(ga * i) * r]);
  }
  return out;
}

function ring(rx: number, rz: number, y: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < RING_SAMPLES; i++) {
    const t = (i / RING_SAMPLES) * Math.PI * 2;
    out.push([Math.cos(t) * rx, y, Math.sin(t) * rz]);
  }
  return out;
}

/** Local-frame point cloud of the solid. */
export function localCutPoints(b: BodyEntity): Vec3[] {
  const { type, size } = b.shape;
  const [x, y, z] = size;
  switch (type) {
    case 'sphere':
      return fibonacciSphere(SPHERE_SAMPLES).map((p) => [p[0] * (x / 2), p[1] * (y / 2), p[2] * (z / 2)] as Vec3);
    case 'cylinder':
      return [...ring(x / 2, z / 2, y / 2), ...ring(x / 2, z / 2, -y / 2)];
    case 'cone':
      return [...ring(x / 2, z / 2, -y / 2), [0, y / 2, 0]];
    case 'capsule': {
      const r = x / 2;
      const len = Math.max(0, (y - x) / 2);
      return fibonacciSphere(SPHERE_SAMPLES).map(
        (p) => [p[0] * r, p[1] * r + (p[1] >= 0 ? len : -len), p[2] * r] as Vec3,
      );
    }
    default:
      return shapeConvexPoints(b.shape) ?? boxCorners(size);
  }
}

// ── cutting ─────────────────────────────────────────────────────────────────────────────────────────

interface Half {
  hull: Hull;
  volume: number;
  centroid: Vec3;
}

function halfOf(points: Vec3[]): Half | null {
  const hull = convexHull(points);
  if (!hull) return null;
  const { volume, centroid } = hullMoments(hull);
  return volume > 0 ? { hull, volume, centroid } : null;
}

/** World anchor of a joint end on body `bid`, or null if it cannot be determined. */
function worldAnchor(j: JointEntity, bid: string, ctx: CutContext, self: BodyEntity): Vec3 | null {
  if (j.bodyA === bid) return vadd(self.position, qrot(self.rotation, j.anchorA));
  if (j.bodyB !== bid) return null;
  if (j.type === 'spring' || j.type === 'rope') return vadd(self.position, qrot(self.rotation, j.anchorB));
  // Rigid joints derive B's anchor from A's.
  if (j.bodyA === null) return j.anchorA;
  const a = ctx.body?.(j.bodyA);
  return a ? vadd(a.position, qrot(a.rotation, j.anchorA)) : null;
}

/** Split `body` with the plane. Null when the plane misses it or a side is too thin to be a solid. */
export function planeCutBody(
  body: BodyEntity,
  planePoint: Vec3,
  planeNormal: Vec3,
  ctx: CutContext = {},
): CutResult | null {
  if (body.parts?.length) return null;
  const world = localCutPoints(body).map((p) => vadd(body.position, qrot(body.rotation, p)));
  const { above, below } = clipConvexByPlane(world, planePoint, planeNormal);
  const ha = halfOf(above);
  const hb = halfOf(below);
  if (!ha || !hb) return null;
  const total = ha.volume + hb.volume;
  if (Math.min(ha.volume, hb.volume) < 1e-4 * total) return null;

  const make = (h: Half, suffix: string): BodyEntity | null => {
    // Points in the body's own frame about the new origin.
    const local = h.hull.vertices.map((v) => qrotInv(body.rotation, vsub(v, h.centroid)));
    const half: Vec3 = [0, 0, 0];
    for (const p of local) for (let k = 0; k < 3; k++) half[k] = Math.max(half[k], Math.abs(p[k]));
    const size = clampDims([half[0] * 2, half[1] * 2, half[2] * 2]);
    const pts = encodeChunkPoints(local.map((p) => [p[0] / size[0], p[1] / size[1], p[2] / size[2]] as Vec3));
    if (!pts) return null;
    const r = vsub(h.centroid, body.position);
    const moving = body.bodyType !== 'static';
    const base = body.name.replace(/ \(cut [AB]\)$/, '');
    return {
      ...createBody({ shape: { type: 'chunk', size, params: { pts } }, position: h.centroid, rotation: body.rotation }),
      name: `${base} (cut ${suffix})`,
      bodyType: body.bodyType,
      material: { ...body.material },
      linearDamping: body.linearDamping,
      angularDamping: body.angularDamping,
      gravityScale: body.gravityScale,
      ccd: body.ccd,
      canSleep: body.canSleep,
      velocity: moving ? vadd(body.velocity, vcross(body.angularVelocity, r)) : [0, 0, 0],
      angularVelocity: moving ? [...body.angularVelocity] : [0, 0, 0],
      lockPosition: [...body.lockPosition],
      lockRotation: [...body.lockRotation],
      thrust: body.thrust ? { ...body.thrust } : null,
      ghost: body.ghost,
      collision: { ...body.collision },
      drag: { ...body.drag },
      inertiaScale: body.inertiaScale,
      ...(body.sleepThreshold !== undefined ? { sleepThreshold: body.sleepThreshold } : {}),
      tags: [...body.tags],
      layer: body.layer,
      ...(body.parent !== undefined ? { parent: body.parent } : {}),
      components: cloneComponents(body.components, new Map()),
    };
  };
  const a = make(ha, 'A');
  const b = make(hb, 'B');
  if (!a || !b) return null;

  // Masses: conserve the original's mass exactly, split by the halves' (stored) volumes.
  const va = shapeVolume(a.shape);
  const vb = shapeVolume(b.shape);
  if (body.massOverride !== undefined) {
    a.massOverride = (body.massOverride * va) / (va + vb);
    b.massOverride = (body.massOverride * vb) / (va + vb);
  } else {
    const f = shapeVolume(body.shape) / (va + vb);
    a.material.density = body.material.density * f;
    b.material.density = body.material.density * f;
  }

  // Joints follow the half that contains their anchor.
  const nrm = vscale(planeNormal, 1 / (vlen(planeNormal) || 1));
  const joints: JointEntity[] = [];
  for (const j of ctx.joints ?? []) {
    const anchor = worldAnchor(j, body.id, ctx, body);
    const target = !anchor || vdot(nrm, vsub(anchor, planePoint)) >= 0 ? a : b;
    const local = anchor ? qrotInv(target.rotation, vsub(anchor, target.position)) : null;
    const next: JointEntity = { ...j };
    if (j.bodyA === body.id) {
      next.bodyA = target.id;
      if (local) next.anchorA = local;
    }
    if (j.bodyB === body.id) {
      next.bodyB = target.id;
      if (local && (j.type === 'spring' || j.type === 'rope' || j.bodyA === body.id)) next.anchorB = local;
    }
    joints.push(next);
  }
  return { a, b, joints };
}

/**
 * Cut every cuttable body in `ids` with the plane `planeOf(body)` as ONE undo step ("Cut N bodies"); the halves
 * become the selection. Returns the number of bodies that were cut (0 = nothing changed, no history entry).
 */
export function applyCut(store: SceneStore, ids: readonly string[], planeOf: (b: BodyEntity) => CutPlane): number {
  const results: { id: string; r: CutResult }[] = [];
  for (const id of ids) {
    const b = store.body(id);
    if (!b || !canCut(b)) continue;
    const { point, normal } = planeOf(b);
    const r = planeCutBody(b, point, normal, { joints: store.jointsOf(id), body: (i) => store.body(i) });
    if (r) results.push({ id, r });
  }
  if (!results.length) return 0;
  const n = results.length;
  const originals = new Map(store.joints().map((j) => [j.id, j] as const));
  store.transact(n === 1 ? 'Cut body' : `Cut ${n} bodies`, () => {
    store.remove(results.map((x) => x.id));
    store.add(
      results.flatMap((x) => [x.r.a, x.r.b]),
      'Cut',
    );
    // A joint between two cut bodies appears in both results, each patched on its own end: merge them.
    const merged = new Map<string, JointEntity>();
    for (const x of results) {
      for (const nj of x.r.joints) {
        const orig = originals.get(nj.id);
        if (!orig) continue;
        const cur = merged.get(nj.id) ?? { ...orig };
        if (nj.bodyA !== orig.bodyA) Object.assign(cur, { bodyA: nj.bodyA, anchorA: nj.anchorA });
        if (nj.bodyB !== orig.bodyB) Object.assign(cur, { bodyB: nj.bodyB, anchorB: nj.anchorB });
        merged.set(nj.id, cur);
      }
    }
    store.add([...merged.values()], 'Cut joints', false);
  });
  return n;
}

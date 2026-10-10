/**
 * Snapping (ED-14), pure: no DOM, no three.js, no Rapier. The app feeds it plain poses and a projection callback.
 *
 * Kinds, in priority order (`SNAP_PRIORITY`): vertex, edge midpoint, face centre, bounds, surface, grid.
 *
 *   • **Feature snaps** (vertex / edge / face / bounds): while an object is dragged, its own vertices (and centre) are
 *     the *handles*; the features of the other objects are the *candidates*. The pair that is closest on screen
 *     (within `radiusPx`, with a small bias per kind so a vertex beats an edge beats a face at equal distance) wins and
 *     the result is the world translation that makes the handle coincide with the candidate.
 *   • **Surface snap**: a pointer ray hit (point + normal) places the object so that its support function touches the
 *     surface: its lowest point along the normal sits exactly on the hit point; optionally the object's up axis is first
 *     turned onto the normal (`surfacePlacement`).
 *   • **Grid**: `snapToGrid`.
 *
 * Which features a shape has (honest, derived from the geometry — see `shapeFeatures`):
 *   convex hull shapes (box, wedge, prism, icosahedron …)  every hull vertex, every hull edge midpoint, every hull face
 *                                                          centre (faces recovered from the points by `hullFaces`)
 *   sphere / ellipsoid     6 poles as vertices (no edges or faces: a sphere has none)
 *   cylinder               the two cap centres as face centres, no vertices or edges (its rims are curves)
 *   capsule                the two poles as vertices (no flat faces)
 *   cone                   the apex as a vertex, the base centre as a face centre
 *   bounds (all shapes)    the 8 corners, 6 face centres and the centre of the axis-aligned bounding box
 * An object with no feature of a kind simply offers no candidate of that kind.
 */
import { qrot, qrotInv, qfromUnitVectors, qmul, vadd, vdot, vlen, vnorm, vscale, vsub } from '../../core/math';
import type { Quat, Vec3 } from '../../core/math';

export type SnapKind = 'vertex' | 'edge' | 'face' | 'bounds' | 'surface' | 'grid';
export const SNAP_PRIORITY: readonly SnapKind[] = ['vertex', 'edge', 'face', 'bounds', 'surface', 'grid'];
export const SNAP_LABELS: Record<SnapKind, string> = {
  vertex: 'Vertex',
  edge: 'Edge',
  face: 'Face',
  bounds: 'Bounds',
  surface: 'Surface',
  grid: 'Grid',
};
/** Pixels added to a candidate's screen distance per kind, so that equal distances resolve by priority. */
const KIND_BIAS_PX: Record<SnapKind, number> = { vertex: 0, edge: 2.5, face: 4.5, bounds: 6.5, surface: 0, grid: 0 };

// ── support functions ───────────────────────────────────────────────────────────────────────────────

/** A convex solid by its support function (local space, centred on the origin). */
export type SupportShape =
  | { k: 'points'; pts: readonly Vec3[] }
  | { k: 'ellipsoid'; r: Vec3 }
  | { k: 'cylinder'; r: number; h: number }
  | { k: 'capsule'; r: number; h: number }
  | { k: 'cone'; r: number; h: number };

/** max over the solid of p·d for a LOCAL direction d (not necessarily unit). */
export function supportLocal(s: SupportShape, d: Vec3): number {
  switch (s.k) {
    case 'points': {
      let m = -Infinity;
      for (const p of s.pts) m = Math.max(m, p[0] * d[0] + p[1] * d[1] + p[2] * d[2]);
      return m;
    }
    case 'ellipsoid':
      return Math.hypot(s.r[0] * d[0], s.r[1] * d[1], s.r[2] * d[2]);
    case 'cylinder':
      return s.h * Math.abs(d[1]) + s.r * Math.hypot(d[0], d[2]);
    case 'capsule':
      return s.h * Math.abs(d[1]) + s.r * Math.hypot(d[0], d[1], d[2]);
    case 'cone':
      // apex (0,h,0) and the base circle at y = -h
      return Math.max(s.h * d[1], -s.h * d[1] + s.r * Math.hypot(d[0], d[2]));
  }
}

/** max over the solid, posed with rotation `q`, of p·dir for a WORLD direction (relative to the centre). */
export function supportAlong(s: SupportShape, q: Quat, dir: Vec3): number {
  return supportLocal(s, qrotInv(q, dir));
}

/** Axis-aligned half extents of the posed solid. */
export function worldHalfExtents(s: SupportShape, q: Quat): Vec3 {
  return [supportAlong(s, q, [1, 0, 0]), supportAlong(s, q, [0, 1, 0]), supportAlong(s, q, [0, 0, 1])];
}

// ── hull faces ──────────────────────────────────────────────────────────────────────────────────────

export interface HullFace {
  /** Outward unit normal. */
  normal: Vec3;
  /** Indices into the (de-duplicated) point list, in winding order. */
  loop: number[];
}

export interface Hull {
  points: Vec3[];
  faces: HullFace[];
  /** Unique edges as index pairs. */
  edges: [number, number][];
}

const EPS = 1e-7;

/**
 * The faces and edges of the convex hull of a point set (brute force over triples: fine for the < 40 points the
 * shapes have, and cached by the caller). Coplanar points form one polygon face.
 */
export function convexHull(input: readonly Vec3[]): Hull {
  const points: Vec3[] = [];
  for (const p of input) if (!points.some((q) => vlen(vsub(p, q)) < 1e-9)) points.push([p[0], p[1], p[2]]);
  const faces: HullFace[] = [];
  const seen = new Set<string>();
  const n = points.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        const c = cross3(vsub(points[j], points[i]), vsub(points[k], points[i]));
        const cl = vlen(c);
        if (cl < 1e-9) continue;
        const nrm: Vec3 = [c[0] / cl, c[1] / cl, c[2] / cl];
        const d = vdot(nrm, points[i]);
        let pos = false,
          neg = false;
        const on: number[] = [];
        for (let m = 0; m < n; m++) {
          const s = vdot(nrm, points[m]) - d;
          if (s > EPS) pos = true;
          else if (s < -EPS) neg = true;
          else on.push(m);
          if (pos && neg) break;
        }
        if (pos && neg) continue;
        const key = on.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const outward: Vec3 = pos ? [-nrm[0], -nrm[1], -nrm[2]] : nrm;
        faces.push({ normal: outward, loop: orderLoop(points, on, outward) });
      }
  const edgeSeen = new Set<string>();
  const edges: [number, number][] = [];
  for (const f of faces)
    for (let e = 0; e < f.loop.length; e++) {
      const a = f.loop[e],
        b = f.loop[(e + 1) % f.loop.length];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        edges.push([a, b]);
      }
    }
  return { points, faces, edges };
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Sort coplanar points counter-clockwise (seen from outside) around their centroid. */
function orderLoop(points: Vec3[], idx: number[], normal: Vec3): number[] {
  const c: Vec3 = [0, 0, 0];
  for (const i of idx) {
    c[0] += points[i][0] / idx.length;
    c[1] += points[i][1] / idx.length;
    c[2] += points[i][2] / idx.length;
  }
  const first = vnorm(vsub(points[idx[0]], c), [1, 0, 0]);
  const second = cross3(normal, first);
  const ang = (i: number) => {
    const r = vsub(points[i], c);
    return Math.atan2(vdot(r, second), vdot(r, first));
  };
  return [...idx].sort((a, b) => ang(a) - ang(b));
}

// ── shape features ──────────────────────────────────────────────────────────────────────────────────

/** Local-space snap features of one shape. */
export interface ShapeFeatures {
  support: SupportShape;
  vertices: Vec3[];
  edgeMids: Vec3[];
  faceCentres: Vec3[];
}

const mean = (pts: Vec3[]): Vec3 => {
  const o: Vec3 = [0, 0, 0];
  for (const p of pts) {
    o[0] += p[0] / pts.length;
    o[1] += p[1] / pts.length;
    o[2] += p[2] / pts.length;
  }
  return o;
};

/** Features of a convex solid given as a support shape. */
export function shapeFeatures(support: SupportShape): ShapeFeatures {
  switch (support.k) {
    case 'points': {
      const hull = convexHull(support.pts);
      return {
        support,
        vertices: hull.points,
        edgeMids: hull.edges.map(([a, b]) => vscale(vadd(hull.points[a], hull.points[b]), 0.5)),
        faceCentres: hull.faces.map((f) => mean(f.loop.map((i) => hull.points[i]))),
      };
    }
    case 'ellipsoid': {
      const [a, b, c] = support.r;
      return {
        support,
        vertices: [
          [a, 0, 0],
          [-a, 0, 0],
          [0, b, 0],
          [0, -b, 0],
          [0, 0, c],
          [0, 0, -c],
        ],
        edgeMids: [],
        faceCentres: [],
      };
    }
    case 'cylinder':
      return {
        support,
        vertices: [],
        edgeMids: [],
        faceCentres: [
          [0, support.h, 0],
          [0, -support.h, 0],
        ],
      };
    case 'capsule': {
      const t = support.h + support.r;
      return {
        support,
        vertices: [
          [0, t, 0],
          [0, -t, 0],
        ],
        edgeMids: [],
        faceCentres: [],
      };
    }
    case 'cone':
      return { support, vertices: [[0, support.h, 0]], edgeMids: [], faceCentres: [[0, -support.h, 0]] };
  }
}

/** A posed object offered to the snapper. */
export interface SnapObject {
  id: string;
  position: Vec3;
  rotation: Quat;
  shape: ShapeFeatures;
}

export interface Candidate {
  kind: Exclude<SnapKind, 'surface' | 'grid'>;
  point: Vec3;
  owner: string;
}

const world = (o: SnapObject, p: Vec3): Vec3 => vadd(qrot(o.rotation, p), o.position);

/** The corners, face centres and centre of the object's axis-aligned bounding box. */
export function boundsPoints(o: SnapObject): Vec3[] {
  const h = worldHalfExtents(o.shape.support, o.rotation);
  const [x, y, z] = o.position;
  const out: Vec3[] = [[x, y, z]];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push([x + sx * h[0], y + sy * h[1], z + sz * h[2]]);
  for (const s of [-1, 1]) {
    out.push([x + s * h[0], y, z], [x, y + s * h[1], z], [x, y, z + s * h[2]]);
  }
  return out;
}

export type FeatureModes = { vertex: boolean; edge: boolean; face: boolean; bounds: boolean };

/** All candidates of one object for the enabled kinds, in world space. */
export function candidatesOf(o: SnapObject, modes: FeatureModes, out: Candidate[] = []): Candidate[] {
  if (modes.vertex) for (const p of o.shape.vertices) out.push({ kind: 'vertex', point: world(o, p), owner: o.id });
  if (modes.edge) for (const p of o.shape.edgeMids) out.push({ kind: 'edge', point: world(o, p), owner: o.id });
  if (modes.face) for (const p of o.shape.faceCentres) out.push({ kind: 'face', point: world(o, p), owner: o.id });
  if (modes.bounds) for (const p of boundsPoints(o)) out.push({ kind: 'bounds', point: p, owner: o.id });
  return out;
}

/** The points of a dragged object that can be pulled onto a candidate: its vertices and its centre. */
export function handlesOf(o: SnapObject): Vec3[] {
  return [[...o.position] as Vec3, ...o.shape.vertices.map((p) => world(o, p))];
}

// ── feature snapping ────────────────────────────────────────────────────────────────────────────────

/** Projects a world point to screen pixels into `out`; false when it is behind the camera. */
export type Projector = (p: Vec3, out: [number, number]) => boolean;

export interface SnapHit {
  kind: SnapKind;
  /** World translation to add to the dragged objects. */
  delta: Vec3;
  /** Where the indicator goes (the candidate point, after the move). */
  point: Vec3;
  /** Surface normal for a surface snap. */
  normal?: Vec3;
  /** Screen distance that decided it (pixels); 0 for surface / grid. */
  distancePx: number;
  owner?: string;
}

export interface FeatureSnapInput {
  moving: readonly SnapObject[];
  others: readonly SnapObject[];
  modes: FeatureModes;
  project: Projector;
  /** Candidates farther than this from a handle on screen are ignored. */
  radiusPx: number;
  /** World-space prefilter: objects whose centres are farther apart than this (plus their extents) are skipped. */
  worldReach: number;
  /** At most this many handles are tried (default 48). */
  maxHandles?: number;
}

/**
 * Best feature snap for the dragged objects at their proposed poses, or null. Objects listed in `moving` are never
 * candidates, whatever `others` contains.
 */
export function resolveFeatureSnap(inp: FeatureSnapInput): SnapHit | null {
  const { modes } = inp;
  if (!modes.vertex && !modes.edge && !modes.face && !modes.bounds) return null;
  if (!inp.moving.length) return null;
  const movingIds = new Set(inp.moving.map((m) => m.id));
  // handles, with the radius of the dragged set for the prefilter
  const handles: Vec3[] = [];
  const centre: Vec3 = [0, 0, 0];
  for (const m of inp.moving) {
    for (const h of handlesOf(m)) handles.push(h);
    centre[0] += m.position[0] / inp.moving.length;
    centre[1] += m.position[1] / inp.moving.length;
    centre[2] += m.position[2] / inp.moving.length;
  }
  if (handles.length > (inp.maxHandles ?? 48)) handles.length = inp.maxHandles ?? 48;
  let movingReach = 0;
  for (const m of inp.moving) {
    const h = worldHalfExtents(m.shape.support, m.rotation);
    movingReach = Math.max(movingReach, vlen(vsub(m.position, centre)) + vlen(h));
  }
  const hp = handles.map(() => [0, 0] as [number, number]);
  const hOk = handles.map((h, i) => inp.project(h, hp[i]));
  let best: { score: number; px: number; hit: Candidate; handle: Vec3 } | null = null;
  const cp: [number, number] = [0, 0];
  const cands: Candidate[] = [];
  for (const o of inp.others) {
    if (movingIds.has(o.id)) continue;
    const reach = inp.worldReach + movingReach + vlen(worldHalfExtents(o.shape.support, o.rotation));
    if (vlen(vsub(o.position, centre)) > reach) continue;
    cands.length = 0;
    candidatesOf(o, modes, cands);
    for (const c of cands) {
      if (!inp.project(c.point, cp)) continue;
      for (let i = 0; i < handles.length; i++) {
        if (!hOk[i]) continue;
        const px = Math.hypot(cp[0] - hp[i][0], cp[1] - hp[i][1]);
        if (px > inp.radiusPx) continue;
        const score = px + KIND_BIAS_PX[c.kind];
        if (!best || score < best.score) best = { score, px, hit: c, handle: handles[i] };
      }
    }
  }
  if (!best) return null;
  return {
    kind: best.hit.kind,
    delta: vsub(best.hit.point, best.handle),
    point: best.hit.point,
    distancePx: best.px,
    owner: best.hit.owner,
  };
}

// ── surface snapping ────────────────────────────────────────────────────────────────────────────────

export interface SurfacePlacement {
  position: Vec3;
  rotation: Quat;
}

/**
 * Put a solid on a surface: `point` is the hit point, `normal` the surface normal (any length). With `alignUp` the
 * object is first turned by the shortest arc so its local +Y becomes the normal; otherwise its rotation is kept. The
 * centre is then `point + normal × s`, where `s` is the solid's extent *against* the normal, so the lowest point along
 * the normal lies exactly on `point` (flush, no gap, no penetration). `clearance` adds a small air gap (metres).
 */
export function surfacePlacement(
  shape: SupportShape,
  rotation: Quat,
  point: Vec3,
  normal: Vec3,
  alignUp: boolean,
  clearance = 0,
): SurfacePlacement {
  const n = vnorm(normal, [0, 1, 0]);
  let q = rotation;
  if (alignUp) {
    const up = qrot(rotation, [0, 1, 0]);
    q = normalizeQ(qmul(qfromUnitVectors(up, n), rotation));
  }
  const s = supportAlong(shape, q, [-n[0], -n[1], -n[2]]);
  return { position: vadd(point, vscale(n, s + clearance)), rotation: q };
}

const normalizeQ = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

/** Signed distance of the posed solid's lowest point along `normal` above the plane through `point` (0 = flush). */
export function gapAboveSurface(
  shape: SupportShape,
  position: Vec3,
  rotation: Quat,
  point: Vec3,
  normal: Vec3,
): number {
  const n = vnorm(normal, [0, 1, 0]);
  return vdot(vsub(position, point), n) - supportAlong(shape, rotation, [-n[0], -n[1], -n[2]]);
}

// ── grid ────────────────────────────────────────────────────────────────────────────────────────────

export function snapToGrid(v: number, step: number): number {
  return step > 0 ? Math.round(v / step) * step : v;
}

/** Pick the winner among feature / surface / grid results by priority (the first non-null in `SNAP_PRIORITY` order). */
export function chooseSnap(hits: readonly (SnapHit | null)[]): SnapHit | null {
  let best: SnapHit | null = null;
  for (const h of hits) {
    if (!h) continue;
    if (!best || SNAP_PRIORITY.indexOf(h.kind) < SNAP_PRIORITY.indexOf(best.kind)) best = h;
  }
  return best;
}

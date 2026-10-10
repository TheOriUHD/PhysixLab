/**
 * Pure geometry and defaults for creating joints (JT-21): where an anchor snaps on a body, which axis a click
 * implies, the sensible settings of each joint type derived from its two endpoints, the quick limit presets,
 * and how several bodies are paired by "Connect all". No three.js, no DOM — it runs in the tests as is.
 */
import { clamp, qrot, qrotInv, vlen, vnorm, type Quat, type Vec3 } from '../core/math';
import { AXIS_TYPES, type JointParams } from './jointParams';
import { shapeBoundingRadius, shapeConvexPoints, shapeDef } from './shapeRegistry';
import type { JointType, LimitSpec, MotorSpec, ShapeSpec } from './types';

// ---- snap candidates ----------------------------------------------------------------------------------

export type SnapKind = 'vertex' | 'edge' | 'face' | 'center';

export const SNAP_LABELS: Record<SnapKind, string> = {
  vertex: 'Vertex',
  edge: 'Edge midpoint',
  face: 'Face centre',
  center: 'Body centre',
};

/** One point a joint anchor can snap to, in the body's local frame. */
export interface SnapCandidate {
  kind: SnapKind;
  local: Vec3;
  /** Outward normal (local) for a face centre; null otherwise. */
  normal: Vec3 | null;
}

/** Axis-aligned box of the shape in its local frame (the body is posed by position + rotation). */
export interface LocalBox {
  min: Vec3;
  max: Vec3;
}

/** Local bounding box: from the convex hull points when the shape has them, else the size box around the origin. */
export function localBox(spec: ShapeSpec): LocalBox {
  const pts = shapeConvexPoints(spec);
  if (pts && pts.length) {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
    return { min, max };
  }
  const h: Vec3 = [spec.size[0] / 2, spec.size[1] / 2, spec.size[2] / 2];
  return { min: [-h[0], -h[1], -h[2]], max: h };
}

const MAX_HULL_VERTICES = 48;
const candidateCache = new WeakMap<ShapeSpec, SnapCandidate[]>();

/**
 * Snapping candidates of a shape: its centre, the six face centres, twelve edge midpoints and eight corners of
 * the oriented bounding box (the local box), or the real hull vertices instead of the corners for a small convex
 * shape. Candidates outside the shape's bounding sphere are dropped, so a ball offers its centre and six poles,
 * not corners floating in the air. Cached per spec object (specs are immutable in the store).
 */
export function snapCandidates(spec: ShapeSpec): SnapCandidate[] {
  const hit = candidateCache.get(spec);
  if (hit) return hit;
  const box = localBox(spec);
  const reach = shapeBoundingRadius(spec) * 1.001 + 1e-6;
  const out: SnapCandidate[] = [{ kind: 'center', local: [0, 0, 0], normal: null }];
  const mid: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const pick = (axis: number, side: number): number =>
    side < 0 ? box.min[axis] : side > 0 ? box.max[axis] : mid[axis];
  // sides per axis: -1 / 0 / +1; the number of non-zero sides says what the point is (1 face, 2 edge, 3 corner)
  for (let sx = -1; sx <= 1; sx++)
    for (let sy = -1; sy <= 1; sy++)
      for (let sz = -1; sz <= 1; sz++) {
        const nz = (sx !== 0 ? 1 : 0) + (sy !== 0 ? 1 : 0) + (sz !== 0 ? 1 : 0);
        if (nz === 0) continue;
        const local: Vec3 = [pick(0, sx), pick(1, sy), pick(2, sz)];
        if (vlen(local) > reach) continue;
        if (nz === 1) out.push({ kind: 'face', local, normal: [sx, sy, sz] });
        else if (nz === 2) out.push({ kind: 'edge', local, normal: null });
        else out.push({ kind: 'vertex', local, normal: null });
      }
  const hull = shapeConvexPoints(spec);
  if (hull && hull.length <= MAX_HULL_VERTICES) {
    // The hull's real vertices replace the box corners (a wedge has no top corner on its low side).
    const kept = out.filter((c) => c.kind !== 'vertex');
    for (const p of hull) kept.push({ kind: 'vertex', local: [p[0], p[1], p[2]], normal: null });
    candidateCache.set(spec, kept);
    return kept;
  }
  candidateCache.set(spec, out);
  return out;
}

/** The result of `findSnap`; one object is reused by callers that run on every pointer move. */
export interface SnapHit {
  kind: SnapKind;
  /** World position of the candidate. */
  world: Vec3;
  /** World normal of a snapped face centre, else null. */
  normal: Vec3 | null;
}

/** Specificity used to break near-ties: a corner beats an edge beats a face beats the centre. */
const KIND_BIAS: Record<SnapKind, number> = { vertex: 0, edge: 0.15, face: 0.3, center: 0.45 };

/**
 * The candidate closest to a world point (usually the picked surface point) within `tolerance` metres, or null.
 * Ties within a small fraction of the tolerance prefer the more specific kind. Allocates only the returned object
 * (pass `out` to reuse one).
 */
export function findSnap(
  cands: readonly SnapCandidate[],
  position: Vec3,
  rotation: Quat,
  point: Vec3,
  tolerance: number,
  out?: SnapHit,
): SnapHit | null {
  const [qx, qy, qz, qw] = rotation;
  let best = -1;
  let bestScore = Infinity;
  let bx = 0,
    by = 0,
    bz = 0;
  for (let i = 0; i < cands.length; i++) {
    const [lx, ly, lz] = cands[i].local;
    // v' = v + 2w(q×v) + 2 q×(q×v)
    const tx = 2 * (qy * lz - qz * ly);
    const ty = 2 * (qz * lx - qx * lz);
    const tz = 2 * (qx * ly - qy * lx);
    const wx = position[0] + lx + qw * tx + (qy * tz - qz * ty);
    const wy = position[1] + ly + qw * ty + (qz * tx - qx * tz);
    const wz = position[2] + lz + qw * tz + (qx * ty - qy * tx);
    const d = Math.hypot(wx - point[0], wy - point[1], wz - point[2]);
    if (d > tolerance) continue;
    const score = d + KIND_BIAS[cands[i].kind] * tolerance * 0.25;
    if (score < bestScore) {
      bestScore = score;
      best = i;
      bx = wx;
      by = wy;
      bz = wz;
    }
  }
  if (best < 0) return null;
  const c = cands[best];
  const res = out ?? { kind: c.kind, world: [0, 0, 0] as Vec3, normal: null };
  res.kind = c.kind;
  res.world[0] = bx;
  res.world[1] = by;
  res.world[2] = bz;
  if (c.normal) {
    const n = qrot(rotation, vnorm(c.normal));
    res.normal = n;
  } else res.normal = null;
  return res;
}

// ---- axis choice --------------------------------------------------------------------------------------

export type AxisChoice = 'auto' | 'x' | 'y' | 'z' | 'normal';
export const AXIS_CHOICES: readonly AxisChoice[] = ['auto', 'x', 'y', 'z', 'normal'];

export const AXIS_CHOICE_LABELS: Record<AxisChoice, string> = {
  auto: 'Auto',
  x: 'X',
  y: 'Y',
  z: 'Z',
  normal: 'Normal',
};

export const isAxisChoice = (v: unknown): v is AxisChoice => AXIS_CHOICES.includes(v as AxisChoice);

/**
 * The world axis a new joint should use, or undefined to let `Editor.defaultAxis` decide (an axle of a cylinder,
 * else the camera-facing horizontal). `normal` is the surface normal under the FIRST click. Auto follows the face
 * normal, except on a body with its own axle (cylinders, cones, capsules), whose axle is the natural hinge.
 */
export function pickJointAxis(o: {
  type: JointType;
  choice: AxisChoice;
  normal: Vec3 | null;
  axial: boolean;
}): Vec3 | undefined {
  if (!AXIS_TYPES.includes(o.type)) return undefined;
  switch (o.choice) {
    case 'x':
      return [1, 0, 0];
    case 'y':
      return [0, 1, 0];
    case 'z':
      return [0, 0, 1];
    case 'normal':
      return o.normal ? vnorm(o.normal) : undefined;
    case 'auto':
      return o.axial || !o.normal ? undefined : vnorm(o.normal);
  }
}

// ---- limit presets ------------------------------------------------------------------------------------

export interface LimitPreset {
  id: string;
  label: string;
  /** null = limits off. */
  limit: Pick<LimitSpec, 'min' | 'max'> | null;
}

const D = Math.PI / 180;
export const HINGE_LIMIT_PRESETS: readonly LimitPreset[] = [
  { id: 'off', label: 'No limits', limit: null },
  { id: 'pm45', label: '±45°', limit: { min: -45 * D, max: 45 * D } },
  { id: 'pm90', label: '±90°', limit: { min: -90 * D, max: 90 * D } },
  { id: '0-90', label: '0 – 90°', limit: { min: 0, max: 90 * D } },
  { id: '0-180', label: '0 – 180°', limit: { min: 0, max: 180 * D } },
];
export const SLIDER_LIMIT_PRESETS: readonly LimitPreset[] = [
  { id: 'off', label: 'No limits', limit: null },
  { id: 'pm0.5', label: '±0.5 m', limit: { min: -0.5, max: 0.5 } },
  { id: '0-1', label: '0 – 1 m', limit: { min: 0, max: 1 } },
  { id: 'pm1', label: '±1 m', limit: { min: -1, max: 1 } },
];

/** The presets that make sense for a type (hinge: angles, slider: metres), or an empty list. */
export function limitPresetsFor(type: JointType): readonly LimitPreset[] {
  return type === 'hinge' ? HINGE_LIMIT_PRESETS : type === 'slider' ? SLIDER_LIMIT_PRESETS : [];
}

/** The `limit` field a preset id gives a new joint of this type, or null when no limits are asked for. */
export function limitFromPreset(type: JointType, id: string): LimitSpec | null {
  const p = limitPresetsFor(type).find((x) => x.id === id);
  return p?.limit ? { enabled: true, min: p.limit.min, max: p.limit.max } : null;
}

// ---- endpoint facts -----------------------------------------------------------------------------------

/** What the per-type defaults need to know about one end of a joint. */
export interface EndInfo {
  /** Body id, or null for the world. */
  body: string | null;
  /** Anchor in world space. */
  point: Vec3;
  /** The body's pose and shape (identity pose and no shape for the world). */
  position: Vec3;
  rotation: Quat;
  shape: ShapeSpec | null;
}

/** World corners of a body's local bounding box. */
function worldCorners(e: EndInfo): Vec3[] {
  if (!e.shape) return [e.point];
  const b = localBox(e.shape);
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]]) {
        const w = qrot(e.rotation, [x, y, z]);
        out.push([w[0] + e.position[0], w[1] + e.position[1], w[2] + e.position[2]]);
      }
  return out;
}

/** Highest world y of the body (its anchor's y for the world). */
export function bodyTop(e: EndInfo): number {
  let top = -Infinity;
  for (const c of worldCorners(e)) top = Math.max(top, c[1]);
  return top;
}

/** World axis-aligned box of a body's oriented bounding box. */
export function worldBox(e: EndInfo): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of worldCorners(e)) {
    for (let i = 0; i < 3; i++) {
      if (c[i] < min[i]) min[i] = c[i];
      if (c[i] > max[i]) max[i] = c[i];
    }
  }
  return { min, max };
}

/**
 * Radius of the body around a world axis through its centre: the farthest hull point (or box corner) from the
 * axis, limited by the bounding sphere. A cylinder spun about its own axle gives its true radius; a ball its own.
 */
export function radiusAboutAxis(e: EndInfo, axisWorld: Vec3): number {
  if (!e.shape) return 0.5;
  const spec = e.shape;
  const n = vnorm(qrotInv(e.rotation, axisWorld));
  if (shapeDef(spec.type).axial && Math.abs(n[1]) > 0.999) return Math.max(spec.size[0], spec.size[2]) / 2;
  const pts = shapeConvexPoints(spec);
  let best = 0;
  const consider = (p: Vec3) => {
    const d = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
    best = Math.max(best, Math.hypot(p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]));
  };
  if (pts && pts.length) {
    for (const p of pts) consider(p);
    return best;
  }
  const b = localBox(spec);
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) consider([x, y, z]);
  return Math.min(best, shapeBoundingRadius(spec));
}

/** Unit vector (body local) along the longest side of the body's local box; [1,0,0] for the world. */
export function longestLocalAxis(e: EndInfo): Vec3 {
  if (!e.shape) return [1, 0, 0];
  const b = localBox(e.shape);
  const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const i = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
  const v: Vec3 = [0, 0, 0];
  v[i] = 1;
  return v;
}

// ---- per-type defaults --------------------------------------------------------------------------------

/** What a type changes about a fresh joint, on top of `createJoint`'s generic defaults. */
export interface TypeDefaults {
  params: Partial<JointParams>;
  motor?: Partial<MotorSpec>;
}

const MIN_RADIUS = 0.05;
const MAX_RADIUS = 50;

/**
 * Sensible settings for each joint type given its two ends and the chosen world axis: pulley fixed points two
 * metres above the anchors (or the bodies' tops), gear / belt radii from the bodies and the ratio from them,
 * a rack travelling along B's longest side, a winch that reels in slowly. Other types take the generic defaults.
 */
export function typeDefaults(type: JointType, a: EndInfo, b: EndInfo, axisWorld: Vec3): TypeDefaults {
  const axisB = (): Vec3 => vnorm(qrotInv(b.rotation, axisWorld), [0, 0, 1]);
  const rA = clamp(radiusAboutAxis(a, axisWorld), MIN_RADIUS, MAX_RADIUS);
  const rB = clamp(radiusAboutAxis(b, axisWorld), MIN_RADIUS, MAX_RADIUS);
  switch (type) {
    case 'pulley':
      return {
        params: {
          pulleyA: [a.point[0], Math.max(a.point[1], bodyTop(a)) + 2, a.point[2]],
          pulleyB: [b.point[0], Math.max(b.point[1], bodyTop(b)) + 2, b.point[2]],
          ratio: 1,
        },
      };
    case 'gear':
      return { params: { radiusA: rA, radiusB: rB, ratio: clamp(rA / rB, 0.01, 1000), axisB: axisB() } };
    case 'belt':
      return { params: { radiusA: rA, radiusB: rB, ratio: clamp(rA / rB, 0.01, 1000), axisB: axisB() } };
    case 'rack':
      return { params: { radiusA: rA, axisB: longestLocalAxis(b) } };
    case 'screw':
      return { params: { pitch: 0.2 } };
    case 'winch':
      return { params: {}, motor: { mode: 'velocity', targetVelocity: 0.5, keyPos: '', keyNeg: '' } };
    case 'conetwist':
      return { params: { swing: Math.PI / 4 } };
    default:
      return { params: {} };
  }
}

// ---- connect all --------------------------------------------------------------------------------------

export type ConnectMode = 'chain' | 'star' | 'pairs';
export const CONNECT_MODES: readonly { value: ConnectMode; label: string; title: string }[] = [
  { value: 'chain', label: 'Chain', title: 'Join the bodies one after another, in selection order' },
  { value: 'star', label: 'Star', title: 'Join every body to the first selected one' },
  { value: 'pairs', label: 'All pairs', title: 'Join every pair of bodies (at most 40 joints)' },
];
export const isConnectMode = (v: unknown): v is ConnectMode => CONNECT_MODES.some((m) => m.value === v);

/** Upper bound on the joints one "Connect all" creates. */
export const MAX_CONNECT_JOINTS = 40;

/** Index pairs to join for `n` bodies; `truncated` says the all-pairs list was cut at the cap. */
export function connectPairs(n: number, mode: ConnectMode): { pairs: [number, number][]; truncated: boolean } {
  const pairs: [number, number][] = [];
  let truncated = false;
  if (mode === 'chain') for (let i = 0; i + 1 < n; i++) pairs.push([i, i + 1]);
  else if (mode === 'star') for (let i = 1; i < n; i++) pairs.push([0, i]);
  else {
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (pairs.length >= MAX_CONNECT_JOINTS) truncated = true;
        else pairs.push([i, j]);
      }
  }
  return { pairs, truncated };
}

/**
 * The points on two bodies' world bounding boxes that are closest to each other (equal when the boxes touch or
 * overlap: then the middle of the shared range, per axis). Used as joint anchors when bodies are not at the same place.
 */
export function closestBoxPoints(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): [Vec3, Vec3] {
  const pa: Vec3 = [0, 0, 0];
  const pb: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const lo = Math.max(a.min[i], b.min[i]);
    const hi = Math.min(a.max[i], b.max[i]);
    if (lo <= hi) {
      pa[i] = pb[i] = (lo + hi) / 2;
    } else if (a.max[i] < b.min[i]) {
      pa[i] = a.max[i];
      pb[i] = b.min[i];
    } else {
      pa[i] = a.min[i];
      pb[i] = b.max[i];
    }
  }
  return [pa, pb];
}

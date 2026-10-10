/**
 * Convex chunk — an arbitrary convex solid, the product of the cut tool (ED-41).
 *
 * The corner points live in the hidden text parameter `pts` ("x,y,z;x,y,z;…"), normalised into the unit box
 * [-0.5, 0.5]³ and quantised to 4 decimals; `spec.size` is the extent the unit box is stretched to, so resizing
 * in the inspector scales the chunk and the volume is (unit-hull volume) × sx·sy·sz. The origin is wherever the
 * creator put it (the cut tool puts it at the volume centroid).
 */
import { convexHull, hullVolume, type Hull } from '../../core/convexHull';
import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import { clampDims, hullCollider, hullGeometry, unitSpec, WIDTH_HEIGHT_DEPTH } from './helpers';

/** Longest `pts` string kept (≈ 700 corners). */
export const CHUNK_MAX_TEXT = 24000;

/** Shown for a chunk without (valid) points: an octahedron. */
const DEFAULT_UNIT: Vec3[] = [
  [-0.5, 0, 0],
  [0.5, 0, 0],
  [0, -0.5, 0],
  [0, 0.5, 0],
  [0, 0, -0.5],
  [0, 0, 0.5],
];

const DEFAULT_HULL: Hull = (() => {
  const h = convexHull(DEFAULT_UNIT);
  if (!h) throw new Error('chunk: default hull is degenerate');
  return h;
})();

interface Parsed {
  /** Hull corners in the unit box. */
  unit: Vec3[];
  unitVolume: number;
  hull: Hull;
}

const cache = new Map<string, Parsed>();

const q4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Corner points of a `pts` string; malformed entries are dropped. */
export function parseChunkPoints(text: string): Vec3[] {
  const out: Vec3[] = [];
  for (const part of text.split(';')) {
    const c = part.split(',');
    if (c.length !== 3) continue;
    const v = c.map(Number);
    if (!v.every(Number.isFinite)) continue;
    out.push([
      Math.max(-0.5, Math.min(0.5, v[0])),
      Math.max(-0.5, Math.min(0.5, v[1])),
      Math.max(-0.5, Math.min(0.5, v[2])),
    ]);
  }
  return out;
}

/** Hull of unit-box points quantised to 4 decimals (the stored precision), or null if flat. */
export function quantizedHull(unit: readonly Vec3[]): Hull | null {
  const pts = unit.map((p) => [q4(p[0]), q4(p[1]), q4(p[2])] as Vec3);
  const h = convexHull(pts);
  if (!h || hullVolume(h) < 1e-9) return null;
  return h;
}

/** The `pts` string for unit-box points: only the hull corners are written. Null if the points are flat. */
export function encodeChunkPoints(unit: readonly Vec3[]): string | null {
  const h = quantizedHull(unit);
  if (!h) return null;
  return h.vertices.map((v) => `${q4(v[0])},${q4(v[1])},${q4(v[2])}`).join(';');
}

function parsed(text: string): Parsed {
  let p = cache.get(text);
  if (p) return p;
  const hull = quantizedHull(parseChunkPoints(text)) ?? DEFAULT_HULL;
  p = { unit: hull.vertices, unitVolume: hullVolume(hull), hull };
  if (cache.size > 256) cache.clear();
  cache.set(text, p);
  return p;
}

const textOf = (params: Record<string, unknown> | undefined): string =>
  typeof params?.pts === 'string' ? params.pts : '';

/** Hull corners of a chunk in unit-box coordinates. */
export function chunkUnitPoints(text: string): Vec3[] {
  return parsed(text).unit;
}

const scaled = (unit: Vec3[], [x, y, z]: Vec3): Vec3[] => unit.map((p) => [p[0] * x, p[1] * y, p[2] * z] as Vec3);

export const chunk: ShapeDef = {
  id: 'chunk',
  label: 'Convex chunk',
  icon: 'icosahedron',
  category: 'special',
  blurb: 'Any convex solid — what the cut tool leaves behind',
  defaultSize: [1, 1, 1],
  params: [{ key: 'pts', label: 'Corner points', kind: 'text', default: '', maxLength: CHUNK_MAX_TEXT, hidden: true }],
  sizeFields: WIDTH_HEIGHT_DEPTH,
  normalizeSize: (size) => clampDims(size),
  volume: ({ size, params }) => parsed(textOf(params)).unitVolume * size[0] * size[1] * size[2],
  boundingRadius: ({ size, params }) => {
    let r2 = 0;
    for (const p of parsed(textOf(params)).unit)
      r2 = Math.max(r2, (p[0] * size[0]) ** 2 + (p[1] * size[1]) ** 2 + (p[2] * size[2]) ** 2);
    return Math.sqrt(r2);
  },
  // Distance from the origin down to the lowest corner (the chunk's origin is its centroid, not its box centre).
  halfHeight: ({ size, params }) => -Math.min(...parsed(textOf(params)).unit.map((p) => p[1])) * size[1],
  convexPoints: ({ size, params }) => scaled(parsed(textOf(params)).unit, size),
  colliders: (R, { size, params }) => hullCollider(R, scaled(parsed(textOf(params)).unit, size), size),
  geometryKey: ({ params }) => `chunk:${textOf(params)}`,
  geometry: (T, spec) => hullGeometry(T, parsed(textOf(unitSpec(spec).params)).unit),
};

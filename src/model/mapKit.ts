/**
 * Helpers for building maps (`content/map-*.ts`): a walled arena and a top-down preview image.
 *
 * Everything here is built from the public `Builder` DSL and the shape registry — the same primitives a user
 * has — and is pure (no DOM, no three.js), so maps and their thumbnails can be generated and tested in Node.
 */
import { qrot, type Quat, type Vec3 } from '../core/math';
import type { Builder } from './builder';
import { shapeBoundingRadius, shapeConvexPoints } from './shapeRegistry';
import { isBody, type BodyEntity, type SceneDocument } from './types';

export interface WallOptions {
  /** Inner half extents of the enclosed floor along x and z, metres. */
  halfX: number;
  halfZ: number;
  /** Wall height above the floor and thickness, metres. */
  height: number;
  thickness: number;
  material: string;
}

/**
 * Four static walls around the rectangle `±halfX × ±halfZ` standing on the ground. The inner faces sit exactly on
 * the rectangle's edge and the walls overlap at the corners, so there is no gap anywhere.
 */
export function addWalls(b: Builder, o: WallOptions): BodyEntity[] {
  const { halfX, halfZ, height, thickness: t, material } = o;
  const along = (name: string, size: Vec3, position: Vec3) =>
    b.body(name, 'box', size, position, { bodyType: 'static', material });
  return [
    along('North wall', [2 * halfX + 2 * t, height, t], [0, height / 2, -(halfZ + t / 2)]),
    along('South wall', [2 * halfX + 2 * t, height, t], [0, height / 2, halfZ + t / 2]),
    along('West wall', [t, height, 2 * halfZ], [-(halfX + t / 2), height / 2, 0]),
    along('East wall', [t, height, 2 * halfZ], [halfX + t / 2, height / 2, 0]),
  ];
}

// ── top-down preview ────────────────────────────────────────────────────────────────────────────────

type P2 = [number, number];

/** Convex hull (Andrew's monotone chain), counter-clockwise, without repeated end point. */
function hull(points: P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** The x/z outline of a body: the hull of its rotated convex points, or its bounding circle (spheres …). */
function footprint(body: BodyEntity): { poly: P2[] } | { circle: { c: P2; r: number } } {
  const pts = shapeConvexPoints(body.shape);
  if (pts) {
    const q: Quat = body.rotation;
    const world = pts.map((p): P2 => {
      const r = qrot(q, p);
      return [body.position[0] + r[0], body.position[2] + r[2]];
    });
    return { poly: hull(world) };
  }
  return { circle: { c: [body.position[0], body.position[2]], r: shapeBoundingRadius(body.shape) } };
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

/**
 * A square top-down sketch of a scene as an SVG `data:` URL — the ground slab and the footprint of every body,
 * coloured by material, higher bodies drawn over lower ones. It is what the Maps tab shows for maps without a
 * rendered thumbnail, and it is drawn from the document itself, so it can never disagree with the map.
 */
export function topDownThumbnail(doc: SceneDocument, px = 192): string {
  const bodies = doc.entities.filter(isBody);
  const shapes = bodies.map((b) => ({ b, f: footprint(b) }));
  const ground = doc.settings.ground;

  // Frame the bodies (the ground slab is usually far larger than the interesting part); fall back to the ground.
  let reach = 0;
  for (const { f } of shapes) {
    if ('poly' in f) for (const [x, z] of f.poly) reach = Math.max(reach, Math.abs(x), Math.abs(z));
    else reach = Math.max(reach, Math.abs(f.circle.c[0]) + f.circle.r, Math.abs(f.circle.c[1]) + f.circle.r);
  }
  if (reach === 0) reach = ground.enabled ? Math.min(ground.halfSize, 20) : 5;
  const half = reach * 1.08;
  const s = px / (2 * half);
  const X = (x: number) => fmt(px / 2 + x * s);
  const Y = (z: number) => fmt(px / 2 + z * s);

  const parts: string[] = [`<rect width="${px}" height="${px}" fill="#10151d"/>`];
  if (ground.enabled) {
    const g = Math.min(ground.halfSize, half * 1.5);
    parts.push(
      `<rect x="${X(-g)}" y="${Y(-g)}" width="${fmt(2 * g * s)}" height="${fmt(2 * g * s)}" fill="${ground.color}"/>`,
    );
  }
  // Light grid, every metre when it is readable, else every 5 m.
  const step = s >= 8 ? 1 : 5;
  const lines: string[] = [];
  for (let v = Math.ceil(-half / step) * step; v <= half; v += step) {
    lines.push(`M${X(v)} 0V${px}M0 ${Y(v)}H${px}`);
  }
  parts.push(`<path d="${lines.join('')}" stroke="#ffffff" stroke-opacity="0.05" fill="none"/>`);

  shapes.sort((a, b) => a.b.position[1] - b.b.position[1]);
  for (const { b, f } of shapes) {
    const style = `fill="${b.material.color}" fill-opacity="${b.bodyType === 'static' ? 0.95 : 0.85}" stroke="#000" stroke-opacity="0.4" stroke-width="0.8"`;
    if ('poly' in f) {
      parts.push(`<polygon points="${f.poly.map(([x, z]) => `${X(x)},${Y(z)}`).join(' ')}" ${style}/>`);
    } else {
      parts.push(`<circle cx="${X(f.circle.c[0])}" cy="${Y(f.circle.c[1])}" r="${fmt(f.circle.r * s)}" ${style}/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}">${parts.join('')}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Point sets of the regular solids in the orientation they rest in (a face down, a face up), each with circumradius
 * 0.5 — the building blocks of the tetrahedron, octahedron and dodecahedron shapes and of the d4 / d8 / d12 / d20.
 */
import { qfromUnitVectors, qrot, type Vec3 } from '../../core/math';
import { convexHull3, hullFaces } from './hull3';

export const PHI = (1 + Math.sqrt(5)) / 2;

function scaleTo(pts: Vec3[], circumradius: number): Vec3[] {
  const r = Math.max(...pts.map((p) => Math.hypot(p[0], p[1], p[2])));
  return pts.map((p): Vec3 => [(p[0] * circumradius) / r, (p[1] * circumradius) / r, (p[2] * circumradius) / r]);
}

/** Rotate so that the face whose normal is closest to +Y points exactly up. */
export function faceUp(pts: Vec3[]): Vec3[] {
  const hull = convexHull3(pts);
  if (!hull) return pts;
  let best: Vec3 = [0, 1, 0],
    bestDot = -2;
  for (const f of hullFaces(hull)) {
    if (f.normal[1] > bestDot) {
      bestDot = f.normal[1];
      best = f.normal;
    }
  }
  const q = qfromUnitVectors(best, [0, 1, 0]);
  return pts.map((p) => qrot(q, p));
}

/** Regular tetrahedron, apex up, base face down. */
export function tetrahedronPoints(): Vec3[] {
  const rb = Math.sqrt(8) / 3;
  const base = [0, 1, 2].map((k): Vec3 => {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / 3;
    return [rb * Math.cos(a), -1 / 3, rb * Math.sin(a)];
  });
  return scaleTo([[0, 1, 0], ...base], 0.5);
}

/** Regular octahedron with a vertex up (a diamond). */
export function octahedronVertexUp(): Vec3[] {
  return scaleTo(
    [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ],
    0.5,
  );
}

/** Regular octahedron resting on a face. */
export function octahedronFaceUp(): Vec3[] {
  return faceUp(octahedronVertexUp());
}

function dodecahedronRaw(): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) out.push([x, y, z]);
  for (const a of [-1, 1])
    for (const b of [-1, 1]) {
      out.push([0, a / PHI, b * PHI]);
      out.push([a / PHI, b * PHI, 0]);
      out.push([a * PHI, 0, b / PHI]);
    }
  return out;
}

/** Regular dodecahedron resting on a pentagonal face. */
export function dodecahedronFaceUp(): Vec3[] {
  return scaleTo(faceUp(dodecahedronRaw()), 0.5);
}

function icosahedronRaw(): Vec3[] {
  const out: Vec3[] = [];
  for (const a of [-1, 1])
    for (const b of [-1, 1]) {
      out.push([0, a, b * PHI]);
      out.push([a, b * PHI, 0]);
      out.push([b * PHI, 0, a]);
    }
  return out;
}

/** Regular icosahedron resting on a triangular face. */
export function icosahedronFaceUp(): Vec3[] {
  return scaleTo(faceUp(icosahedronRaw()), 0.5);
}

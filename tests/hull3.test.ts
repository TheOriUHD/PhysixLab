/**
 * Package SH, chunk 2 — the small convex-hull module the new shapes use (src/model/shapes/hull3.ts): exact volumes
 * of known solids, every input point inside the result, coplanar faces merged into polygons, degenerate input.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { convexHull3, convexVolume, hullArea, hullFaces, hullVolume } from '../src/model/shapes/hull3';

const cube = (s = 1): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1]) for (const z of [-1, 1]) out.push([(x * s) / 2, (y * s) / 2, (z * s) / 2]);
  return out;
};

/** Small deterministic generator so the random clouds are the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('convexHull3', () => {
  it('a unit cube: volume 1, area 6, twelve triangles, six quadrilateral faces', () => {
    const h = convexHull3(cube())!;
    expect(h.points).toHaveLength(8);
    expect(h.tris).toHaveLength(12);
    expect(hullVolume(h)).toBeCloseTo(1, 12);
    expect(hullArea(h)).toBeCloseTo(6, 12);
    const faces = hullFaces(h);
    expect(faces).toHaveLength(6);
    for (const f of faces) {
      expect(f.verts).toHaveLength(4);
      // outward normals: the face plane has the centre on its inner side
      expect(f.d).toBeCloseTo(0.5, 12);
    }
  });

  it('ignores interior and duplicate points, including a regular grid on the faces', () => {
    const pts = cube(2);
    for (let i = 0; i < 20; i++) pts.push([0.1 * i - 1, 0.3, -0.2]); // interior
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) pts.push([-1 + i / 2, -1 + j / 2, 1]); // on the +z face
    pts.push(...cube(2)); // duplicates
    const h = convexHull3(pts)!;
    expect(h.points).toHaveLength(8 + 0 * pts.length);
    expect(hullVolume(h)).toBeCloseTo(8, 10);
  });

  it('random clouds: every point lies inside every face plane, and the volume is positive', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rnd = lcg(seed);
      const pts: Vec3[] = [];
      for (let i = 0; i < 300; i++) pts.push([rnd() * 2 - 1, rnd() * 3 - 1.5, rnd() - 0.5]);
      const h = convexHull3(pts)!;
      expect(hullVolume(h)).toBeGreaterThan(0.5);
      for (const [a, b, c] of h.tris) {
        const p = h.points[a],
          q = h.points[b],
          r = h.points[c];
        const n: Vec3 = [
          (q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1]),
          (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]),
          (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]),
        ];
        const l = Math.hypot(...n);
        for (const x of pts) {
          const d = ((x[0] - p[0]) * n[0] + (x[1] - p[1]) * n[1] + (x[2] - p[2]) * n[2]) / l;
          expect(d).toBeLessThan(1e-9);
        }
      }
      // Euler: V − E + F = 2 with E = 3F/2
      expect(h.points.length - (3 * h.tris.length) / 2 + h.tris.length).toBe(2);
    }
  });

  it('points on a sphere: the hull volume approaches 4/3 π r³ from below', () => {
    const pts: Vec3[] = [];
    const n = 24;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j < 2 * n; j++) {
        const th = (Math.PI * i) / n,
          ph = (Math.PI * j) / n;
        pts.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
      }
    const v = convexVolume(pts);
    expect(v).toBeLessThan((4 / 3) * Math.PI);
    expect(v).toBeGreaterThan(0.97 * (4 / 3) * Math.PI);
  });

  it('a regular octahedron has eight triangular faces and volume 4/3 a³', () => {
    const pts: Vec3[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const h = convexHull3(pts)!;
    expect(hullVolume(h)).toBeCloseTo(4 / 3, 12);
    const faces = hullFaces(h);
    expect(faces).toHaveLength(8);
    for (const f of faces) expect(f.verts).toHaveLength(3);
  });

  it('refuses flat, collinear or too few points instead of returning garbage', () => {
    expect(convexHull3([[0, 0, 0]])).toBeNull();
    expect(
      convexHull3([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
      ]),
    ).toBeNull();
    expect(
      convexHull3([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [3, 0, 0],
      ]),
    ).toBeNull();
    expect(convexVolume([])).toBe(0);
  });

  it('is scale-free: a hull a thousand times smaller has the matching volume', () => {
    const h = convexHull3(cube(0.001))!;
    expect(hullVolume(h)).toBeCloseTo(1e-9, 18);
  });
});

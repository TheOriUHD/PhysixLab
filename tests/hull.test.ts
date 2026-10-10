/** Pure convex hull, volume / centroid and plane clipping (src/core/hull.ts) against analytic values. */
import { describe, expect, it } from 'vitest';
import { clipConvexByPlane, convexHull, hullCentroid, hullVolume } from '../src/core/hull';
import type { Vec3 } from '../src/core/math';

const cube = (hx = 0.5, hy = 0.5, hz = 0.5): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) out.push([x * hx, y * hy, z * hz]);
  return out;
};

function fibonacciSphere(n: number, r: number): Vec3[] {
  const out: Vec3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const rr = Math.sqrt(1 - y * y);
    out.push([Math.cos(ga * i) * rr * r, y * r, Math.sin(ga * i) * rr * r]);
  }
  return out;
}

const vol = (pts: Vec3[]) => {
  const h = convexHull(pts);
  return h ? hullVolume(h) : 0;
};

describe('convexHull', () => {
  it('unit cube has volume 1 and centroid at its centre, with 8 vertices', () => {
    const h = convexHull(cube())!;
    expect(h.vertices).toHaveLength(8);
    expect(hullVolume(h)).toBeCloseTo(1, 12);
    const c = hullCentroid(h);
    for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(0, 12);
  });

  it('tetrahedron volume is |det|/6 and centroid the vertex mean', () => {
    const t: Vec3[] = [
      [0, 0, 0],
      [3, 0, 0],
      [0, 2, 0],
      [0, 0, 1],
    ];
    const h = convexHull(t)!;
    expect(hullVolume(h)).toBeCloseTo(1, 12);
    const c = hullCentroid(h);
    expect(c[0]).toBeCloseTo(0.75, 12);
    expect(c[1]).toBeCloseTo(0.5, 12);
    expect(c[2]).toBeCloseTo(0.25, 12);
  });

  it('ignores interior, duplicate and face points', () => {
    const pts = [...cube(), ...cube(), [0, 0, 0], [0.5, 0, 0], [0.1, 0.2, -0.3]] as Vec3[];
    const h = convexHull(pts)!;
    expect(h.vertices).toHaveLength(8);
    expect(hullVolume(h)).toBeCloseTo(1, 12);
  });

  it('returns null for degenerate input', () => {
    expect(convexHull([])).toBeNull();
    expect(convexHull(cube().slice(0, 3))).toBeNull();
    // coplanar square
    expect(
      convexHull([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [0.5, 0.5, 0],
      ]),
    ).toBeNull();
    // collinear
    expect(
      convexHull([
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
        [3, 3, 3],
      ]),
    ).toBeNull();
    // all the same point
    expect(
      convexHull([
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ]),
    ).toBeNull();
  });

  it('is exact for a translated, scaled, randomly ordered box', () => {
    const pts = cube(1.5, 0.25, 2).map((p) => [p[0] + 10, p[1] - 4, p[2] + 7] as Vec3);
    pts.reverse();
    const h = convexHull(pts)!;
    expect(hullVolume(h)).toBeCloseTo(3 * 0.5 * 4, 9);
    const c = hullCentroid(h);
    expect(c[0]).toBeCloseTo(10, 9);
    expect(c[1]).toBeCloseTo(-4, 9);
    expect(c[2]).toBeCloseTo(7, 9);
  });

  it('a sphere point cloud approaches the analytic volume', () => {
    const v = vol(fibonacciSphere(400, 1));
    expect(Math.abs(v - (4 / 3) * Math.PI) / ((4 / 3) * Math.PI)).toBeLessThan(0.03);
  });
});

describe('clipConvexByPlane', () => {
  it('cuts the unit cube at x = 0 into two halves of volume 0.5', () => {
    const { above, below } = clipConvexByPlane(cube(), [0, 0, 0], [1, 0, 0]);
    expect(vol(above)).toBeCloseTo(0.5, 12);
    expect(vol(below)).toBeCloseTo(0.5, 12);
    const ca = hullCentroid(convexHull(above)!);
    const cb = hullCentroid(convexHull(below)!);
    expect(ca[0]).toBeCloseTo(0.25, 12);
    expect(cb[0]).toBeCloseTo(-0.25, 12);
    expect(ca[1]).toBeCloseTo(0, 12);
    expect(cb[2]).toBeCloseTo(0, 12);
  });

  it('an off-centre cut gives 0.25 / 0.75 and the volumes sum to the original', () => {
    const { above, below } = clipConvexByPlane(cube(), [-0.25, 0, 0], [1, 0, 0]);
    expect(vol(below)).toBeCloseTo(0.25, 12);
    expect(vol(above)).toBeCloseTo(0.75, 12);
    expect(vol(above) + vol(below)).toBeCloseTo(1, 12);
    expect(hullCentroid(convexHull(below)!)[0]).toBeCloseTo(-0.375, 12);
    expect(hullCentroid(convexHull(above)!)[0]).toBeCloseTo(0.125, 12);
  });

  it('mass-weighted centroids of the halves recombine to the original centroid (oblique plane)', () => {
    const pts = cube(1, 0.5, 0.7);
    const n: Vec3 = [1, 2, -0.5];
    const { above, below } = clipConvexByPlane(pts, [0.1, 0.05, 0.2], n);
    const ha = convexHull(above)!,
      hb = convexHull(below)!;
    const va = hullVolume(ha),
      vb = hullVolume(hb);
    expect(va + vb).toBeCloseTo(2 * 1 * 1.4, 10);
    const ca = hullCentroid(ha),
      cb = hullCentroid(hb);
    for (let k = 0; k < 3; k++) expect((ca[k] * va + cb[k] * vb) / (va + vb)).toBeCloseTo(0, 10);
  });

  it('a diagonal cut through a cube corner cuts off a tetrahedron', () => {
    // plane x + y + z = 2 passes through three neighbours of the (1,1,1) corner of the [0,1]^3 cube
    const pts = cube().map((p) => [p[0] + 0.5, p[1] + 0.5, p[2] + 0.5] as Vec3);
    const { above, below } = clipConvexByPlane(pts, [1, 1, 0], [1, 1, 1]);
    expect(vol(above)).toBeCloseTo(1 / 6, 12);
    expect(vol(below)).toBeCloseTo(5 / 6, 12);
  });

  it('a plane that misses the solid leaves one side empty', () => {
    const { above, below } = clipConvexByPlane(cube(), [5, 0, 0], [1, 0, 0]);
    expect(vol(above)).toBe(0);
    expect(vol(below)).toBeCloseTo(1, 12);
  });

  it('cutting a sphere cloud matches the analytic cap volume', () => {
    const r = 1;
    const h = 0.4; // plane at y = r - h => the upper cap has height h
    const { above, below } = clipConvexByPlane(fibonacciSphere(200, r), [0, r - h, 0], [0, 1, 0]);
    const cap = (Math.PI * h * h * (3 * r - h)) / 3;
    const total = (4 / 3) * Math.PI * r * r * r;
    expect(Math.abs(vol(above) - cap) / cap).toBeLessThan(0.12);
    expect(Math.abs(vol(below) - (total - cap)) / (total - cap)).toBeLessThan(0.06);
  });
});

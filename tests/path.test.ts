/**
 * Path evaluation (src/model/path.ts): the cardinal spline through a path entity's points, its tangent, and the
 * arc-length parameterisation movers use to travel at constant speed.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, vdist, vlen, type Vec3 } from '../src/core/math';
import { createPath } from '../src/model/factory';
import { PathCurve, pathCurveOf } from '../src/model/path';

const line = (n: number): Vec3[] => Array.from({ length: n }, (_, i) => [i, 0, 0] as Vec3);

/** n points evenly spaced on a circle of radius r in the XZ plane. */
const circle = (n: number, r: number): Vec3[] =>
  Array.from(
    { length: n },
    (_, i) => [r * Math.cos((2 * Math.PI * i) / n), 0, r * Math.sin((2 * Math.PI * i) / n)] as Vec3,
  );

describe('PathCurve', () => {
  it('a straight line of evenly spaced points is exactly that line, with the right length', () => {
    const c = new PathCurve({ points: line(4), closed: false, tension: 0 });
    expect(c.segments).toBe(3);
    expect(c.length).toBeCloseTo(3, 9);
    for (const t of [0, 0.1, 0.5, 0.77, 1]) {
      const p = c.positionAt(t);
      expect(p[0]).toBeCloseTo(3 * t, 9);
      expect(p[1]).toBeCloseTo(0, 12);
      expect(p[2]).toBeCloseTo(0, 12);
    }
    const tan = c.tangentAt(0.4);
    expect(tan[0]).toBeCloseTo(1, 9);
    expect(tan[1]).toBeCloseTo(0, 9);
  });

  it('passes through every control point (open and closed) at t = i / segments', () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [2, 1, 0],
      [3, 3, 1],
      [1, 4, 4],
      [-2, 2, 3],
    ];
    for (const closed of [false, true]) {
      const c = new PathCurve({ points: pts, closed, tension: 0 });
      pts.forEach((p, i) => {
        const q = c.positionAt(i / c.segments);
        expect(vdist(q, p)).toBeLessThan(1e-9);
      });
    }
    expect(new PathCurve({ points: pts, closed: true, tension: 0 }).segments).toBe(5);
    expect(new PathCurve({ points: pts, closed: false, tension: 0 }).segments).toBe(4);
  });

  it('the tangent is a unit vector along the direction of travel (matches the finite difference)', () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [2, 1, 0],
      [3, 3, 1],
      [1, 4, 4],
    ];
    const c = new PathCurve({ points: pts, closed: false, tension: 0 });
    for (const t of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      const tan = c.tangentAt(t);
      expect(vlen(tan)).toBeCloseTo(1, 9);
      const a = c.positionAt(t - 1e-5);
      const b = c.positionAt(t + 1e-5);
      const fd: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const l = vlen(fd);
      expect(tan[0]).toBeCloseTo(fd[0] / l, 5);
      expect(tan[1]).toBeCloseTo(fd[1] / l, 5);
      expect(tan[2]).toBeCloseTo(fd[2] / l, 5);
    }
  });

  it('a closed ring through 16 points on a circle has the circle length and stays on the circle', () => {
    const r = 2.5;
    const c = new PathCurve({ points: circle(16, r), closed: true, tension: 0 });
    expect(c.length).toBeGreaterThan(2 * Math.PI * r * 0.999);
    expect(c.length).toBeLessThan(2 * Math.PI * r * 1.001);
    for (let k = 0; k < 64; k++) {
      const p = c.positionAtDistance((k / 64) * c.length);
      expect(Math.hypot(p[0], p[2])).toBeGreaterThan(r * 0.998);
      expect(Math.hypot(p[0], p[2])).toBeLessThan(r * 1.002);
      expect(p[1]).toBeCloseTo(0, 12);
    }
    // The tangent of a circle is perpendicular to the radius and the ring runs counter-clockwise (+x → +z).
    const p = c.positionAtDistance(0.3);
    const tan = c.tangentAtDistance(0.3);
    expect(Math.abs(p[0] * tan[0] + p[2] * tan[2]) / r).toBeLessThan(0.01);
    expect(p[0] * tan[2] - p[2] * tan[0]).toBeGreaterThan(0);
  });

  it('arc-length parameterisation moves at constant speed even when the control points are unevenly spaced', () => {
    // Segment lengths 0.5, 6, 0.5, 6: by parameter t alone the speed would differ by an order of magnitude.
    const pts: Vec3[] = [
      [0, 0, 0],
      [0.5, 0, 0],
      [6.5, 0, 0],
      [7, 0, 0],
      [13, 0, 0],
    ];
    const c = new PathCurve({ points: pts, closed: false, tension: 0 });
    expect(c.length).toBeCloseTo(13, 6);
    const steps = 130;
    let prev = c.positionAtDistance(0);
    for (let i = 1; i <= steps; i++) {
      const p = c.positionAtDistance((i / steps) * c.length);
      // within 3 % of the ideal step: the table interpolates linearly in t inside each of its 32 cells per segment
      expect(Math.abs(vdist(p, prev) - c.length / steps)).toBeLessThan(0.03 * (c.length / steps));
      prev = p;
    }
    // while the same number of equal t steps do not
    const a = vdist(c.positionAt(0), c.positionAt(1 / steps));
    const b = vdist(c.positionAt(0.375), c.positionAt(0.375 + 1 / steps));
    expect(Math.abs(a - b)).toBeGreaterThan(0.05);
  });

  it('distance and parameter are inverse maps', () => {
    const c = new PathCurve({ points: circle(7, 3), closed: true, tension: 0.2 });
    for (const t of [0, 0.013, 0.25, 0.5, 0.731, 0.999]) {
      expect(c.tAtDistance(c.distanceAt(t))).toBeCloseTo(t, 9);
    }
    for (const s of [0, 1, 5.5, c.length * 0.99]) {
      expect(c.distanceAt(c.tAtDistance(s))).toBeCloseTo(s, 9);
    }
  });

  it('wraps a closed path and clamps an open one', () => {
    const closed = new PathCurve({ points: circle(8, 1), closed: true, tension: 0 });
    const a = closed.positionAtDistance(0.4);
    const b = closed.positionAtDistance(0.4 + closed.length);
    const c = closed.positionAtDistance(0.4 - 3 * closed.length);
    expect(vdist(a, b)).toBeLessThan(1e-9);
    expect(vdist(a, c)).toBeLessThan(1e-9);
    expect(vdist(closed.positionAt(0), closed.positionAt(1))).toBeLessThan(1e-9);

    const open = new PathCurve({ points: line(3), closed: false, tension: 0 });
    expect(vdist(open.positionAtDistance(-5), [0, 0, 0])).toBeLessThan(1e-12);
    expect(vdist(open.positionAtDistance(99), [2, 0, 0])).toBeLessThan(1e-12);
    expect(open.tAtDistance(99)).toBe(1);
    expect(open.positionAt(7)[0]).toBeCloseTo(2, 12);
    expect(open.positionAt(-1)[0]).toBeCloseTo(0, 12);
  });

  it('tension 1 turns the segments into straight lines between the points (and tension 0 does not)', () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 3],
      [0, 0, 3],
    ];
    const straight = new PathCurve({ points: pts, closed: false, tension: 1 });
    expect(straight.length).toBeCloseTo(4 + 3 + 4, 9);
    // Every sample on segment 0 lies on the line z = 0
    for (let k = 0; k <= 20; k++) expect(straight.positionAt(k / 20 / 3)[2]).toBeCloseTo(0, 12);
    const smooth = new PathCurve({ points: pts, closed: false, tension: 0 });
    expect(smooth.length).toBeGreaterThan(0); // a cardinal curve overshoots its corners: longer than the polyline? only differs
    let maxZ = 0;
    for (let k = 0; k <= 20; k++) maxZ = Math.max(maxZ, Math.abs(smooth.positionAt(k / 20 / 3)[2]));
    expect(maxZ).toBeGreaterThan(0.01);
    // tension is clamped
    const over = new PathCurve({ points: pts, closed: false, tension: 7 });
    expect(over.length).toBeCloseTo(11, 9);
  });

  it('degenerate paths never produce NaN', () => {
    const empty = new PathCurve({ points: [], closed: false, tension: 0 });
    expect(empty.length).toBe(0);
    expect(empty.positionAt(0.5)).toEqual([0, 0, 0]);
    expect(empty.tangentAt(0.5)).toEqual([1, 0, 0]);
    const one = new PathCurve({ points: [[1, 2, 3]], closed: true, tension: 0 });
    expect(one.positionAt(0.3)).toEqual([1, 2, 3]);
    expect(one.positionAtDistance(5)).toEqual([1, 2, 3]);
    const same = new PathCurve({
      points: [
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ],
      closed: false,
      tension: 0,
    });
    expect(same.length).toBe(0);
    for (const v of [...same.positionAtDistance(1), ...same.tangentAtDistance(1), ...same.tangentAt(0.5)]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    const two = new PathCurve({
      points: [
        [0, 0, 0],
        [0, 0, 5],
      ],
      closed: true,
      tension: 0,
    }); // a loop needs three points
    expect(two.closed).toBe(false);
    expect(two.length).toBeCloseTo(5, 9);
    expect(Number.isFinite(two.positionAt(Number.NaN)[0])).toBe(true);
    expect(Number.isFinite(two.tAtDistance(Number.POSITIVE_INFINITY))).toBe(true);
  });

  it('polyline follows the curve and closes a loop', () => {
    const c = new PathCurve({ points: circle(6, 1), closed: true, tension: 0 });
    const pl = c.polyline(8);
    expect(pl.length).toBe(6 * 8 + 1);
    expect(vdist(pl[0], pl[pl.length - 1])).toBeLessThan(1e-9);
    const open = new PathCurve({ points: line(3), closed: false, tension: 0 }).polyline(4);
    expect(open.length).toBe(2 * 4 + 1);
    expect(vdist(open[open.length - 1], [2, 0, 0])).toBeLessThan(1e-9);
  });

  it('does not alias its input and does not allocate when given an output vector', () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ];
    const c = new PathCurve({ points: pts, closed: false, tension: 0 });
    pts[1][0] = 100;
    expect(c.positionAt(0.5)[0]).toBeCloseTo(1, 9);
    const out: Vec3 = [9, 9, 9];
    expect(c.positionAt(0.25, out)).toBe(out);
    expect(c.tangentAtDistance(0.5, out)).toBe(out);
  });
});

describe('pathCurveOf', () => {
  it('places the points in the world with the entity pose', () => {
    const path = createPath({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [4, 0, 0],
      ],
      position: [10, 1, 5],
      rotation: qfromAxisAngle([0, 1, 0], Math.PI / 2),
    });
    const c = pathCurveOf(path);
    expect(c.length).toBeCloseTo(4, 9);
    // +x of the path frame turns into −z after a quarter turn about y
    const end = c.positionAtDistance(4);
    expect(end[0]).toBeCloseTo(10, 9);
    expect(end[1]).toBeCloseTo(1, 9);
    expect(end[2]).toBeCloseTo(5 - 4, 9);
    const tan = c.tangentAt(0.3);
    expect(tan[2]).toBeCloseTo(-1, 9);
  });
});

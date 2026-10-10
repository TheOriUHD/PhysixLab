/**
 * ED-23: the pure path-editing maths (src/model/edit/pathEdit.ts) with analytic expectations, plus the contract that
 * a component's `path` reference survives every edit of the path and is cleared when the path is deleted.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, vdist, type Vec3 } from '../src/core/math';
import { makeComponent, registerComponent } from '../src/model/componentRegistry';
import { createBody, createPath } from '../src/model/factory';
import { LIMITS } from '../src/model/limits';
import { SceneStore } from '../src/model/store';
import type { BodyEntity } from '../src/model/types';
import { PathCurve } from '../src/model/path';
import {
  canRemovePoint,
  closestOnCurveToRay,
  closestOnPolylineToRay,
  flatten,
  insertPoint,
  pointsThrough,
  removePoint,
  resample,
  reversePoints,
  simplify,
  snapPointsToGrid,
  snapToGrid,
  subdivide,
} from '../src/model/edit/pathEdit';

const spec = (points: Vec3[], closed = false, tension = 0) => ({ points, closed, tension });
const bend: Vec3[] = [
  [0, 0, 0],
  [3, 0, 1],
  [5, 1, 4],
  [9, 2, 4],
  [10, 0, 0],
];

describe('ray picking on a polyline / curve', () => {
  it('finds the closest point on a known polyline', () => {
    const poly: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 4],
    ];
    // straight down onto the first leg at x = 1.3
    const h = closestOnPolylineToRay(poly, [1.3, 5, 0], [0, -1, 0])!;
    expect(h.index).toBe(0);
    expect(h.u).toBeCloseTo(1.3 / 4, 12);
    expect(h.point[0]).toBeCloseTo(1.3, 12);
    expect(h.distance).toBeCloseTo(0, 12);
    expect(h.rayT).toBeCloseTo(5, 12);
    // onto the second leg at z = 3, 0.5 m beside it: distance 0.5
    const g = closestOnPolylineToRay(poly, [4.5, 5, 3], [0, -1, 0])!;
    expect(g.index).toBe(1);
    expect(g.point[2]).toBeCloseTo(3, 12);
    expect(g.distance).toBeCloseTo(0.5, 12);
  });

  it('a ray that starts past the end of the line clamps to the end point', () => {
    const h = closestOnPolylineToRay(
      [
        [0, 0, 0],
        [2, 0, 0],
      ],
      [5, 3, 0],
      [0, -1, 0],
    )!;
    expect(h.u).toBe(1);
    expect(h.distance).toBeCloseTo(3, 12);
  });

  it('the angular tolerance cone accepts near misses and rejects far ones, scaled by distance', () => {
    const poly: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
    ];
    // 0.1 m beside the line seen from 10 m: atan(0.01) ~ 0.57 degrees
    expect(closestOnPolylineToRay(poly, [2, 10, 0.1], [0, -1, 0], 0.02)).not.toBeNull();
    expect(closestOnPolylineToRay(poly, [2, 10, 0.1], [0, -1, 0], 0.005)).toBeNull();
    // the same 0.1 m miss from 100 m away is a much smaller angle
    expect(closestOnPolylineToRay(poly, [2, 100, 0.1], [0, -1, 0], 0.005)).not.toBeNull();
  });

  it('maps a hit on the sampled curve to its control segment and parameter', () => {
    const s = spec(bend);
    const curve = new PathCurve(s);
    for (const t of [0.1, 0.37, 0.62, 0.9]) {
      const p = curve.positionAt(t);
      const h = closestOnCurveToRay(s, [p[0], p[1] + 8, p[2]], [0, -1, 0], undefined, 64)!;
      expect(h.distance).toBeLessThan(0.01);
      expect(h.segment).toBe(Math.min(3, Math.floor(t * 4)));
      expect(h.t).toBeCloseTo(t, 2);
      expect(vdist(h.point, p)).toBeLessThan(0.05);
    }
  });

  it('the last segment of a closed path inserts at the end', () => {
    const square: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 4],
      [0, 0, 4],
    ];
    const s = spec(square, true, 1); // tension 1: straight sides, so the closing side is the line z from 4 to 0 at x = 0
    const h = closestOnCurveToRay(s, [0, 5, 2], [0, -1, 0])!;
    expect(h.segment).toBe(3);
    const ins = insertPoint(square, h.segment, h.point);
    expect(ins.index).toBe(4);
    expect(ins.points).toHaveLength(5);
    expect(ins.points[4][2]).toBeCloseTo(2, 1);
  });
});

describe('insert / remove', () => {
  it('insertPoint puts the point after the segment and does not touch the input', () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [4, 0, 0],
    ];
    const r = insertPoint(pts, 0, [1, 0, 0]);
    expect(r.index).toBe(1);
    expect(r.points.map((p) => p[0])).toEqual([0, 1, 2, 4]);
    expect(pts).toHaveLength(3);
  });

  it('keeps two points on an open path and three on a closed one', () => {
    const two: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
    ];
    expect(removePoint(two, false, 0)).toBeNull();
    const three: Vec3[] = [...two, [2, 0, 0]];
    expect(removePoint(three, false, 1)).toHaveLength(2);
    expect(removePoint(three, true, 1)).toBeNull();
    expect(canRemovePoint(4, true)).toBe(true);
    expect(canRemovePoint(3, true)).toBe(false);
    expect(removePoint(three, false, 7)).toBeNull();
  });
});

describe('reverse', () => {
  it('evaluate(t) of the reversed open path equals evaluate(1 - t) of the original', () => {
    const a = new PathCurve(spec(bend));
    const b = new PathCurve(spec(reversePoints(bend, false)));
    for (const t of [0, 0.13, 0.5, 0.71, 1]) expect(vdist(b.positionAt(t), a.positionAt(1 - t))).toBeLessThan(1e-9);
    expect(b.length).toBeCloseTo(a.length, 9);
  });

  it('works for a closed loop too and keeps the first point as the start', () => {
    const loop: Vec3[] = [
      [0, 0, 0],
      [4, 0, 1],
      [5, 1, 5],
      [-1, 0, 4],
    ];
    const rev = reversePoints(loop, true);
    expect(rev[0]).toEqual(loop[0]);
    const a = new PathCurve(spec(loop, true, 0.3));
    const b = new PathCurve(spec(rev, true, 0.3));
    for (const t of [0.05, 0.25, 0.5, 0.8]) expect(vdist(b.positionAt(t), a.positionAt(1 - t))).toBeLessThan(1e-9);
  });

  it('reversing twice is the identity', () => {
    expect(reversePoints(reversePoints(bend, false), false)).toEqual(bend);
    expect(reversePoints(reversePoints(bend, true), true)).toEqual(bend);
  });
});

describe('resample / subdivide / simplify', () => {
  it('a straight 10 m line resampled to 6 points is spaced 2 m', () => {
    const line: Vec3[] = [
      [0, 0, 0],
      [3, 0, 0],
      [4, 0, 0],
      [10, 0, 0],
    ];
    const r = resample(spec(line), 6);
    expect(r).toHaveLength(6);
    for (let i = 0; i < 6; i++) expect(r[i][0]).toBeCloseTo(2 * i, 3); // the arc-length table interpolates within a chord
    for (const p of r) {
      expect(p[1]).toBeCloseTo(0, 9);
      expect(p[2]).toBeCloseTo(0, 9);
    }
  });

  it('a closed circle resampled to 8 points has equal chords and stays on the circle', () => {
    const R = 5;
    const ring: Vec3[] = Array.from({ length: 12 }, (_, i) => [
      R * Math.cos((2 * Math.PI * i) / 12),
      0,
      R * Math.sin((2 * Math.PI * i) / 12),
    ]);
    const r = resample(spec(ring, true), 8);
    expect(r).toHaveLength(8);
    const chords = r.map((p, i) => vdist(p, r[(i + 1) % 8]));
    for (const c of chords) expect(c).toBeCloseTo(chords[0], 1);
    for (const p of r) expect(Math.hypot(p[0], p[2])).toBeCloseTo(R, 1);
  });

  it('subdivide adds one point per segment, on the original curve', () => {
    const s = spec(bend);
    const sub = subdivide(s)!;
    expect(sub).toHaveLength(bend.length + 4);
    const curve = new PathCurve(s);
    for (let i = 0; i < 4; i++) expect(vdist(sub[2 * i + 1], curve.positionAt((i + 0.5) / 4))).toBeLessThan(1e-12);
    for (let i = 0; i < 5; i++) expect(sub[i === 4 ? 8 : 2 * i]).toEqual(bend[i]);
    // a closed path gets a point on the closing segment as well
    expect(subdivide(spec(bend, true))).toHaveLength(10);
  });

  it('refuses to exceed the point limit', () => {
    const many = Array.from({ length: LIMITS.maxPathPoints }, (_, i) => [i, 0, 0] as Vec3);
    expect(subdivide(spec(many))).toBeNull();
    expect(resample(spec(bend), LIMITS.maxPathPoints + 500)).toHaveLength(LIMITS.maxPathPoints);
  });

  it('RDP removes collinear points and keeps a real corner', () => {
    const pts: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0.001, 0],
      [3, 0, 0],
      [3, 0, 3],
      [3, 0, 4],
    ];
    const out = simplify(pts, false, 0.01);
    expect(out).toEqual([
      [0, 0, 0],
      [3, 0, 0],
      [3, 0, 4],
    ]);
    // a tolerance below the deviation keeps the bump
    expect(simplify(pts, false, 0.0001).some((p) => p[1] === 0.001)).toBe(true);
  });

  it('RDP on a closed square with midpoints leaves the four corners', () => {
    const sq: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [4, 0, 0],
      [4, 0, 2],
      [4, 0, 4],
      [2, 0, 4],
      [0, 0, 4],
      [0, 0, 2],
    ];
    const out = simplify(sq, true, 0.01);
    expect(out).toHaveLength(4);
    expect(out).toContainEqual([0, 0, 0]);
    expect(out).toContainEqual([4, 0, 4]);
    expect(out).not.toContainEqual([2, 0, 0]);
  });

  it('never drops below the minimum', () => {
    const tri: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ];
    expect(simplify(tri, true, 10)).toHaveLength(3);
    expect(simplify(tri, false, 10)).toHaveLength(2);
  });
});

describe('world-space edits', () => {
  it('flatten puts every point at the same world height, whatever the path pose', () => {
    const pose = { position: [1, 2, 3] as Vec3, rotation: qfromAxisAngle([0, 0, 1], 0.5) };
    const local: Vec3[] = [
      [0, 0, 0],
      [2, 1, 0],
      [4, -1, 2],
    ];
    const flat = flatten(local, pose, 0.05);
    const curve = new PathCurve({ points: flat, closed: false, tension: 0 });
    expect(curve.length).toBeGreaterThan(0);
    for (const p of flat) {
      const w = [0, 0, 0] as Vec3;
      // forward transform: rotate about z by 0.5 rad, then translate
      const c = Math.cos(0.5);
      const s = Math.sin(0.5);
      w[0] = pose.position[0] + c * p[0] - s * p[1];
      w[1] = pose.position[1] + s * p[0] + c * p[1];
      w[2] = pose.position[2] + p[2];
      expect(w[1]).toBeCloseTo(0.05, 9);
    }
  });

  it('snap to grid rounds world coordinates (axes selectable)', () => {
    expect(snapToGrid([1.3, 0.27, -0.9], 0.5)).toEqual([1.5, 0.27, -1]);
    expect(snapToGrid([1.3, 0.27, -0.9], 0.5, { y: true, x: false })).toEqual([1.3, 0.5, -1]);
    expect(snapToGrid([0.1, 0, -0.1], 1)[2]).toBe(0);
    const pose = { position: [0.2, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as [number, number, number, number] };
    const out = snapPointsToGrid([[0.9, 0.2, 0]], pose, 0.5);
    expect(out[0][0]).toBeCloseTo(0.8, 12); // world x = 1.1 -> 1.0 -> local 0.8
    expect(out[0][1]).toBeCloseTo(0, 12);
  });

  it('pointsThrough keeps order, collapses repeats and needs two distinct positions', () => {
    expect(pointsThrough([[0, 0, 0]])).toBeNull();
    expect(
      pointsThrough([
        [0, 0, 0],
        [0, 0, 0],
      ]),
    ).toBeNull();
    expect(
      pointsThrough([
        [0, 0, 0],
        [0, 0, 0],
        [1, 2, 3],
        [4, 0, 0],
      ]),
    ).toEqual([
      [0, 0, 0],
      [1, 2, 3],
      [4, 0, 0],
    ]);
  });
});

describe('a component that follows a path keeps its reference through path edits', () => {
  registerComponent({
    type: 'edPathFollower',
    label: 'Path follower (test)',
    icon: 'component',
    category: 'Tests',
    blurb: 'references a path',
    appliesTo: 'body',
    fields: [{ kind: 'path', key: 'route', label: 'Route', default: '' }],
  });

  const setup = () => {
    const path = createPath({ points: bend.map((p) => [...p] as Vec3) });
    const owner = createBody({
      name: 'Cart',
      shape: { type: 'box' },
      components: [makeComponent('edPathFollower', { route: path.id })],
    });
    const store = new SceneStore();
    store.add([path, owner]);
    const route = () => (store.body(owner.id) as BodyEntity).components[0].params.route;
    return { path, owner, store, route };
  };

  it('editing, reversing, respacing and subdividing the path (same id) leave the reference alone', () => {
    const { path, store, route } = setup();
    store.update(path.id, { points: reversePoints(path.points, false) }, 'Reverse path');
    expect(route()).toBe(path.id);
    store.update(path.id, { points: resample(store.path(path.id)!, 9) }, 'Respace');
    expect(route()).toBe(path.id);
    expect(store.path(path.id)!.points).toHaveLength(9);
    store.update(path.id, { points: subdivide(store.path(path.id)!)! }, 'Subdivide');
    expect(route()).toBe(path.id);
    expect(store.path(path.id)!.id).toBe(path.id);
  });

  it('deleting the path clears the reference in the same undo step, and undo restores it', () => {
    const { path, store, route } = setup();
    store.remove([path.id]);
    expect(route()).toBe('');
    store.undo();
    expect(route()).toBe(path.id);
    expect(store.path(path.id)).toBeDefined();
  });
});

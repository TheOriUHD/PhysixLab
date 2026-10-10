import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, type Quat, type Vec3 } from '../src/core/math';
import {
  boundsPoints,
  candidatesOf,
  chooseSnap,
  convexHull,
  gapAboveSurface,
  handlesOf,
  resolveFeatureSnap,
  shapeFeatures,
  snapToGrid,
  supportAlong,
  surfacePlacement,
  worldHalfExtents,
  type Projector,
  type SnapObject,
  type SupportShape,
} from '../src/model/edit/snap';
import { shapeConvexPoints } from '../src/model/shapeRegistry';
import { createBody } from '../src/model/factory';

const ID: Quat = [0, 0, 0, 1];
const boxPts = (sx: number, sy: number, sz: number): Vec3[] => {
  const out: Vec3[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1]) for (const z of [-1, 1]) out.push([(x * sx) / 2, (y * sy) / 2, (z * sz) / 2]);
  return out;
};
const boxShape = (sx: number, sy: number, sz: number): SupportShape => ({ k: 'points', pts: boxPts(sx, sy, sz) });
const obj = (id: string, shape: SupportShape, position: Vec3, rotation: Quat = ID): SnapObject => ({
  id,
  position,
  rotation,
  shape: shapeFeatures(shape),
});
/** Oblique orthographic view: 100 px per metre, y shifts the screen position so heights are distinguishable. */
const topDown: Projector = (p, out) => {
  out[0] = p[0] * 100 + p[1] * 40;
  out[1] = p[2] * 100 - p[1] * 40;
  return true;
};
/** Coarse view: 10 px per metre. */
const coarse: Projector = (p, out) => {
  out[0] = p[0] * 10 + p[1] * 4;
  out[1] = p[2] * 10 - p[1] * 4;
  return true;
};
const MODES = { vertex: true, edge: true, face: true, bounds: true };
const only = (k: keyof typeof MODES) => ({ vertex: false, edge: false, face: false, bounds: false, [k]: true });

describe('convex hull of a point set', () => {
  it('recovers 6 faces, 12 edges and 8 vertices of a box, with outward unit normals', () => {
    const h = convexHull(boxPts(2, 1, 3));
    expect(h.points).toHaveLength(8);
    expect(h.faces).toHaveLength(6);
    expect(h.edges).toHaveLength(12);
    for (const f of h.faces) {
      expect(f.loop).toHaveLength(4);
      expect(Math.hypot(...f.normal)).toBeCloseTo(1, 12);
      // outward: the face plane lies on the positive side of the centroid (the origin)
      expect(
        f.normal[0] * h.points[f.loop[0]][0] +
          f.normal[1] * h.points[f.loop[0]][1] +
          f.normal[2] * h.points[f.loop[0]][2],
      ).toBeGreaterThan(0);
    }
  });
  it('Euler: V - E + F = 2 for the real wedge, prism and icosahedron shapes', () => {
    for (const type of ['wedge', 'prism', 'icosahedron']) {
      const pts = shapeConvexPoints(createBody({ shape: { type } }).shape)!;
      const h = convexHull(pts);
      expect(h.points.length - h.edges.length + h.faces.length, type).toBe(2);
    }
    // wedge: 2 triangles + 3 quads
    const w = convexHull(shapeConvexPoints(createBody({ shape: { type: 'wedge' } }).shape)!);
    expect(w.faces.map((f) => f.loop.length).sort()).toEqual([3, 3, 4, 4, 4]);
    // icosahedron: 20 triangles
    const ico = convexHull(shapeConvexPoints(createBody({ shape: { type: 'icosahedron' } }).shape)!);
    expect(ico.faces).toHaveLength(20);
  });
});

describe('shape features', () => {
  it('a 2x2x2 box has face centres on the axes and edge midpoints at (±1,±1,0) style positions', () => {
    const f = shapeFeatures(boxShape(2, 2, 2));
    expect(f.faceCentres).toHaveLength(6);
    for (const c of f.faceCentres) expect(c.filter((v) => Math.abs(v) < 1e-12)).toHaveLength(2);
    expect(f.edgeMids).toHaveLength(12);
    for (const m of f.edgeMids) {
      expect(m.filter((v) => Math.abs(v) < 1e-12)).toHaveLength(1);
      expect(m.filter((v) => Math.abs(Math.abs(v) - 1) < 1e-12)).toHaveLength(2);
    }
  });
  it('non-hull shapes offer only honest features', () => {
    const sphere = shapeFeatures({ k: 'ellipsoid', r: [0.5, 0.5, 0.5] });
    expect(sphere.vertices).toHaveLength(6);
    expect(sphere.edgeMids).toHaveLength(0);
    expect(sphere.faceCentres).toHaveLength(0);
    const cyl = shapeFeatures({ k: 'cylinder', r: 0.4, h: 0.5 });
    expect(cyl.faceCentres).toEqual([
      [0, 0.5, 0],
      [0, -0.5, 0],
    ]);
    expect(cyl.vertices).toHaveLength(0);
    const cone = shapeFeatures({ k: 'cone', r: 0.45, h: 0.6 });
    expect(cone.vertices).toEqual([[0, 0.6, 0]]);
    expect(cone.faceCentres).toEqual([[0, -0.6, 0]]);
    const cap = shapeFeatures({ k: 'capsule', r: 0.3, h: 0.4 });
    expect(cap.vertices).toEqual([
      [0, 0.7, 0],
      [0, -0.7, 0],
    ]);
  });
  it('posed candidates are in world space', () => {
    const o = obj('a', boxShape(1, 1, 1), [10, 0, 0], qfromAxisAngle([0, 1, 0], Math.PI / 2));
    const c = candidatesOf(o, only('face'));
    expect(c).toHaveLength(6);
    // the +X face of the unrotated box lands on -Z after a 90° turn about Y
    expect(c.some((p) => Math.abs(p.point[0] - 10) < 1e-9 && Math.abs(p.point[2] + 0.5) < 1e-9)).toBe(true);
  });
  it('bounds: 8 corners, 6 face centres and the centre of the axis-aligned box', () => {
    const o = obj('a', boxShape(2, 2, 2), [0, 0, 0], qfromAxisAngle([0, 1, 0], Math.PI / 4));
    const pts = boundsPoints(o);
    expect(pts).toHaveLength(15);
    const h = Math.SQRT2; // a 2-cube turned 45° spans ±√2 in x and z
    expect(worldHalfExtents(o.shape.support, o.rotation)[0]).toBeCloseTo(h, 12);
    expect(pts.some((p) => Math.abs(p[0] - h) < 1e-9 && Math.abs(p[1] - 1) < 1e-9 && Math.abs(p[2] - h) < 1e-9)).toBe(
      true,
    );
  });
});

describe('support function', () => {
  it('matches the analytic extent of a rotated box, sphere, cylinder, capsule and cone', () => {
    const q = qfromAxisAngle([0, 0, 1], Math.PI / 6);
    // box 1 wide, turned 30° about Z: half height = 0.5 (cos30 + sin30)
    expect(supportAlong(boxShape(1, 1, 1), q, [0, 1, 0])).toBeCloseTo(
      0.5 * (Math.cos(Math.PI / 6) + Math.sin(Math.PI / 6)),
      12,
    );
    expect(supportAlong({ k: 'ellipsoid', r: [0.5, 0.5, 0.5] }, q, [0.3, 0.8, 0.1])).toBeCloseTo(
      0.5 * Math.hypot(0.3, 0.8, 0.1),
      12,
    );
    // cylinder lying on its side (axis turned 90°) rests on its rim: support along -Y is r
    expect(
      supportAlong({ k: 'cylinder', r: 0.4, h: 0.5 }, qfromAxisAngle([1, 0, 0], Math.PI / 2), [0, -1, 0]),
    ).toBeCloseTo(0.4, 12);
    expect(supportAlong({ k: 'capsule', r: 0.3, h: 0.4 }, ID, [0, -1, 0])).toBeCloseTo(0.7, 12);
    expect(supportAlong({ k: 'cone', r: 0.45, h: 0.6 }, ID, [0, 1, 0])).toBeCloseTo(0.6, 12);
    expect(supportAlong({ k: 'cone', r: 0.45, h: 0.6 }, ID, [1, 0, 0])).toBeCloseTo(0.45, 12);
    // cone standing on its base: the base is the lowest thing
    expect(supportAlong({ k: 'cone', r: 0.45, h: 0.6 }, ID, [0, -1, 0])).toBeCloseTo(0.6, 12);
  });
});

describe('feature snapping', () => {
  const target = obj('t', boxShape(1, 1, 1), [0, 0, 0]);
  it('a dragged box vertex within the radius snaps exactly onto a vertex of the target', () => {
    // a unit box whose (-,-,-) corner is 0.07 m (7 px) from the target's corner (0.5, 0.5, 0.5)
    const mover = obj('m', boxShape(1, 1, 1), [1.07, 1.0, 1.0]);
    const hit = resolveFeatureSnap({
      moving: [mover],
      others: [target],
      modes: only('vertex'),
      project: topDown,
      radiusPx: 12,
      worldReach: 1,
    });
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('vertex');
    expect(hit!.delta[0]).toBeCloseTo(-0.07, 12);
    expect(hit!.delta[1]).toBeCloseTo(0, 12);
    expect(hit!.delta[2]).toBeCloseTo(0, 12);
    expect(hit!.point).toEqual([0.5, 0.5, 0.5]);
    expect(hit!.owner).toBe('t');
    expect(hit!.distancePx).toBeCloseTo(7, 9);
  });
  it('nothing snaps outside the radius', () => {
    const mover = obj('m', boxShape(1, 1, 1), [1.3, 0.5, 0.5]);
    expect(
      resolveFeatureSnap({
        moving: [mover],
        others: [target],
        modes: only('vertex'),
        project: topDown,
        radiusPx: 12,
        worldReach: 1,
      }),
    ).toBeNull();
  });
  it('edge midpoints: a point-like dragged object finds the midpoint of the target edge', () => {
    // the target edge from (-0.5,0.5,0.5) to (0.5,0.5,0.5) has its midpoint at (0, 0.5, 0.5)
    const mover = obj('m', boxShape(0.001, 0.001, 0.001), [0.02, 0.5, 0.52]);
    const hit = resolveFeatureSnap({
      moving: [mover],
      others: [target],
      modes: only('edge'),
      project: topDown,
      radiusPx: 6,
      worldReach: 1,
    });
    expect(hit!.kind).toBe('edge');
    expect(hit!.point).toEqual([0, 0.5, 0.5]);
    expect(hit!.delta[0]).toBeCloseTo(-0.02, 2);
    expect(hit!.delta[2]).toBeCloseTo(-0.02, 2);
  });
  it('face centres', () => {
    const mover = obj('m', boxShape(0.001, 0.001, 0.001), [0.03, 0.5, 0.02]);
    const hit = resolveFeatureSnap({
      moving: [mover],
      others: [target],
      modes: only('face'),
      project: topDown,
      radiusPx: 8,
      worldReach: 1,
    });
    expect(hit!.kind).toBe('face');
    expect(hit!.point).toEqual([0, 0.5, 0]); // the top face centre
  });
  it('bounds use the axis-aligned box, so a rotated object offers its bounding corners', () => {
    const rotated = obj('r', boxShape(1, 1, 1), [0, 0, 0], qfromAxisAngle([0, 1, 0], Math.PI / 4));
    const mover = obj('m', boxShape(0.001, 0.001, 0.001), [0.74, 0.5, 0.73]);
    const hit = resolveFeatureSnap({
      moving: [mover],
      others: [rotated],
      modes: only('bounds'),
      project: topDown,
      radiusPx: 10,
      worldReach: 1,
    });
    expect(hit!.kind).toBe('bounds');
    const h = 0.5 * Math.SQRT2;
    expect(hit!.point[0]).toBeCloseTo(h, 12);
    expect(hit!.point[1]).toBeCloseTo(0.5, 12);
    expect(hit!.point[2]).toBeCloseTo(h, 12);
  });
  it('kind priority: a vertex wins over an edge midpoint that is slightly closer, a clearly closer edge wins', () => {
    // the vertex (0.5,0.5,0.5) and the edge midpoint (0.5,0.5,0) are 5 px apart on the coarse view
    const run = (z: number) =>
      resolveFeatureSnap({
        moving: [obj('m', boxShape(0.001, 0.001, 0.001), [0.5, 0.5, z])],
        others: [target],
        modes: MODES,
        project: coarse,
        radiusPx: 12,
        worldReach: 2,
      })!;
    expect(run(0.15).kind).toBe('vertex'); // 3.5 px to the vertex, 1.5 px to the edge but +2.5 px bias
    expect(run(0.1).kind).toBe('edge');
  });
  it('excludes the dragged objects themselves, even when listed among the others', () => {
    const self = obj('m', boxShape(1, 1, 1), [0.01, 0, 0]);
    expect(
      resolveFeatureSnap({
        moving: [self],
        others: [self],
        modes: MODES,
        project: topDown,
        radiusPx: 50,
        worldReach: 5,
      }),
    ).toBeNull();
  });
  it('skips far objects (world prefilter) and points behind the camera', () => {
    const far = obj('f', boxShape(1, 1, 1), [50, 0, 0]);
    const mover = obj('m', boxShape(1, 1, 1), [50.5, 0, 0]);
    expect(
      resolveFeatureSnap({
        moving: [mover],
        others: [far, target],
        modes: MODES,
        project: topDown,
        radiusPx: 12,
        worldReach: 1,
      }),
    ).not.toBeNull();
    const none: Projector = () => false;
    expect(
      resolveFeatureSnap({ moving: [mover], others: [far], modes: MODES, project: none, radiusPx: 12, worldReach: 1 }),
    ).toBeNull();
    expect(
      resolveFeatureSnap({
        moving: [mover],
        others: [target],
        modes: MODES,
        project: topDown,
        radiusPx: 12,
        worldReach: 1,
      }),
    ).toBeNull();
  });
  it('is off when no kind is enabled', () => {
    const mover = obj('m', boxShape(1, 1, 1), [1, 0, 0]);
    expect(
      resolveFeatureSnap({
        moving: [mover],
        others: [target],
        modes: { vertex: false, edge: false, face: false, bounds: false },
        project: topDown,
        radiusPx: 99,
        worldReach: 9,
      }),
    ).toBeNull();
  });
  it('handles of a posed object are its vertices and its centre', () => {
    const o = obj('a', boxShape(1, 1, 1), [1, 2, 3]);
    expect(handlesOf(o)).toHaveLength(9);
    expect(handlesOf(o)[0]).toEqual([1, 2, 3]);
  });
});

describe('surface snapping', () => {
  const slopeAngle = Math.PI / 6; // 30°
  const normal: Vec3 = [-Math.sin(slopeAngle), Math.cos(slopeAngle), 0];
  const hitPoint: Vec3 = [2, 1, 0];

  it('a box aligned to a 30° slope rests exactly flush: its lowest point along the normal is on the surface', () => {
    const shape = boxShape(1, 1, 1);
    const place = surfacePlacement(shape, ID, hitPoint, normal, true);
    // support distance zero: nothing below the plane, and the centre sits half a box above it
    expect(gapAboveSurface(shape, place.position, place.rotation, hitPoint, normal)).toBeCloseTo(0, 12);
    const centreHeight =
      (place.position[0] - 2) * normal[0] + (place.position[1] - 1) * normal[1] + place.position[2] * normal[2];
    expect(centreHeight).toBeCloseTo(0.5, 12);
    // up axis equals the surface normal
    const up = qrot(place.rotation, [0, 1, 0]);
    expect(up[0]).toBeCloseTo(normal[0], 12);
    expect(up[1]).toBeCloseTo(normal[1], 12);
    expect(up[2]).toBeCloseTo(normal[2], 12);
    // and every box vertex is at or above the plane (no penetration)
    for (const p of boxPts(1, 1, 1)) {
      const w = qrot(place.rotation, p);
      const d =
        (place.position[0] + w[0] - 2) * normal[0] +
        (place.position[1] + w[1] - 1) * normal[1] +
        (place.position[2] + w[2]) * normal[2];
      expect(d).toBeGreaterThan(-1e-12);
    }
  });
  it('without alignment the box keeps its rotation and its lowest corner touches the slope', () => {
    const shape = boxShape(1, 1, 1);
    const place = surfacePlacement(shape, ID, hitPoint, normal, false);
    expect(place.rotation).toEqual(ID);
    expect(gapAboveSurface(shape, place.position, place.rotation, hitPoint, normal)).toBeCloseTo(0, 12);
    // an unrotated cube on a 30° slope is held up by its corner: centre height = 0.5 (sin30 + cos30)
    const centreHeight = (place.position[0] - 2) * normal[0] + (place.position[1] - 1) * normal[1];
    expect(centreHeight).toBeCloseTo(0.5 * (Math.sin(slopeAngle) + Math.cos(slopeAngle)), 12);
  });
  it('a sphere rests one radius along the normal from the hit point', () => {
    const shape: SupportShape = { k: 'ellipsoid', r: [0.3, 0.3, 0.3] };
    const place = surfacePlacement(shape, ID, hitPoint, normal, true);
    expect(place.position[0]).toBeCloseTo(2 + 0.3 * normal[0], 12);
    expect(place.position[1]).toBeCloseTo(1 + 0.3 * normal[1], 12);
    expect(gapAboveSurface(shape, place.position, place.rotation, hitPoint, normal)).toBeCloseTo(0, 12);
  });
  it('a ceiling (normal pointing down) turns the object upside down and still touches', () => {
    const shape: SupportShape = { k: 'cone', r: 0.4, h: 0.5 };
    const n: Vec3 = [0, -1, 0];
    const place = surfacePlacement(shape, ID, [0, 3, 0], n, true);
    const up = qrot(place.rotation, [0, 1, 0]);
    expect(up[1]).toBeCloseTo(-1, 12);
    expect(place.position[1]).toBeCloseTo(3 - 0.5, 12);
  });
  it('clearance adds an air gap', () => {
    const shape = boxShape(1, 1, 1);
    const place = surfacePlacement(shape, ID, [0, 0, 0], [0, 1, 0], true, 0.01);
    expect(gapAboveSurface(shape, place.position, place.rotation, [0, 0, 0], [0, 1, 0])).toBeCloseTo(0.01, 12);
  });
  it('normalises a non-unit normal', () => {
    const shape = boxShape(2, 2, 2);
    const a = surfacePlacement(shape, ID, [0, 0, 0], [0, 5, 0], true);
    expect(a.position[1]).toBeCloseTo(1, 12);
  });
});

describe('grid and priority', () => {
  it('snaps to the nearest grid line', () => {
    expect(snapToGrid(0.37, 0.25)).toBeCloseTo(0.25, 12);
    expect(snapToGrid(0.38, 0.25)).toBeCloseTo(0.5, 12);
    expect(snapToGrid(-0.6, 0.5)).toBeCloseTo(-0.5, 12);
    expect(snapToGrid(0.37, 0)).toBe(0.37);
  });
  it('chooseSnap takes the highest priority kind', () => {
    const mk = (kind: 'grid' | 'surface' | 'edge'): Parameters<typeof chooseSnap>[0][number] => ({
      kind,
      delta: [0, 0, 0],
      point: [0, 0, 0],
      distancePx: 0,
    });
    expect(chooseSnap([mk('grid'), mk('surface'), null])!.kind).toBe('surface');
    expect(chooseSnap([mk('grid'), mk('edge'), mk('surface')])!.kind).toBe('edge');
    expect(chooseSnap([null, null])).toBeNull();
  });
});

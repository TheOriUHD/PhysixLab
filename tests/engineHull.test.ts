/**
 * Package SH, chunk 2 — the engine's hull builder and the `robustHull` that feeds it.
 *
 * Measured while building the rounded shapes: when a hull has a vertex within about 0.25 % of its diameter of the
 * plane of a face it is not on, the engine's builder treats it as coplanar and then merges or drops faces — the
 * integrated mass of a rounded cylinder came out up to 30 % off, of a thin lens up to 95 % off, and which cases fail
 * looks random. `robustHull` (src/model/shapes/hull3.ts) removes such vertices so the polyhedron the model computes
 * the volume of, draws, and hands to the engine is one the engine reproduces. These tests pin the behaviour:
 * the clearance rule itself, and the engine's mass against `density × volume()` over dense parameter grids of every
 * shape built on it.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { makeShapeSpec, shapeColliders, shapeVolume } from '../src/model/shapeRegistry';
import { bevelPlan, maxBevelSteps } from '../src/model/shapes/bevel';
import { convexHull3, crowdedVertices, ENGINE_CLEARANCE, firstSafeHull, hullDiameter } from '../src/model/shapes/hull3';
import { initRapier } from '../src/physics/world';

beforeAll(async () => {
  await initRapier();
});

function massOfSpec(type: string, size: Vec3, params: Record<string, number | string | boolean>): number {
  const spec = makeShapeSpec(type, size, params);
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  for (const c of shapeColliders(RAPIER, spec)) world.createCollider(c.desc.setDensity(1000), rb);
  const m = rb.mass();
  world.free();
  return m;
}

/** A disc of radius 1 and thickness 0.2 (diameter ≈ 2) with a chamfer of width `c` on both rims. */
function discWithChamfer(c: number): Vec3[] {
  const pts: Vec3[] = [];
  const ring = (r: number, y: number) => {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      pts.push([r * Math.cos(a), y, r * Math.sin(a)]);
    }
  };
  ring(1 - c, -0.1);
  ring(1, -0.1 + c);
  ring(1, 0.1 - c);
  ring(1 - c, 0.1);
  return pts;
}

describe('crowded vertices and firstSafeHull', () => {
  it('a well-conditioned hull has none', () => {
    const pts: Vec3[] = [];
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      pts.push([Math.cos(a), -0.5, Math.sin(a)], [Math.cos(a), 0.5, Math.sin(a)]);
    }
    expect(crowdedVertices(convexHull3(pts)!).size).toBe(0);
  });

  it('a chamfer narrower than 0.3 % of the size is reported, a 2.5 % one is not', () => {
    expect(crowdedVertices(convexHull3(discWithChamfer(0.001))!).size).toBeGreaterThan(0);
    expect(crowdedVertices(convexHull3(discWithChamfer(0.05))!).size).toBe(0);
  });

  it('picks the first candidate that is crowd-free, in the order given', () => {
    const found = firstSafeHull([
      () => discWithChamfer(0.001),
      () => discWithChamfer(0.05),
      () => discWithChamfer(0.02),
    ])!;
    expect(found.index).toBe(1);
    // none qualifies: the last usable candidate
    expect(firstSafeHull([() => discWithChamfer(0.001), () => discWithChamfer(0.002)])!.index).toBe(1);
    expect(firstSafeHull([() => [[0, 0, 0]]])).toBeNull();
  });

  it('the tolerance is 0.3 % of the bounding-box diagonal, with the 64-gon prism still inside it', () => {
    expect(ENGINE_CLEARANCE).toBeCloseTo(0.003, 6);
    const pts: Vec3[] = [];
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      pts.push([Math.cos(a), -0.3, Math.sin(a)], [Math.cos(a), 0.3, Math.sin(a)]);
    }
    const h = convexHull3(pts)!;
    expect(hullDiameter(h)).toBeGreaterThan(1.99);
    expect(crowdedVertices(h).size).toBe(0);
  });

  it('bevelPlan: fine radii get fewer facets, then a chamfer, then none', () => {
    const D = 1.4;
    expect(maxBevelSteps(0.2, D)).toBe(7);
    expect(maxBevelSteps(0.03, D)).toBeGreaterThanOrEqual(2);
    expect(maxBevelSteps(0.03, D)).toBeLessThan(8);
    expect(maxBevelSteps(0.0052, D)).toBe(1);
    expect(maxBevelSteps(0.004, D)).toBe(0);
    expect(bevelPlan(0.2, 4, D, false).map((p) => p.steps)).toEqual([4, 3, 2, 1, 1]);
    expect(bevelPlan(0.2, 4, D, false).at(-1)).toEqual({ rim: 0, steps: 1 }); // the sharp shape is the last resort
    expect(bevelPlan(0.2, 8, D, true)).toEqual([
      { rim: 0.2, steps: 1 },
      { rim: 0, steps: 1 },
    ]);
    expect(bevelPlan(0.001, D, D, false)).toEqual([{ rim: 0, steps: 1 }]);
  });
});

describe('the engine reproduces the hulls of the rounded shapes (mass = density × volume)', () => {
  const SIZES: Vec3[] = [
    [1, 1, 1],
    [0.8, 0.6, 0.8],
    [2, 0.3, 2],
    [0.5, 2, 0.5],
    [3, 3, 3],
    [1.5, 1, 1.5],
    [0.3, 0.3, 0.3],
    [5, 1, 4],
  ];

  it('rounded cylinder, over radius × style × steps × segments × size', () => {
    let worst = 0,
      cases = 0;
    for (const size of SIZES)
      for (const roundness of [0.03, 0.1, 0.25, 0.6, 1])
        for (const [bevel, steps] of [
          ['round', 2],
          ['round', 4],
          ['round', 6],
          ['round', 8],
          ['chamfer', 4],
        ] as const)
          for (const segments of [8, 20, 32, 48]) {
            const params = { roundness, bevel, steps, segments };
            const want = shapeVolume(makeShapeSpec('rounded-cylinder', size, params)) * 1000;
            const got = massOfSpec('rounded-cylinder', size, params);
            const err = Math.abs(got - want) / want;
            worst = Math.max(worst, err);
            cases++;
            expect(err, `${size.join('×')} ${JSON.stringify(params)}: ${got} vs ${want}`).toBeLessThan(2e-3);
          }
    process.stderr.write(`rounded cylinder: ${cases} cases, worst engine error ${(worst * 100).toFixed(3)} %\n`);
  });

  it('rounded box, over radius × style × steps × size', () => {
    let worst = 0,
      cases = 0;
    for (const size of SIZES)
      for (const roundness of [0.03, 0.1, 0.25, 0.6, 1])
        for (const [bevel, steps] of [
          ['round', 2],
          ['round', 4],
          ['round', 6],
          ['round', 8],
          ['chamfer', 4],
        ] as const) {
          const params = { roundness, bevel, steps };
          const want = shapeVolume(makeShapeSpec('rounded-box', size, params)) * 1000;
          const got = massOfSpec('rounded-box', size, params);
          const err = Math.abs(got - want) / want;
          worst = Math.max(worst, err);
          cases++;
          expect(err, `${size.join('×')} ${JSON.stringify(params)}: ${got} vs ${want}`).toBeLessThan(2e-3);
        }
    process.stderr.write(`rounded box: ${cases} cases, worst engine error ${(worst * 100).toFixed(3)} %\n`);
  });

  it('ellipsoid, over detail × size', () => {
    let worst = 0,
      cases = 0;
    for (const detail of [4, 6, 8, 10, 12])
      for (const size of [...SIZES, [4, 1, 4], [4, 0.5, 4], [2, 0.2, 2], [6, 0.4, 6]] as Vec3[]) {
        const spec = makeShapeSpec('ellipsoid', size, { detail });
        const want = shapeVolume(spec) * 1000;
        const got = massOfSpec('ellipsoid', spec.size, { detail });
        const err = Math.abs(got - want) / want;
        worst = Math.max(worst, err);
        cases++;
        expect(err, `${spec.size.join('×')} detail ${detail}: ${got} vs ${want}`).toBeLessThan(2e-3);
      }
    process.stderr.write(`ellipsoid: ${cases} cases, worst engine error ${(worst * 100).toFixed(3)} %\n`);
  });
});

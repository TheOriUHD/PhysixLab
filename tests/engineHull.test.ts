/**
 * Package SH, chunk 2 — what the engine's hull builder can and cannot reproduce, and the rules that keep the new
 * shapes inside what it can.
 *
 * Found while building the rounded shapes and the ramps (and measured here, not assumed): the engine's convex-hull
 * builder merges neighbouring faces whose normals differ by under about 1.35° and drops vertices that sit within about
 * 0.1 % of a face plane. On a fine triangle mesh that is harmless, but on polygonal faces it can collapse a shape — the
 * integrated mass of a rounded cylinder came out 30 % off, of a thin slab 31 % or 100 % off, and sometimes the builder
 * produced no shape at all. `isEngineSafe` (src/model/shapes/hull3.ts) is the rule the shape definitions apply to
 * every hull they hand over: this file checks the rule against the real engine on a corpus of thousands of hulls
 * (safe ⇒ the engine's mass equals the analytic volume), shows that the rule is not vacuous (hulls it rejects really
 * do go wrong), and runs the shapes built on it over dense parameter grids.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { makeShapeSpec, shapeVolume } from '../src/model/shapeRegistry';
import { bevelPlan, maxBevelSteps, sidesLadder } from '../src/model/shapes/bevel';
import {
  convexHull3,
  crowdedVertices,
  ENGINE_CLEARANCE,
  ENGINE_MIN_DIHEDRAL,
  firstSafeHull,
  hullVolume,
  isEngineSafe,
  minPolygonDihedral,
  type Hull,
} from '../src/model/shapes/hull3';
import { pipeTop, profilePieces, rampTop } from '../src/model/shapes/profileSolid';
import { revolvedPoints } from '../src/model/shapes/revolve';
import { roundedBoxPoints } from '../src/model/shapes/roundedBox';
import { roundedCylinderProfile } from '../src/model/shapes/roundedCylinder';
import { initRapier } from '../src/physics/world';
import { engineMass } from './shapeTestKit';

beforeAll(async () => {
  await initRapier();
});

/** The engine's integrated mass of one convex collider built from `pts` (NaN when the engine builds no shape). */
function hullMass(pts: readonly Vec3[]): number {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  try {
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts.flat()));
    if (!desc) return NaN;
    world.createCollider(desc.setDensity(1000), rb);
    return rb.mass();
  } catch {
    return NaN;
  } finally {
    world.free();
  }
}

/** A disc of radius 1 and thickness 0.2 with a chamfer of width `c` on both rims. */
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

/** A slab x ∈ [0, w], y ∈ [0, h] (the top edge drops by `drop` toward +x), z ∈ ±d/2. */
function slab(w: number, h: number, d: number, drop: number): Vec3[] {
  const pts: Vec3[] = [];
  for (const z of [-d / 2, d / 2]) pts.push([0, 0, z], [w, 0, z], [0, h, z], [w, h - drop, z]);
  return pts;
}

describe('the rule: crowded vertices, polygonal dihedral angles, firstSafeHull', () => {
  it('constants', () => {
    expect(ENGINE_MIN_DIHEDRAL).toBe(2.5);
    expect(ENGINE_CLEARANCE).toBeCloseTo(0.0015, 8);
  });

  it('a cube: every neighbouring pair of faces meets at 90°, none is crowded', () => {
    const cube: Vec3[] = [];
    for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) cube.push([x, y, z]);
    const h = convexHull3(cube)!;
    expect(minPolygonDihedral(h)).toBeCloseTo(90, 6);
    expect(crowdedVertices(h).size).toBe(0);
    expect(isEngineSafe(h)).toBe(true);
  });

  it('a slab whose top face is almost parallel to its side is unsafe; the engine really gets it wrong', () => {
    // 6 mm wide, 0.3 m drop: the top face leaves the side at 1.15°
    const thin = convexHull3(slab(0.006, 2, 0.9, 0.3))!;
    expect(minPolygonDihedral(thin)).toBeLessThan(1.3);
    expect(isEngineSafe(thin)).toBe(false);
    expect(Math.abs(hullMass(thin.points) - hullVolume(thin) * 1000) / (hullVolume(thin) * 1000)).toBeGreaterThan(0.1);
    // the same slab 40 mm wide is fine, for the rule and for the engine
    const fat = convexHull3(slab(0.04, 2, 0.9, 0.3))!;
    expect(isEngineSafe(fat)).toBe(true);
    expect(Math.abs(hullMass(fat.points) - hullVolume(fat) * 1000) / (hullVolume(fat) * 1000)).toBeLessThan(1e-3);
  });

  it('a chamfer narrower than 0.15 % of the size crowds the cap, a 2.5 % one does not', () => {
    expect(crowdedVertices(convexHull3(discWithChamfer(0.001))!).size).toBeGreaterThan(0);
    expect(isEngineSafe(convexHull3(discWithChamfer(0.001))!)).toBe(false);
    expect(crowdedVertices(convexHull3(discWithChamfer(0.05))!).size).toBe(0);
    expect(isEngineSafe(convexHull3(discWithChamfer(0.05))!)).toBe(true);
  });

  it('picks the first candidate that is safe, in the order given', () => {
    const found = firstSafeHull([
      () => discWithChamfer(0.001),
      () => discWithChamfer(0.05),
      () => discWithChamfer(0.02),
    ])!;
    expect(found.index).toBe(1);
    // none qualifies: the last usable candidate
    expect(firstSafeHull([() => discWithChamfer(0.001), () => discWithChamfer(0.0015)])!.index).toBe(1);
    expect(firstSafeHull([() => [[0, 0, 0]]])).toBeNull();
  });

  it('bevelPlan: fine radii get fewer facets, then a chamfer, then none; sides come down for fine rims', () => {
    const D = 1.4;
    expect(maxBevelSteps(0.2, D)).toBeGreaterThanOrEqual(8);
    expect(maxBevelSteps(0.03, D)).toBeGreaterThanOrEqual(2);
    expect(maxBevelSteps(0.03, D)).toBeLessThan(10);
    expect(maxBevelSteps(0.0028, D)).toBe(1);
    expect(maxBevelSteps(0.002, D)).toBe(0);
    expect(bevelPlan(0.2, 4, D, false).map((p) => p.steps)).toEqual([4, 3, 2, 1, 1]);
    expect(bevelPlan(0.2, 4, D, false).at(-1)).toEqual({ rim: 0, steps: 1 }); // the sharp shape is the last resort
    expect(bevelPlan(0.2, 8, D, true)).toEqual([
      { rim: 0.2, steps: 1 },
      { rim: 0, steps: 1 },
    ]);
    expect(bevelPlan(0.001, D, D, false)).toEqual([{ rim: 0, steps: 1 }]);
    expect(sidesLadder(48)[0]).toBe(48);
    expect(sidesLadder(48).at(-1)).toBe(8);
    expect(sidesLadder(8)).toEqual([8]);
    // a body of revolution tries fewer sides before giving up on the rim
    const plans = bevelPlan(0.2, 6, D, false, 48);
    expect(plans.some((p) => p.sides !== undefined && p.sides < 48 && p.rim > 0)).toBe(true);
    expect(plans.at(-1)).toEqual({ rim: 0, steps: 1, sides: 48 });
  });
});

/** Hulls of every kind the new shapes produce, over wide parameter ranges. */
function corpus(): { label: string; hull: Hull }[] {
  const out: { label: string; hull: Hull }[] = [];
  const add = (label: string, pts: Vec3[]) => {
    const hull = convexHull3(pts);
    if (hull) out.push({ label, hull });
  };
  for (const steps of [1, 2, 3, 4, 6, 8])
    for (const seg of [8, 16, 24, 32, 48])
      for (const size of [
        [0.8, 0.6, 0.8],
        [0.5, 2, 0.5],
        [3, 3, 3],
        [2, 0.3, 2],
      ])
        for (const rnd of [0.03, 0.08, 0.2, 0.5, 1])
          add(
            `cylinder ${size.join('×')} r${rnd} s${steps} n${seg}`,
            revolvedPoints(
              roundedCylinderProfile(size[0] / 2, size[1], rnd * Math.min(size[0] / 2, size[1] / 2), steps),
              seg,
            ),
          );
  for (const steps of [1, 2, 3, 4, 6, 8])
    for (const size of [
      [1, 1, 1],
      [2, 0.3, 2],
      [0.5, 2, 0.5],
      [3, 3, 3],
      [5, 1, 4],
    ] as Vec3[])
      for (const rnd of [0.03, 0.08, 0.2, 0.5, 1])
        add(`box ${size.join('×')} r${rnd} s${steps}`, roundedBoxPoints(size, (rnd * Math.min(...size)) / 2, steps));
  for (const size of [
    [0.3, 3.1, 0.9],
    [2, 1, 2],
    [5, 0.5, 2],
    [1, 3, 1],
    [4, 1.5, 3],
    [0.5, 0.5, 0.5],
  ] as Vec3[])
    for (const segs of [4, 6, 8, 10, 14, 20, 32]) {
      for (const [fl, dk, ft] of [
        [0.1, 0.1, 0.25],
        [0.3, 0, 0],
        [0.05, 0.3, 0.5],
      ])
        for (const [i, pts] of profilePieces(pipeTop(fl, dk, ft, segs), 'x').entries())
          add(
            `pipe ${size.join('×')} f${fl} d${dk} n${segs} #${i}`,
            pts.map((p): Vec3 => [p[0] * size[0], p[1] * size[1], p[2] * size[2]]),
          );
      for (const [arc, base, deck] of [
        [70, 0.06, 0],
        [90, 0.04, 0.15],
        [20, 0.02, 0.3],
      ])
        for (const convex of [false, true])
          for (const [i, pts] of profilePieces(rampTop(arc, convex, base, deck, segs), 'z').entries())
            add(
              `ramp ${size.join('×')} a${arc} ${convex ? 'cv' : 'cc'} n${segs} #${i}`,
              pts.map((p): Vec3 => [p[0] * size[0], p[1] * size[1], p[2] * size[2]]),
            );
    }
  for (const w of [0.001, 0.002, 0.004, 0.006, 0.008, 0.012, 0.02, 0.04, 0.1])
    for (const drop of [0, 0.05, 0.3])
      for (const [h, d] of [
        [2, 0.9],
        [1, 1],
        [0.5, 2],
        [3, 3],
      ])
        add(`slab w${w} drop${drop} ${h}×${d}`, slab(w, h, d, drop));
  return out;
}

describe('the rule against the real engine, over a corpus of hulls', () => {
  it('every hull the rule accepts is integrated exactly; the hulls it rejects are where the engine goes wrong', () => {
    const hulls = corpus();
    let safe = 0,
      unsafe = 0,
      falseAccepts = 0,
      unsafeAndWrong = 0;
    const offenders: string[] = [];
    for (const { label, hull } of hulls) {
      const want = hullVolume(hull) * 1000;
      const got = hullMass(hull.points);
      const err = Number.isNaN(got) ? Infinity : Math.abs(got - want) / want;
      if (isEngineSafe(hull)) {
        safe++;
        if (err > 2e-3) {
          falseAccepts++;
          offenders.push(`${label}: ${(err * 100).toFixed(2)} %`);
        }
      } else {
        unsafe++;
        if (err > 2e-3) unsafeAndWrong++;
      }
    }
    process.stderr.write(
      `corpus: ${hulls.length} hulls, ${safe} safe (${falseAccepts} wrong), ${unsafe} rejected (${unsafeAndWrong} of them wrong)\n`,
    );
    expect(offenders.slice(0, 5)).toEqual([]);
    expect(falseAccepts).toBe(0);
    expect(safe).toBeGreaterThan(0.5 * hulls.length); // the rule leaves most hulls alone
    expect(unsafeAndWrong).toBeGreaterThan(100); // and what it rejects is really broken in the engine
  });
});

describe('the engine reproduces the hulls of the shapes built on the rule (mass = density × volume)', () => {
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
            const got = engineMass('rounded-cylinder', size, params);
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
          const got = engineMass('rounded-box', size, params);
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
        const got = engineMass('ellipsoid', spec.size, { detail });
        const err = Math.abs(got - want) / want;
        worst = Math.max(worst, err);
        cases++;
        expect(err, `${spec.size.join('×')} detail ${detail}: ${got} vs ${want}`).toBeLessThan(2e-3);
      }
    process.stderr.write(`ellipsoid: ${cases} cases, worst engine error ${(worst * 100).toFixed(3)} %\n`);
  });

  it('curved ramp, quarter-pipe and half-pipe, over shape × segments × proportions', () => {
    let worst = 0,
      cases = 0;
    const shapes: [string, Record<string, number | string>][] = [
      ['curved-ramp', { arc: 70, curve: 'concave', base: 0.06, deck: 0 }],
      ['curved-ramp', { arc: 90, curve: 'concave', base: 0.02, deck: 0.3 }],
      ['curved-ramp', { arc: 25, curve: 'convex', base: 0.1, deck: 0.1 }],
      ['quarter-pipe', { base: 0.04, deck: 0.15 }],
      ['half-pipe', { floor: 0.1, flat: 0.25, deck: 0.1 }],
      ['half-pipe', { floor: 0.3, flat: 0, deck: 0 }],
    ];
    for (const [type, params] of shapes)
      for (const segments of [4, 8, 14, 24, 32])
        for (const size of [
          [2, 1, 2.5],
          [0.3, 3.1, 0.9],
          [5, 0.5, 3],
          [1, 3, 1],
          [4, 1.5, 3],
          [0.4, 0.4, 0.4],
        ] as Vec3[]) {
          const p = { ...params, segments };
          const want = shapeVolume(makeShapeSpec(type, size, p)) * 1000;
          const got = engineMass(type, size, p);
          const err = Math.abs(got - want) / want;
          worst = Math.max(worst, err);
          cases++;
          expect(err, `${type} ${size.join('×')} ${JSON.stringify(p)}: ${got} vs ${want}`).toBeLessThan(2e-3);
        }
    process.stderr.write(`ramps and pipes: ${cases} cases, worst engine error ${(worst * 100).toFixed(3)} %\n`);
  });
});

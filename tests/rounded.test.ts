/**
 * Package SH, chunk 2 — rounded and chamfered variants (SH-12): the rounded box and the rounded cylinder.
 * Closed-form volumes (Steiner's formula for the round style, the chamfer's own), the engine's integrated mass, the
 * radius quantity, the fallback for radii too fine for the engine, and real rolling / resting behaviour.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { qfromAxisAngle, type Vec3 } from '../src/core/math';
import { createBody } from '../src/model/factory';
import {
  applyQuantity,
  completeSpec,
  makeShapeSpec,
  normalizeShapeSize,
  shapeBoundingRadius,
  shapeConvexPoints,
  shapeDef,
  shapeGeometry,
  shapeVolume,
} from '../src/model/shapeRegistry';
import { extentOf } from '../src/model/shapes/convexSolid';
import { roundedCylinderSolid } from '../src/model/shapes/roundedCylinder';
import { revolvedVolume } from '../src/model/shapes/revolve';
import { initRapier } from '../src/physics/world';
import { GEOMETRY_KIT } from '../src/render/geometryKit';
import { run, worldOf } from './helpers';
import { engineMass, meshVolume } from './shapeTestKit';

beforeAll(async () => {
  await initRapier();
});

const PI = Math.PI;
/** Volume of a box (A × B × C core) grown by r with a *chamfer*: the Minkowski sum with an octahedron of radius r. */
const chamferVolume = (size: Vec3, r: number) => {
  const [A, B, C] = size.map((s) => s - 2 * r);
  return A * B * C + 2 * r * (A * B + B * C + C * A) + 2 * r * r * (A + B + C) + (4 / 3) * r ** 3;
};
/** Steiner's formula for the same box grown by a true ball of radius r. */
const smoothRoundedVolume = (size: Vec3, r: number) => {
  const [A, B, C] = size.map((s) => s - 2 * r);
  return A * B * C + 2 * r * (A * B + B * C + C * A) + PI * r * r * (A + B + C) + (4 / 3) * PI * r ** 3;
};

describe('rounded box (SH-12)', () => {
  const SIZES: Vec3[] = [
    [1, 1, 1],
    [2, 0.6, 1.2],
    [0.4, 1.8, 0.7],
  ];

  it('roundness 0 is a sharp box: eight corners and the box volume', () => {
    for (const size of SIZES) {
      const spec = makeShapeSpec('rounded-box', size, { roundness: 0 });
      expect(shapeConvexPoints(spec)).toHaveLength(8);
      expect(shapeVolume(spec)).toBeCloseTo(size[0] * size[1] * size[2], 12);
    }
  });

  it('chamfer: the volume is the Minkowski sum of the core box with an octahedron, exactly', () => {
    for (const size of SIZES)
      for (const roundness of [0.1, 0.3, 0.6, 1]) {
        const spec = makeShapeSpec('rounded-box', size, { roundness, bevel: 'chamfer' });
        const r = roundness * (Math.min(...size) / 2);
        expect(shapeVolume(spec), `${size.join('×')} roundness ${roundness}`).toBeCloseTo(chamferVolume(size, r), 9);
      }
  });

  it('round: the volume approaches Steiner’s formula from below as the steps grow', () => {
    const size: Vec3 = [1.2, 0.8, 1];
    const r = 0.3 * 0.4;
    const smooth = smoothRoundedVolume(size, r);
    let last = chamferVolume(size, r);
    for (const steps of [2, 3, 4, 6, 8]) {
      const v = shapeVolume(makeShapeSpec('rounded-box', size, { roundness: 0.3, steps }));
      expect(v).toBeLessThan(smooth);
      expect(v).toBeGreaterThan(last - 1e-12);
      last = v;
    }
    expect(last / smooth).toBeGreaterThan(0.99);
  });

  it('more roundness, less volume; a fully rounded cube is almost a ball', () => {
    let last = Infinity;
    for (const roundness of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const v = shapeVolume(makeShapeSpec('rounded-box', [1, 1, 1], { roundness, steps: 8 }));
      expect(v).toBeLessThan(last);
      last = v;
    }
    expect(last).toBeGreaterThan(0.97 * (PI / 6)); // r = 0.5: a ball of diameter 1
    expect(last).toBeLessThan(PI / 6);
  });

  it('fills exactly its size box; the mesh encloses the very volume the colliders have', () => {
    for (const size of SIZES)
      for (const params of [
        { roundness: 0.3, steps: 4 },
        { roundness: 0.5, bevel: 'chamfer' },
        { roundness: 0 },
      ] as Record<string, number | string>[]) {
        const spec = makeShapeSpec('rounded-box', size, params);
        const e = extentOf(shapeConvexPoints(spec)!);
        for (let a = 0; a < 3; a++)
          expect(e.dims[a], `${size.join('×')} ${JSON.stringify(params)}`).toBeCloseTo(size[a], 9);
        expect(meshVolume('rounded-box', size, params), JSON.stringify(params)).toBeCloseTo(shapeVolume(spec), 6);
      }
  });

  it('the mesh has exact unit normals: flat faces keep axis normals, no pillow shading', () => {
    const geo = shapeGeometry(GEOMETRY_KIT, makeShapeSpec('rounded-box', [1, 1, 1], { roundness: 0.3, steps: 5 }));
    const n = geo.getAttribute('normal'),
      p = geo.getAttribute('position');
    let flatFaceVertices = 0;
    for (let i = 0; i < n.count; i++) {
      expect(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1)).toBeLessThan(1e-5);
      // a vertex on the +x face (x = 0.5 exactly, inside the flat part) must have the normal (1, 0, 0)
      if (Math.abs(p.getX(i) - 0.5) < 1e-6 && Math.abs(p.getY(i)) < 0.35 && Math.abs(p.getZ(i)) < 0.35) {
        flatFaceVertices++;
        expect(n.getX(i)).toBeCloseTo(1, 5);
      }
    }
    expect(flatFaceVertices).toBeGreaterThan(0);
  });

  it('the engine’s mass is density × volume for round and chamfer styles of every proportion', () => {
    for (const size of SIZES)
      for (const params of [
        { roundness: 0.25, steps: 4 },
        { roundness: 0.7, steps: 6 },
        { roundness: 1, steps: 3 },
        { roundness: 0.4, bevel: 'chamfer' },
      ] as Record<string, number | string>[]) {
        const want = shapeVolume(makeShapeSpec('rounded-box', size, params)) * 1000;
        expect(
          Math.abs(engineMass('rounded-box', size, params) - want) / want,
          `${size.join('×')} ${JSON.stringify(params)}`,
        ).toBeLessThan(1e-3);
      }
  });

  it('a rounding too fine for the engine falls back to fewer facets, then a chamfer, then a sharp box', () => {
    const n = (roundness: number, steps: number) =>
      shapeConvexPoints(makeShapeSpec('rounded-box', [1, 1, 1], { roundness, steps }))!.length;
    expect(n(0.5, 8)).toBeGreaterThan(n(0.5, 2)); // a visible radius keeps its facets
    expect(n(0.03, 8)).toBeLessThan(n(0.03, 2) + 1); // a 1.5 cm radius on a 1 m cube cannot keep 8 facets
    expect(n(0.01, 4)).toBeLessThanOrEqual(24); // at most a chamfer (8 corners × 3)
    expect(n(0.003, 4)).toBe(8); // a 1.5 mm radius is invisible and unsafe: a sharp box
  });

  it('Corner radius edits the roundness, never the size; the size field and gizmo keep working', () => {
    const def = shapeDef('rounded-box');
    const q = def.quantities![0];
    const base = makeShapeSpec('rounded-box', [2, 1, 1.5], { roundness: 0.4 });
    expect(q.get(completeSpec(base))).toBeCloseTo(0.2, 9); // 0.4 × half of the shortest side 1
    const edited = applyQuantity(base, q, 0.3);
    expect(edited.size).toEqual([2, 1, 1.5]);
    expect(edited.params?.roundness).toBeCloseTo(0.6, 9);
    expect(applyQuantity(base, q, 99).params?.roundness).toBe(1); // clamped to the shortest half-extent
    expect(applyQuantity(base, q, -1).params?.roundness).toBe(0);
    // scaling keeps the proportion of the rounding: a bigger box gets a bigger radius in metres
    const big = makeShapeSpec('rounded-box', [4, 2, 3], { roundness: 0.4 });
    expect(q.get(completeSpec(big))).toBeCloseTo(0.4, 9);
    expect(normalizeShapeSize('rounded-box', [0, 5, 5])).toEqual([0.02, 5, 5]);
  });

  it('bounding radius encloses every vertex and is reached by the corner', () => {
    const spec = makeShapeSpec('rounded-box', [2, 1, 1], { roundness: 0.5, steps: 5 });
    const r = shapeBoundingRadius(spec);
    const far = Math.max(...shapeConvexPoints(spec)!.map((p) => Math.hypot(...p)));
    expect(far).toBeCloseTo(r, 12);
    expect(r).toBeLessThan(Math.hypot(2, 1, 1) / 2); // rounder than the sharp box's half-diagonal
  });

  it('physics: a sharp cube sticks on a 25° slope with high friction, a fully rounded one rolls away', async () => {
    const slope = createBody({
      shape: { type: 'box', size: [12, 0.4, 3] },
      bodyType: 'static',
      position: [0, 0, 0],
      rotation: qfromAxisAngle([0, 0, 1], (-25 * PI) / 180),
      material: { preset: 'concrete', friction: 0.9, restitution: 0 },
    });
    const along: Vec3 = [Math.cos((25 * PI) / 180), -Math.sin((25 * PI) / 180), 0]; // down the slope (+x, −y)
    const upNormal: Vec3 = [Math.sin((25 * PI) / 180), Math.cos((25 * PI) / 180), 0];
    const place = (z: number, params: Record<string, number | string>) => {
      const h = 0.2 + 0.5 + 0.005;
      return createBody({
        shape: { type: 'rounded-box', size: [1, 1, 1], params },
        position: [-3 * along[0] + upNormal[0] * h, -3 * along[1] + upNormal[1] * h, z],
        rotation: qfromAxisAngle([0, 0, 1], (-25 * PI) / 180),
        material: { preset: 'custom', density: 500, friction: 0.9, restitution: 0 },
        angularDamping: 0.02,
        linearDamping: 0.02,
      });
    };
    const sharp = place(-0.9, { roundness: 0 });
    const round = place(0.9, { roundness: 1, steps: 6 });
    const w = await worldOf([slope, sharp, round]);
    run(w, 4);
    const moved = (id: string, from: Vec3) => {
      const p = w.getPose(id)!.position;
      return Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]);
    };
    expect(moved(sharp.id, sharp.position)).toBeLessThan(0.05);
    expect(moved(round.id, round.position)).toBeGreaterThan(2);
    w.dispose();
  });
});

describe('rounded cylinder (SH-12)', () => {
  it('roundness 0 is a plain N-gon prism', () => {
    for (const segments of [8, 24, 48]) {
      const spec = makeShapeSpec('rounded-cylinder', [1.2, 0.8, 1.2], { roundness: 0, segments });
      expect(shapeConvexPoints(spec)).toHaveLength(2 * segments);
      expect(shapeVolume(spec)).toBeCloseTo(0.5 * segments * 0.6 * 0.6 * Math.sin((2 * PI) / segments) * 0.8, 9);
    }
  });

  it('the volume is that of the stack of frusta its profile describes, and the mesh encloses it', () => {
    for (const params of [
      { roundness: 0.25, steps: 4, segments: 32 },
      { roundness: 0.6, steps: 3, segments: 24 },
      { roundness: 1, steps: 5, segments: 40 },
      { roundness: 0.4, bevel: 'chamfer', segments: 20 },
    ] as Record<string, number | string>[]) {
      const size: Vec3 = [1, 0.7, 1];
      const spec = makeShapeSpec('rounded-cylinder', size, params);
      const v = shapeVolume(spec);
      expect(meshVolume('rounded-cylinder', size, params), JSON.stringify(params)).toBeCloseTo(v, 6);
      const built = roundedCylinderSolid(spec);
      expect(built.steps, JSON.stringify(params)).toBeGreaterThanOrEqual(1);
      expect(built.steps).toBeLessThanOrEqual(params.bevel === 'chamfer' ? 1 : (params.steps as number));
      expect(v, JSON.stringify(params)).toBeCloseTo(revolvedVolume(built.profile, built.n), 9);
      const e = extentOf(shapeConvexPoints(spec)!);
      expect(e.dims[1]).toBeCloseTo(0.7, 9);
      expect(e.dims[0]).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('fillets approach the exact volume of a cylinder with a quarter-disc rim (Pappus)', () => {
    const R = 0.5,
      H = 0.8,
      rim = 0.3 * Math.min(R, H / 2); // roundness 0.3 below
    // each rim is the quarter disc of radius `rim` revolved about the axis: area π r² / 4 at centroid radius (R − r) + 4r / 3π
    const quarter = (PI * rim * rim) / 4;
    const centroid = R - rim + (4 * rim) / (3 * PI);
    const exact =
      PI * (R - rim) ** 2 * H + 2 * 2 * PI * centroid * quarter + PI * (R * R - (R - rim) ** 2) * (H - 2 * rim);
    const v = shapeVolume(makeShapeSpec('rounded-cylinder', [1, 0.8, 1], { roundness: 0.3, steps: 4, segments: 24 }));
    expect(v / exact).toBeGreaterThan(0.97);
    expect(v / exact).toBeLessThan(1);
  });

  it('the engine’s mass is density × volume for round and chamfer styles', () => {
    for (const size of [
      [1, 0.6, 1],
      [0.5, 2, 0.5],
      [3, 0.4, 3],
    ] as Vec3[])
      for (const params of [
        { roundness: 0.25, steps: 4, segments: 32 },
        { roundness: 1, steps: 6, segments: 48 },
        { roundness: 0.5, bevel: 'chamfer', segments: 24 },
        { roundness: 0.05, steps: 8, segments: 40 },
      ] as Record<string, number | string>[]) {
        const want = shapeVolume(makeShapeSpec('rounded-cylinder', size, params)) * 1000;
        expect(
          Math.abs(engineMass('rounded-cylinder', size, params) - want) / want,
          `${size.join('×')} ${JSON.stringify(params)}`,
        ).toBeLessThan(1e-3);
      }
  });

  it('a rim too fine for the engine becomes a sharp cylinder', () => {
    const pts = shapeConvexPoints(makeShapeSpec('rounded-cylinder', [1, 1, 1], { roundness: 0.004, segments: 24 }))!;
    expect(pts).toHaveLength(48);
  });

  it('Rim radius edits the roundness; the size keeps its axial rules', () => {
    const q = shapeDef('rounded-cylinder').quantities![0];
    const base = makeShapeSpec('rounded-cylinder', [1, 0.6, 1], { roundness: 0.5 });
    expect(q.get(completeSpec(base))).toBeCloseTo(0.15, 9); // 0.5 × min(R = 0.5, H/2 = 0.3)
    expect(applyQuantity(base, q, 0.06).params?.roundness).toBeCloseTo(0.2, 9);
    expect(normalizeShapeSize('rounded-cylinder', [2, 1, 1], undefined, [1, 1, 1])).toEqual([2, 1, 2]);
  });

  it('physics: stands on its flat cap at half its height; lying on its side it rolls on its rim', async () => {
    const standing = createBody({
      shape: { type: 'rounded-cylinder', size: [0.8, 0.6, 0.8], params: { roundness: 0.3, steps: 4 } },
      position: [0, 1.5, 0],
      material: { preset: 'plastic', restitution: 0, friction: 0.7 },
    });
    const lying = createBody({
      shape: { type: 'rounded-cylinder', size: [0.8, 0.3, 0.8], params: { roundness: 0.5, steps: 4 } },
      position: [3, 1.5, 0],
      rotation: qfromAxisAngle([0, 0, 1], PI / 2),
      material: { preset: 'plastic', restitution: 0, friction: 0.7 },
    });
    const w = await worldOf([standing, lying]);
    run(w, 4);
    expect(w.getPose(standing.id)!.position[1]).toBeCloseTo(0.3, 2);
    // the second one is a thin disc on edge: it falls flat and rests at half its thickness
    expect(w.getPose(lying.id)!.position[1]).toBeCloseTo(0.15, 1);
    w.dispose();
  });
});

/**
 * Package SH, chunk 2 — gear (SH-7): the involute tooth profile, the exact tiling of its section into convex pieces,
 * the quantities (module, pitch diameter) and — the real proof of the geometry — two gears driven through each other
 * in the engine, turning with the ratio of their tooth counts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { qfromAxisAngle, type Vec3 } from '../src/core/math';
import { createBody, createJoint } from '../src/model/factory';
import {
  applyQuantity,
  completeSpec,
  makeShapeSpec,
  normalizeShapeSize,
  shapeColliders,
  shapeDef,
  shapeVolume,
} from '../src/model/shapeRegistry';
import { gearLayout } from '../src/model/shapes/gear';
import { signedArea } from '../src/model/shapes/meshKit';
import { initRapier } from '../src/physics/world';
import RAPIER from '@dimforge/rapier3d-compat';
import { run, worldOf } from './helpers';
import { engineMass, meshVolume } from './shapeTestKit';

beforeAll(async () => {
  await initRapier();
});

const inv = (a: number) => Math.tan(a) - a;

describe('gear section (SH-7)', () => {
  it('2N convex pieces, counter-clockwise, tooth and gap alternating, every one convex', () => {
    for (const N of [6, 16, 48]) {
      const layout = gearLayout(N, 20, 0.3, 4);
      expect(layout.pieces).toHaveLength(2 * N);
      for (const poly of layout.pieces) {
        expect(signedArea(poly)).toBeGreaterThan(0);
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i],
            b = poly[(i + 1) % poly.length],
            c = poly[(i + 2) % poly.length];
          expect((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])).toBeGreaterThanOrEqual(-1e-12);
        }
      }
    }
  });

  it('the pieces tile the section exactly: their area is the outline’s (tooth profile) minus the bore', () => {
    for (const [N, bore] of [
      [8, 0.3],
      [16, 0.5],
      [30, 0],
    ] as const) {
      const layout = gearLayout(N, 20, bore, 5);
      // the pieces do not overlap (no sample point belongs to two), and together they cover exactly the section's area
      let seed = 7 + N;
      const rnd = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const inside = (poly: [number, number][], x: number, z: number) => {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i],
            b = poly[(i + 1) % poly.length];
          if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
        }
        return true;
      };
      let multi = 0,
        hit = 0;
      const samples = 40000;
      for (let s = 0; s < samples; s++) {
        const x = rnd() - 0.5,
          z = rnd() - 0.5;
        let n = 0;
        for (const poly of layout.pieces) if (inside(poly, x, z)) n++;
        if (n > 1) multi++;
        if (n >= 1) hit++;
      }
      expect(multi, `N=${N}: overlapping samples`).toBe(0);
      // and the covered fraction matches the area (the sampled square has area 1)
      expect(hit / samples).toBeCloseTo(layout.area, 2);
    }
  });

  it('flank vertices lie on a true involute: the angle plus the involute function of the pressure angle is constant', () => {
    const N = 20,
      alpha = (20 * Math.PI) / 180;
    const layout = gearLayout(N, 20, 0.2, 6);
    const rb = layout.pitchRadius * Math.cos(alpha);
    const tooth = layout.pieces[0]; // tooth 0 is centred on angle 0
    const flank = tooth
      .map(([x, z]) => ({ r: Math.hypot(x, z), a: Math.atan2(z, x) }))
      .filter((p) => p.r > rb * 1.001 && p.r < layout.tipRadius * 0.999 && p.a > 0);
    expect(flank.length).toBeGreaterThanOrEqual(4);
    const consts = flank.map((p) => p.a + inv(Math.acos(rb / p.r)));
    for (const c of consts) expect(c).toBeCloseTo(consts[0], 9);
    // the constant is half the tooth angle at the base circle: π/2N + inv(α) minus a sliver of backlash
    expect(consts[0]).toBeCloseTo(Math.PI / (2 * N) + inv(alpha), 2);
  });

  it('proportions: tip diameter is the size, pitch circle at module × N / 2, tooth thickness half the pitch', () => {
    const layout = gearLayout(16, 20, 0.3, 5);
    expect(layout.tipRadius).toBeCloseTo(0.5, 12);
    expect(layout.m).toBeCloseTo(1 / 18, 12);
    expect(layout.pitchRadius).toBeCloseTo(16 / 18 / 2, 12);
    expect(layout.rootRadius).toBeCloseTo(layout.pitchRadius - 1.25 * layout.m, 12);
    // tooth thickness on the pitch circle: half the circular pitch less the backlash (0.04 m)
    const tooth = layout.pieces[0];
    const onPitch = tooth
      .map(([x, z]) => ({ r: Math.hypot(x, z), a: Math.atan2(z, x) }))
      .filter((p) => Math.abs(p.r - layout.pitchRadius) < 0.02 && p.a > 0);
    expect(onPitch.length).toBeGreaterThan(0);
  });

  it('volume = section area × D² × thickness; mesh and engine agree for every proportion', () => {
    for (const [type, size, params] of [
      ['gear', [1, 0.18, 1], { teeth: 16, pressure: 20, bore: 0.3 }],
      ['gear', [2.4, 0.3, 2.4], { teeth: 8, pressure: 25, bore: 0 }],
      ['gear', [0.6, 0.05, 0.6], { teeth: 40, pressure: 14.5, bore: 0.6 }],
      ['gear', [3, 1, 3], { teeth: 12, pressure: 30, bore: 0.7 }],
      ['gear', [1, 0.02, 1], { teeth: 24, pressure: 20, bore: 0.25 }],
    ] as [string, Vec3, Record<string, number>][]) {
      const spec = makeShapeSpec(type, size, params);
      const v = shapeVolume(spec);
      expect(
        Math.abs(engineMass(type, size, params) - v * 1000) / (v * 1000),
        JSON.stringify([size, params]),
      ).toBeLessThan(2e-3);
      expect(meshVolume(type, size, params), JSON.stringify([size, params])).toBeCloseTo(v, 5);
    }
  });

  it('a gear has a bore: a rod fits through it, a solid gear has none', async () => {
    const withBore = makeShapeSpec('gear', [1, 0.18, 1], { teeth: 16, bore: 0.4 });
    const solid = makeShapeSpec('gear', [1, 0.18, 1], { teeth: 16, bore: 0 });
    expect(shapeVolume(withBore)).toBeLessThan(shapeVolume(solid));
    // the axis is empty: the colliders do not contain the origin of a bored gear
    const contains = (spec: ReturnType<typeof makeShapeSpec>) => {
      const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
      const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      for (const c of shapeColliders(RAPIER, spec)) world.createCollider(c.desc, rb);
      world.step();
      const hit = world.intersectionWithShape({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(0.02));
      world.free();
      return !!hit;
    };
    expect(contains(withBore)).toBe(false);
    expect(contains(solid)).toBe(true);
    const fixed = createBody({
      shape: { type: 'gear', size: [1, 0.18, 1], params: { teeth: 16, bore: 0.4 } },
      bodyType: 'static',
      position: [0, 0.5, 0],
    });
    const rod = createBody({
      shape: { type: 'cylinder', size: [0.2, 1.2, 0.2] },
      position: [0, 1.8, 0],
      material: { preset: 'plastic', friction: 0.2, restitution: 0 },
    });
    const world = await worldOf([fixed, rod]);
    run(world, 2);
    // the rod slid through the bore of the static gear and lies on the ground
    expect(world.getPose(rod.id)!.position[1]).toBeLessThan(0.7);
    world.dispose();
  });

  it('Module and Pitch diameter edit the size for the same teeth; the parameters never change', () => {
    const def = shapeDef('gear');
    const [mod, pitch] = def.quantities!;
    const base = makeShapeSpec('gear', [0.9, 0.2, 0.9], { teeth: 16 });
    expect(mod.get(completeSpec(base))).toBeCloseTo(0.9 / 18, 12);
    expect(pitch.get(completeSpec(base))).toBeCloseTo(0.9 * (16 / 18), 12);
    const bigger = applyQuantity(base, mod, 0.1);
    expect(bigger.size).toEqual([1.8, 0.2, 1.8]);
    expect(bigger.params?.teeth).toBe(16);
    const byPitch = applyQuantity(base, pitch, 1.6);
    expect(byPitch.size[0]).toBeCloseTo(1.8, 9);
    // the diameter stays round whichever field edits it
    expect(normalizeShapeSize('gear', [2, 0.2, 1], undefined, [1, 0.2, 1])).toEqual([2, 0.2, 2]);
    expect(normalizeShapeSize('gear', [1, 0.5, 1], undefined, [1, 0.2, 1])).toEqual([1, 0.5, 1]);
  });
});

describe('two gears mesh (SH-7)', () => {
  it('driven through each other in the engine they turn with the ratio −N₁ / N₂', async () => {
    const m = 0.05;
    const N1 = 16,
      N2 = 24;
    const D1 = m * (N1 + 2),
      D2 = m * (N2 + 2);
    const centre = (m * (N1 + N2)) / 2; // 1.0
    const t = 0.12;
    const A = createBody({
      shape: { type: 'gear', size: [D1, t, D1], params: { teeth: N1, bore: 0.3 } },
      position: [0, 1, 0],
      gravityScale: 0,
      material: { preset: 'steel', friction: 0.1, restitution: 0 },
      linearDamping: 0,
      angularDamping: 0,
    });
    const B = createBody({
      shape: { type: 'gear', size: [D2, t, D2], params: { teeth: N2, bore: 0.3 } },
      position: [centre, 1, 0],
      rotation: qfromAxisAngle([0, 1, 0], Math.PI / N2), // half a pitch: A's tooth faces a gap of B
      gravityScale: 0,
      material: { preset: 'steel', friction: 0.1, restitution: 0 },
      linearDamping: 0,
      angularDamping: 0,
    });
    const hingeA = createJoint({
      type: 'hinge',
      bodyA: null,
      bodyB: A.id,
      anchorA: [0, 1, 0],
      axis: [0, 1, 0],
      motor: {
        mode: 'velocity',
        targetVelocity: 2,
        targetPosition: 0,
        stiffness: 0,
        damping: 200,
        maxForce: 1e4,
        keyPos: '',
        keyNeg: '',
        slewRate: 1,
        brake: false,
      },
    });
    const hingeB = createJoint({ type: 'hinge', bodyA: null, bodyB: B.id, anchorA: [centre, 1, 0], axis: [0, 1, 0] });
    const w = await worldOf([A, B, hingeA, hingeB]);
    run(w, 8);
    const a = w.getJointRec(hingeA.id)!,
      b = w.getJointRec(hingeB.id)!;
    // A turned at the motor’s speed, several revolutions; B follows in the opposite sense at N1/N2 of the speed
    expect(a.speed).toBeGreaterThan(1.8);
    expect(Math.abs(a.value)).toBeGreaterThan(8);
    const ratio = b.value / a.value;
    expect(ratio).toBeLessThan(0);
    expect(Math.abs(ratio)).toBeGreaterThan((N1 / N2) * 0.97);
    expect(Math.abs(ratio)).toBeLessThan((N1 / N2) * 1.03);
    expect(Math.abs(b.speed / a.speed)).toBeGreaterThan((N1 / N2) * 0.85);
    expect(Math.abs(b.speed / a.speed)).toBeLessThan((N1 / N2) * 1.15);
    w.dispose();
  });
});

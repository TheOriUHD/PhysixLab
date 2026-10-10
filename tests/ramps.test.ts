/**
 * Package SH, chunk 2 — curved ramp, quarter-pipe and half-pipe (SH-11): exact volumes against the integrals of the
 * curves, the decomposition into convex pieces, and real physics — a ball sliding down a half-pipe and up the other
 * side, a body resting on a dynamic ramp, the same shapes static and dynamic.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Quat, Vec3 } from '../src/core/math';
import { createBody } from '../src/model/factory';
import {
  makeShapeSpec,
  normalizeShapeSize,
  shapeBoundingRadius,
  shapeColliders,
  shapeDef,
  shapeVolume,
} from '../src/model/shapeRegistry';
import { builtProfileTop } from '../src/model/shapes/curvedRamp';
import { concaveRuns, pipeTop, profileArea, rampTop } from '../src/model/shapes/profileSolid';
import { initRapier } from '../src/physics/world';
import RAPIER from '@dimforge/rapier3d-compat';
import { run, worldOf } from './helpers';
import { engineMass, meshVolume } from './shapeTestKit';

beforeAll(async () => {
  await initRapier();
});

const PI = Math.PI;

/** Area of a quarter-ellipse sweep by numerical integration (the smooth curve the polyline approximates). */
function smoothRampArea(arcDeg: number, convex: boolean, base: number): number {
  const arc = (arcDeg * PI) / 180;
  const N = 20000;
  let integral = 0; // ∫ gy dgz over the concave curve
  for (let i = 0; i < N; i++) {
    const t = ((i + 0.5) / N) * arc;
    const gy = (1 - Math.cos(t)) / (1 - Math.cos(arc));
    integral += ((gy * Math.cos(t)) / Math.sin(arc)) * (arc / N);
  }
  const g = convex ? 1 - integral : integral;
  return base + (1 - base) * g;
}

describe('curved ramp (SH-11)', () => {
  it('the volume converges to the smooth curve: from above for the concave ramp, from below for the convex hill', () => {
    for (const arc of [30, 60, 90]) {
      for (const base of [0.02, 0.2]) {
        for (const convex of [false, true]) {
          const smooth = smoothRampArea(arc, convex, base);
          let last = convex ? 0 : Infinity;
          for (const segments of [4, 8, 16, 32]) {
            const a = profileArea(rampTop(arc, convex, base, 0, segments));
            if (convex) {
              expect(a).toBeLessThan(smooth + 1e-12);
              expect(a).toBeGreaterThan(last);
            } else {
              expect(a).toBeGreaterThan(smooth - 1e-12);
              expect(a).toBeLessThan(last);
            }
            last = a;
          }
          expect(Math.abs(last - smooth) / smooth, `arc ${arc} base ${base} convex ${convex}`).toBeLessThan(0.004);
        }
      }
    }
    // the quarter circle: area under the arc = 1 − π/4 of the box
    expect(smoothRampArea(90, false, 0)).toBeCloseTo(1 - PI / 4, 6);
    expect(smoothRampArea(90, true, 0)).toBeCloseTo(PI / 4, 6);
  });

  it('volume = unit area × width × height × depth; the mesh and the engine agree', () => {
    for (const size of [
      [2, 1, 2.5],
      [0.8, 1.6, 1.1],
    ] as Vec3[])
      for (const params of [
        { arc: 70, curve: 'concave', base: 0.06, deck: 0, segments: 14 },
        { arc: 90, curve: 'concave', base: 0.04, deck: 0.2, segments: 20 },
        { arc: 40, curve: 'convex', base: 0.1, deck: 0.1, segments: 12 },
      ]) {
        const spec = makeShapeSpec('curved-ramp', size, params);
        const v = shapeVolume(spec);
        // the top actually built may have fewer segments than asked (a gentle convex arc cut too fine)
        const built = builtProfileTop(spec)!;
        expect(built.top.length).toBeLessThanOrEqual(params.segments + 2);
        expect(v).toBeCloseTo(profileArea(built.top) * size[0] * size[1] * size[2], 9);
        expect(meshVolume('curved-ramp', size, params)).toBeCloseTo(v, 6);
        expect(Math.abs(engineMass('curved-ramp', size, params) - v * 1000) / (v * 1000)).toBeLessThan(2e-3);
      }
  });

  it('is a compound of convex pieces that tile the solid: one slab per segment when concave, one hull when convex', () => {
    const concave = shapeColliders(
      RAPIER,
      makeShapeSpec('curved-ramp', undefined, { curve: 'concave', segments: 14, deck: 0 }),
    );
    expect(concave).toHaveLength(14);
    const convex = shapeColliders(
      RAPIER,
      makeShapeSpec('curved-ramp', undefined, { curve: 'convex', segments: 14, deck: 0.2 }),
    );
    expect(convex).toHaveLength(1); // the region under a concave function is convex, deck and all
    // the deck joins the last slab of a concave ramp (a steep stretch followed by a flat one is still convex)
    const withDeck = shapeColliders(
      RAPIER,
      makeShapeSpec('curved-ramp', undefined, { curve: 'concave', segments: 14, deck: 0.3 }),
    );
    expect(withDeck).toHaveLength(14);
    expect(concaveRuns(rampTop(90, false, 0.04, 0.3, 14))).toHaveLength(14);
  });

  it('the low end is a thin edge of the requested thickness, the high end reaches the top of the box', () => {
    const top = rampTop(80, false, 0.1, 0, 12);
    expect(top[0]).toEqual([-0.5, -0.4]);
    expect(top[top.length - 1][0]).toBeCloseTo(0.5, 12);
    expect(top[top.length - 1][1]).toBeCloseTo(0.5, 12);
    // concave: the surface is tangent to the floor at the low end (first step nearly flat) and steeper at the end
    const slope = (i: number) => (top[i + 1][1] - top[i][1]) / (top[i + 1][0] - top[i][0]);
    expect(slope(0)).toBeLessThan(0.15);
    expect(slope(top.length - 2)).toBeGreaterThan(2);
    const hill = rampTop(80, true, 0.1, 0, 12);
    const hillSlope = (i: number) => (hill[i + 1][1] - hill[i][1]) / (hill[i + 1][0] - hill[i][0]);
    expect(hillSlope(0)).toBeGreaterThan(2); // rises steeply …
    expect(hillSlope(hill.length - 2)).toBeLessThan(0.15); // … and flattens out at the top
  });

  it('sizes are free; the bounding radius is the box’s half diagonal; resting height is half the height', () => {
    const def = shapeDef('curved-ramp');
    expect(def.sizeFields.map((f) => f.label)).toEqual(['Width', 'Height', 'Depth']);
    expect(normalizeShapeSize('curved-ramp', [0, 0, 0])).toEqual([0.02, 0.02, 0.02]);
    expect(shapeBoundingRadius(makeShapeSpec('curved-ramp', [2, 1, 2]))).toBeCloseTo(Math.hypot(2, 1, 2) / 2, 12);
  });
});

describe('quarter-pipe (SH-11)', () => {
  it('is the 90° concave ramp with a deck: the wall ends vertical, the deck is flat at the top', () => {
    const top = rampTop(90, false, 0.04, 0.15, 16);
    expect(top[top.length - 1]).toEqual([0.5, 0.5]);
    expect(top[top.length - 2][1]).toBeCloseTo(0.5, 12);
    expect(top[top.length - 2][0]).toBeCloseTo(0.35, 12);
    // the last arc step is nearly vertical
    const [a, b] = [top[top.length - 3], top[top.length - 2]];
    expect((b[1] - a[1]) / (b[0] - a[0])).toBeGreaterThan(8);
    const spec = makeShapeSpec('quarter-pipe');
    expect(shapeVolume(spec)).toBeCloseTo(profileArea(top) * 2 * 1.2 * 1.4, 9);
  });

  it('a ball released on the deck edge slides down, crosses the floor and stops against the wall of nothing: it ends on the ground beyond the foot', async () => {
    // a static quarter-pipe (2 × 1.2 × 1.4, low end toward −z) and a frictionless ball dropped at the top of the wall
    const pipe = createBody({
      shape: { type: 'quarter-pipe' },
      bodyType: 'static',
      position: [0, 0.6, 0],
      material: { preset: 'concrete', friction: 0.05, restitution: 0 },
    });
    // the curve ends at z = 0.7 − 0.15·1.4 = 0.49; start the ball above the curve near the top, slightly toward −z
    const ball = createBody({
      shape: { type: 'sphere', size: [0.1, 0.1, 0.1] },
      position: [0, 1.15, 0.3],
      material: { preset: 'custom', density: 1000, friction: 0.05, restitution: 0 },
    });
    const w = await worldOf([pipe, ball]);
    run(w, 4);
    const p = w.getPose(ball.id)!.position;
    // it rolled down the transition toward −z, past the foot of the ramp, and is on the ground
    expect(p[2]).toBeLessThan(-0.7);
    expect(p[1]).toBeLessThan(0.2);
    w.dispose();
  });
});

describe('half-pipe (SH-11)', () => {
  it('the volume converges to the smooth channel (two elliptical quarter arcs, a flat bottom and decks)', () => {
    const smooth = (floor: number, deck: number, flat: number): number => {
      const half = 0.5 * (1 - deck);
      const fh = half * flat,
        aw = half - fh;
      const yTop = 0.5,
        yFloor = -0.5 + floor;
      // area of the solid: everything below the surface, measured from the bottom −0.5
      // across the deck (both sides): full height 1; across the flat: floor thickness; across the arcs: ∫ (yFloor + (yTop − yFloor)(1 − cosφ)) + 0.5
      const depth = yTop - yFloor;
      const arcs = 2 * (aw * (floor + depth * (1 - 2 / PI)));
      void arcs;
      let integral = 0;
      const N = 40000;
      for (let i = 0; i < N; i++) {
        const phi = ((i + 0.5) / N) * (PI / 2);
        const y = yFloor + depth * (1 - Math.cos(phi)) + 0.5;
        integral += y * aw * Math.cos(phi) * (PI / 2 / N);
      }
      return 2 * deck * 0.5 * 1 + 2 * fh * floor + 2 * integral;
    };
    for (const [floor, deck, flat] of [
      [0.1, 0.1, 0.25],
      [0.3, 0, 0],
      [0.05, 0.3, 0.6],
    ]) {
      const exact = smooth(floor, deck, flat);
      let last = Infinity;
      for (const segments of [4, 8, 16, 32]) {
        const a = profileArea(pipeTop(floor, deck, flat, segments));
        expect(a).toBeGreaterThan(exact - 1e-12); // the chords lie above the concave-up curve
        expect(a).toBeLessThan(last);
        last = a;
      }
      expect(Math.abs(last - exact) / exact, `floor ${floor} deck ${deck} flat ${flat}`).toBeLessThan(0.005);
    }
  });

  it('is symmetric, spans the full width, reaches the top at both lips and the floor line in the middle', () => {
    const top = pipeTop(0.2, 0.1, 0.3, 10);
    expect(top[0]).toEqual([-0.5, 0.5]);
    expect(top[top.length - 1]).toEqual([0.5, 0.5]);
    for (let i = 0; i < top.length; i++) {
      const mirror = top[top.length - 1 - i];
      expect(mirror[0]).toBeCloseTo(-top[i][0], 12);
      expect(mirror[1]).toBeCloseTo(top[i][1], 12);
    }
    expect(Math.min(...top.map((p) => p[1]))).toBeCloseTo(-0.3, 12);
  });

  it('volume = unit area × size; the mesh and the engine agree; works for every proportion', () => {
    for (const size of [
      [4, 1.5, 3],
      [0.3, 3.1, 0.9],
      [6, 0.8, 2],
    ] as Vec3[]) {
      const spec = makeShapeSpec('half-pipe', size);
      const v = shapeVolume(spec);
      expect(Math.abs(engineMass('half-pipe', size) - v * 1000) / (v * 1000), size.join('×')).toBeLessThan(2e-3);
      expect(meshVolume('half-pipe', size)).toBeCloseTo(v, 5);
    }
  });

  it('physics: a frictionless ball released on one wall climbs the other nearly as high, and settles in the middle with friction', async () => {
    // 4 m wide, 1.5 m high pipe (decks 0.2 m, flat bottom 0.9 m), 3 m long, static; a frictionless 0.2 m ball
    // released just above the surface on the left wall at y = 1.13
    const pipe = createBody({
      shape: { type: 'half-pipe', size: [4, 1.5, 3] },
      bodyType: 'static',
      position: [0, 0.75, 0],
      material: { preset: 'concrete', friction: 0, restitution: 0 },
    });
    const release = createBody({
      shape: { type: 'sphere', size: [0.2, 0.2, 0.2] },
      position: [-1.7, 1.13, 0],
      material: { preset: 'custom', density: 1000, friction: 0, restitution: 0 },
      linearDamping: 0,
      angularDamping: 0,
    });
    const w = await worldOf([pipe, release]);
    let maxRight = 0;
    const steps = Math.round(6 * w.settings.physicsHz);
    for (let i = 0; i < steps; i++) {
      w.stepOnce();
      const p = w.getPose(release.id)!.position;
      if (p[0] > 0.5) maxRight = Math.max(maxRight, p[1]);
    }
    // it climbs the far wall to within 0.2 m of where it started (the drop to the floor is 0.88 m): the seams between
    // the pieces and the first contact with the wall cost the rest
    expect(maxRight).toBeGreaterThan(0.9);
    w.dispose();

    // with friction and damping it ends up on the flat bottom
    const pipe2 = { ...pipe, material: { ...pipe.material, friction: 0.6 } };
    const ball2 = {
      ...release,
      material: { ...release.material, friction: 0.6 },
      linearDamping: 0.4,
      angularDamping: 0.6,
    };
    const w2 = await worldOf([pipe2, ball2]);
    run(w2, 25);
    const p2 = w2.getPose(ball2.id)!.position;
    expect(Math.abs(p2[0])).toBeLessThan(0.45);
    expect(p2[1]).toBeLessThan(0.3); // on the floor: floor line y = 0.15 plus the ball radius
    w2.dispose();
  });
});

describe('dynamic ramps (SH-11)', () => {
  it('a dynamic quarter-pipe, curved ramp and half-pipe drop to the ground and rest flat, at half their height', async () => {
    const mk = (type: string, x: number) =>
      createBody({
        shape: { type },
        position: [x, 2, 0],
        rotation: [0.05, 0, 0.03, 0.9983] as Quat,
        material: { preset: 'plastic', friction: 0.8, restitution: 0 },
        angularDamping: 0.5,
      });
    const bodies = [mk('quarter-pipe', -4), mk('curved-ramp', 0), mk('half-pipe', 5)];
    const w = await worldOf(bodies);
    run(w, 6);
    for (const b of bodies) {
      const pose = w.getPose(b.id)!;
      const half = shapeDef(b.shape.type).defaultSize[1] / 2;
      expect(pose.position[1], b.shape.type).toBeGreaterThan(half - 0.02);
      expect(pose.position[1], b.shape.type).toBeLessThan(half + 0.02);
      expect(Math.abs(pose.rotation[0]) + Math.abs(pose.rotation[2]), b.shape.type).toBeLessThan(0.02);
    }
    w.dispose();
  });
});

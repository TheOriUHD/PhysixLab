/**
 * Package SH, chunk 2 — wheel (SH-7): the tiling of its pieces, exact volume, the dark tyre, windows between the spokes,
 * and rolling for real.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { qfromAxisAngle, type Vec3 } from '../src/core/math';
import { createBody } from '../src/model/factory';
import {
  makeShapeSpec,
  normalizeShapeSize,
  shapeBoundingRadius,
  shapeColliders,
  shapeGeometry,
  shapeVolume,
} from '../src/model/shapeRegistry';
import { WHEEL_MAX_WIDTH, wheelLayout, wheelParams } from '../src/model/shapes/wheel';
import { initRapier } from '../src/physics/world';
import { GEOMETRY_KIT } from '../src/render/geometryKit';
import RAPIER from '@dimforge/rapier3d-compat';
import { run, worldOf } from './helpers';
import { engineMass, meshVolume } from './shapeTestKit';

beforeAll(async () => {
  await initRapier();
});

describe('wheel (SH-7)', () => {
  it('piece counts: Nt tyre slices, Nt rim slices, one hub, and the web cells (all of them for a dish, s per spoke otherwise)', () => {
    const spoked = makeShapeSpec('wheel', undefined, { spokes: 5, segments: 20, spokeWidth: 0.3 });
    const L = wheelLayout(wheelParams(spoked));
    expect(L.Nt).toBe(20);
    const webCells = L.web.runs.reduce((s, r) => s + r[1], 0);
    expect(webCells).toBe(5); // 5 spokes × 1 cell (0.3 × 4 cells per spoke, rounded)
    expect(shapeColliders(RAPIER, spoked)).toHaveLength(20 + 20 + 1 + 5);
    const dish = makeShapeSpec('wheel', undefined, { spokes: 0, segments: 16 });
    const D = wheelLayout(wheelParams(dish));
    expect(D.Nt).toBe(16);
    expect(shapeColliders(RAPIER, dish)).toHaveLength(16 + 16 + 1 + 16);
    // the cells per spoke grow with the width and never fill the whole pitch
    for (const w of [0.15, 0.4, 0.7]) {
      const l = wheelLayout(wheelParams(makeShapeSpec('wheel', undefined, { spokes: 4, segments: 24, spokeWidth: w })));
      const per = l.web.runs[0][1];
      expect(per).toBeGreaterThanOrEqual(1);
      expect(per).toBeLessThan(l.Nt / 4);
    }
  });

  it('volume = unit volume × D² × W; the mesh encloses it and the engine integrates it', () => {
    for (const size of [
      [1, 0.3, 1],
      [2, 0.5, 2],
      [0.5, 0.9, 0.5],
      [3, 1.2, 3],
      [1, 0.05, 1],
    ] as Vec3[])
      for (const params of [
        { tire: 0.2, spokes: 5, spokeWidth: 0.3, hub: 0.18, segments: 20 },
        { tire: 0.08, spokes: 0, spokeWidth: 0.3, hub: 0.3, segments: 12 },
        { tire: 0.4, spokes: 12, spokeWidth: 0.7, hub: 0.45, segments: 30 },
        { tire: 0.25, spokes: 3, spokeWidth: 0.15, hub: 0.08, segments: 40 },
      ]) {
        const spec = makeShapeSpec('wheel', size, params);
        const v = shapeVolume(spec);
        const want = v * 1000;
        expect(Math.abs(engineMass('wheel', size, params) - want) / want, JSON.stringify([size, params])).toBeLessThan(
          2e-3,
        );
        expect(meshVolume('wheel', size, params), JSON.stringify([size, params])).toBeCloseTo(v, 5);
      }
  });

  it('the tyre is tinted dark in the mesh and the rim, hub and spokes are not', () => {
    const geo = shapeGeometry(GEOMETRY_KIT, makeShapeSpec('wheel'));
    const col = geo.getAttribute('color');
    expect(col).toBeDefined();
    const pos = geo.getAttribute('position');
    let tyre = 0,
      body = 0;
    for (let i = 0; i < col.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      const c = col.getX(i);
      if (c < 0.2) {
        tyre++;
        expect(r).toBeGreaterThan(0.3); // dark vertices are on the tyre (outer part of the wheel)
      } else {
        body++;
        expect(c).toBeCloseTo(1, 6);
      }
    }
    expect(tyre).toBeGreaterThan(0.3 * col.count);
    expect(body).toBeGreaterThan(0.2 * col.count);
  });

  it('a ball falls through the window between two spokes and rests on a solid dish', async () => {
    const ballAt = (angleDeg: number, y: number) =>
      createBody({
        shape: { type: 'sphere', size: [0.2, 0.2, 0.2] },
        position: [0.5 * Math.cos((angleDeg * Math.PI) / 180), y, 0.5 * Math.sin((angleDeg * Math.PI) / 180)],
        material: { preset: 'plastic', friction: 0.3, restitution: 0 },
      });
    const wheelAt = (params: Record<string, number>) =>
      createBody({
        shape: { type: 'wheel', size: [2, 0.4, 2], params },
        bodyType: 'static',
        position: [0, 1, 0],
      });
    // 5 spokes of one 18° cell each, the first at cell 1 (18°–36°): the window between spokes spans 36°–90°, centre 63°
    const spoked = ballAt(63, 2.5);
    const w1 = await worldOf([wheelAt({ spokes: 5, segments: 20, spokeWidth: 0.3 }), spoked]);
    run(w1, 2);
    expect(w1.getPose(spoked.id)!.position[1]).toBeLessThan(0.2); // fell through to the ground
    w1.dispose();
    const dishBall = ballAt(63, 2.5);
    const w2 = await worldOf([wheelAt({ spokes: 0, segments: 20 }), dishBall]);
    run(w2, 2);
    expect(w2.getPose(dishBall.id)!.position[1]).toBeGreaterThan(1.1); // rests on the dish
    w2.dispose();
  });

  it('rolls without slipping, standing upright; its tyre is a 32-gon, so it loses speed at every facet (an exact cylinder does not)', async () => {
    const R = 0.5;
    const rolling = (shape: { type: string; size: Vec3; params?: Record<string, number> }) =>
      createBody({
        shape,
        position: [0, R + 0.01, 0],
        rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2), // axle along z
        velocity: [2, 0, 0],
        angularVelocity: [0, 0, -2 / R],
        material: { preset: 'rubber', friction: 1, restitution: 0 },
        linearDamping: 0,
        angularDamping: 0,
      });
    const wheelBody = rolling({ type: 'wheel', size: [1, 0.3, 1], params: { segments: 32 } });
    const cylinder = rolling({ type: 'cylinder', size: [1, 0.3, 1] });
    const world = await worldOf([wheelBody, { ...cylinder, position: [0, R + 0.01, 3] }]);
    run(world, 2);
    const pose = world.getPose(wheelBody.id)!;
    const exact = world.getPose(cylinder.id)!;
    expect(exact.position[0]).toBeGreaterThan(3.9); // the exact circle rolls 4 m
    expect(pose.position[0]).toBeGreaterThan(2.8); // the 32-gon keeps over 70 % of the distance …
    expect(pose.position[0]).toBeLessThan(exact.position[0]);
    expect(Math.abs(pose.position[2])).toBeLessThan(0.1);
    expect(pose.position[1]).toBeGreaterThan(R * 0.97); // … stays at radius height …
    expect(pose.position[1]).toBeLessThan(R * 1.03);
    const slip = Math.abs(pose.linvel[0] + pose.angvel[2] * R) / Math.max(0.5, pose.linvel[0]);
    expect(slip).toBeLessThan(0.15); // … and rolls: v = ω R
    world.dispose();
  });

  it('sizes: round, and no wider than twice the diameter; bounding radius encloses the tyre', () => {
    expect(WHEEL_MAX_WIDTH).toBe(2);
    expect(normalizeShapeSize('wheel', [1, 5, 1])).toEqual([1, 2, 1]);
    expect(normalizeShapeSize('wheel', [2, 0.4, 1], undefined, [1, 0.4, 1])).toEqual([2, 0.4, 2]);
    expect(normalizeShapeSize('wheel', [0.3, 3.1, 0.3])).toEqual([0.3, 0.6, 0.3]);
    expect(shapeBoundingRadius(makeShapeSpec('wheel', [1, 0.3, 1]))).toBeCloseTo(Math.hypot(0.5, 0.15), 12);
  });
});

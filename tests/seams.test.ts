/**
 * Package SH, chunk 2 — seams between the convex pieces of a compound surface.
 *
 * The engine's default contact prediction distance is 2 cm: close enough to a seam, a ball also touches the edge of
 * the next piece, and the contact normals of those speculative edge contacts steal speed — a frictionless ball
 * sliding down a slope made of 16 coplanar slabs kept only 70 % of the speed it has on one slab. The world sets the
 * distance to 2 mm (src/physics/world/settings.ts), which keeps 97 %. This is the guarantee behind every ramp,
 * stair and half-pipe made of several colliders.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { qfromAxisAngle, type Vec3 } from '../src/core/math';
import { createBody, defaultGround } from '../src/model/factory';
import { initRapier } from '../src/physics/world';
import { worldOf } from './helpers';

beforeAll(async () => {
  await initRapier();
});

const ANGLE = (30 * Math.PI) / 180;

/** Speed of a frictionless ball after sliding `distance` down a 30° slope made of `pieces` coplanar boxes, as a fraction of √(2 g h). */
async function slideFraction(pieces: number, hz: number, distance = 3): Promise<number> {
  const total = 8;
  const len = total / pieces;
  const rot = qfromAxisAngle([0, 0, 1], -ANGLE);
  const dir: Vec3 = [Math.cos(ANGLE), -Math.sin(ANGLE), 0]; // down the slope
  const up: Vec3 = [Math.sin(ANGLE), Math.cos(ANGLE), 0];
  const slab = (i: number) => {
    const along = (i + 0.5) * len;
    return createBody({
      shape: { type: 'box', size: [len, 0.2, 2] },
      bodyType: 'static',
      rotation: rot,
      position: [dir[0] * along - up[0] * 0.1, dir[1] * along - up[1] * 0.1, 0],
      material: { preset: 'concrete', friction: 0, restitution: 0 },
    });
  };
  const start = 0.6;
  const ball = createBody({
    shape: { type: 'sphere', size: [0.2, 0.2, 0.2] },
    position: [dir[0] * start + up[0] * 0.1005, dir[1] * start + up[1] * 0.1005, 0],
    material: { preset: 'custom', density: 1000, friction: 0, restitution: 0 },
    linearDamping: 0,
    angularDamping: 0,
  });
  const w = await worldOf([...Array.from({ length: pieces }, (_, i) => slab(i)), ball], {
    physicsHz: hz,
    ground: { ...defaultGround(), enabled: false },
  });
  const p0 = w.getPose(ball.id)!.position;
  let best = 0;
  for (let i = 0; i < 4 * hz; i++) {
    w.stepOnce();
    const pose = w.getPose(ball.id)!;
    const p = pose.position;
    const travelled = Math.hypot(p[0] - p0[0], p[1] - p0[1]);
    if (travelled >= distance) {
      const v = pose.linvel;
      const drop = p0[1] - p[1];
      best = Math.hypot(v[0], v[1], v[2]) / Math.sqrt(2 * 9.81 * drop);
      break;
    }
  }
  w.dispose();
  return best;
}

describe('compound surfaces roll like one piece', () => {
  it('a frictionless ball keeps its speed over 1, 8, 16 and 32 coplanar slabs (120 Hz)', async () => {
    for (const pieces of [1, 8, 16, 32]) {
      const f = await slideFraction(pieces, 120);
      expect(f, `${pieces} slabs`).toBeGreaterThan(0.95);
      expect(f, `${pieces} slabs`).toBeLessThan(1.03);
    }
  });

  it('and at 60 Hz and 240 Hz', async () => {
    for (const hz of [60, 240]) {
      const f = await slideFraction(16, hz);
      expect(f, `${hz} Hz`).toBeGreaterThan(0.93);
    }
  });
});

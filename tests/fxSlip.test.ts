/**
 * Ground contact and slip (FX-3, FX-4): the lowest point of a shape and the velocity of that point, checked
 * analytically (rolling, spinning on the spot, sliding, tilted shapes) and against the real engine (a ball that
 * is thrown along the floor slips at first and rolls without slipping later).
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, type Quat, type Vec3 } from '../src/core/math';
import { makeShapeSpec } from '../src/model/shapeRegistry';
import { contactSpecOf, groundContact, newGroundContact, type GroundContact } from '../src/render/fx/slip';
import { newTrailPlan, planTrail, BODY_SLIP, DUST_SPEED, SMOKE_SLIP, WHEEL_SLIP } from '../src/render/fx/trails';
import { surfaceFor } from '../src/render/fx/surfaces';
import { createBody, run, worldOf } from './helpers';

const ID: Quat = [0, 0, 0, 1];

function contact(
  shapeType: string,
  size: Vec3,
  p: Vec3,
  q: Quat,
  v: Vec3,
  w: Vec3,
  floorY = 0,
  tol = 0.05,
): GroundContact {
  const spec = contactSpecOf(makeShapeSpec(shapeType, size));
  return groundContact(
    spec,
    p[0],
    p[1],
    p[2],
    q[0],
    q[1],
    q[2],
    q[3],
    v[0],
    v[1],
    v[2],
    w[0],
    w[1],
    w[2],
    floorY,
    tol,
    newGroundContact(),
  );
}

describe('slip speed of the lowest point', () => {
  const r = 0.5;
  const ball = (v: Vec3, w: Vec3, y = r) => contact('sphere', [1, 1, 1], [0, y, 0], ID, v, w);

  it('a ball rolling without slipping has no slip: ω·r = v', () => {
    const c = ball([5, 0, 0], [0, 0, -5 / r]);
    expect(c.touching).toBe(true);
    expect(c.slip).toBeCloseTo(0, 6);
    expect(c.speed).toBeCloseTo(5, 6);
    const diag = ball([3, 0, 4], [4 / r, 0, -3 / r]); // rolling in the (3, 4) direction
    expect(diag.slip).toBeCloseTo(0, 6);
  });

  it('a ball spinning on the spot slips at ω·r (a burnout)', () => {
    const c = ball([0, 0, 0], [0, 0, -12]);
    expect(c.slip).toBeCloseTo(12 * r, 6);
    expect(c.speed).toBe(0);
  });

  it('a locked or sliding body slips at its own speed; over-spinning adds to it', () => {
    expect(ball([6, 0, 0], [0, 0, 0]).slip).toBeCloseTo(6, 6);
    // driven faster than it moves: v = 4, ω·r = 10 → slip 6, in the direction the surface moves relative to the ground
    expect(ball([4, 0, 0], [0, 0, -20]).slip).toBeCloseTo(6, 6);
    // braking hard while rolling: ω·r = 1 < v = 4 → slip 3
    expect(ball([4, 0, 0], [0, 0, -2]).slip).toBeCloseTo(3, 6);
  });

  it('reports the contact point and clearance; a body in the air is not touching and does not slip', () => {
    const c = ball([5, 0, 0], [0, 0, 0], 0.5);
    expect(c.y).toBeCloseTo(0, 9);
    expect(c.clearance).toBeCloseTo(0, 9);
    const air = ball([5, 0, 0], [0, 0, 0], 1.5);
    expect(air.touching).toBe(false);
    expect(air.clearance).toBeCloseTo(1, 9);
    expect(air.slip).toBe(0);
  });

  it('a wheel (cylinder on its side) rolls without slip at ω·r = v and its contact is on the rim', () => {
    const q = qfromAxisAngle([1, 0, 0], Math.PI / 2); // axle along z
    const wheelR = 0.36;
    const c = contact('cylinder', [wheelR * 2, 0.3, wheelR * 2], [0, wheelR, 0], q, [8, 0, 0], [0, 0, -8 / wheelR]);
    expect(c.touching).toBe(true);
    expect(c.y).toBeCloseTo(0, 6);
    expect(c.slip).toBeCloseTo(0, 5);
    // wheelspin: the engine drives it to ω·r = 12 while the car does 8 m/s: slip 4
    expect(
      contact('cylinder', [wheelR * 2, 0.3, wheelR * 2], [0, wheelR, 0], q, [8, 0, 0], [0, 0, -12 / wheelR]).slip,
    ).toBeCloseTo(4, 5);
    // a locked wheel slides at the car's speed
    expect(
      contact('cylinder', [wheelR * 2, 0.3, wheelR * 2], [0, wheelR, 0], q, [8, 0, 0], [0, 0, 0]).slip,
    ).toBeCloseTo(8, 5);
  });

  it('a cylinder standing on its end touches with its cap; a tilted box touches with its lowest corner', () => {
    const stand = contact('cylinder', [1, 2, 1], [0, 1, 0], ID, [3, 0, 0], [0, 0, 0]);
    expect(stand.touching).toBe(true);
    expect(stand.y).toBeCloseTo(0, 9);
    // a unit box turned 45° about z balances on an edge: centre height √2/2
    const q = qfromAxisAngle([0, 0, 1], Math.PI / 4);
    const box = contact('box', [1, 1, 1], [0, Math.SQRT1_2, 0], q, [0, 0, 0], [0, 0, 0]);
    expect(box.y).toBeCloseTo(0, 6);
    expect(box.touching).toBe(true);
    // lifted by 1 cm it is still within the tolerance; by 20 cm it is not
    expect(contact('box', [1, 1, 1], [0, Math.SQRT1_2 + 0.01, 0], q, [0, 0, 0], [0, 0, 0]).touching).toBe(true);
    expect(contact('box', [1, 1, 1], [0, Math.SQRT1_2 + 0.2, 0], q, [0, 0, 0], [0, 0, 0]).touching).toBe(false);
  });

  it('a capsule lying down and a cone on its base find their lowest points', () => {
    const lying = contact(
      'capsule',
      [0.4, 1.6, 0.4],
      [0, 0.2, 0],
      qfromAxisAngle([0, 0, 1], Math.PI / 2),
      [0, 0, 0],
      [0, 0, 0],
    );
    expect(lying.y).toBeCloseTo(0, 9);
    const standing = contact('capsule', [0.4, 1.6, 0.4], [0, 0.8, 0], ID, [0, 0, 0], [0, 0, 0]);
    expect(standing.y).toBeCloseTo(0, 9);
    const cone = contact('cone', [1, 1.2, 1], [0, 0.6, 0], ID, [0, 0, 0], [0, 0, 0]);
    expect(cone.y).toBeCloseTo(0, 9); // base down
    const flipped = contact('cone', [1, 1.2, 1], [0, 0.6, 0], qfromAxisAngle([1, 0, 0], Math.PI), [0, 0, 0], [0, 0, 0]);
    expect(flipped.y).toBeCloseTo(0, 9); // tip down
  });

  it('respects the floor height', () => {
    const c = contact('sphere', [1, 1, 1], [0, 3.5, 0], ID, [2, 0, 0], [0, 0, 0], 3);
    expect(c.touching).toBe(true);
    expect(c.clearance).toBeCloseTo(0, 9);
  });
});

describe('slip against the engine', () => {
  it('a ball thrown along the floor slips at its throw speed, then rolls: the estimate falls to ~0', async () => {
    const b = createBody({
      shape: { type: 'sphere', size: [0.6, 0.6, 0.6] },
      position: [0, 0.3, 0],
      velocity: [6, 0, 0],
      material: { preset: 'rubber', friction: 0.8, restitution: 0 },
      canSleep: false,
      linearDamping: 0,
      angularDamping: 0,
    });
    const w = await worldOf([b]);
    const spec = contactSpecOf(b.shape);
    const out = newGroundContact();
    const slipAt = (): number => {
      const p = w.getPose(b.id)!;
      groundContact(spec, ...p.position, ...p.rotation, ...p.linvel, ...p.angvel, 0, 0.05, out);
      return out.slip;
    };
    run(w, 0.05);
    expect(slipAt()).toBeGreaterThan(4); // starts sliding at ≈ 6 m/s and friction has barely begun to spin it
    run(w, 3);
    const p = w.getPose(b.id)!;
    expect(p.linvel[0]).toBeGreaterThan(2); // still rolling along
    expect(slipAt()).toBeLessThan(0.15); // rolling without slipping (ω·r = v)
  });

  it('a box pushed along the floor slips at its speed all the way, a wheel-like cylinder does not', async () => {
    const box = createBody({
      shape: { type: 'box', size: [0.6, 0.6, 0.6] },
      position: [0, 0.3, 0],
      velocity: [5, 0, 0],
      material: { preset: 'wood', friction: 0.3 },
      canSleep: false,
    });
    const w = await worldOf([box]);
    const spec = contactSpecOf(box.shape);
    const out = newGroundContact();
    run(w, 0.3);
    const p = w.getPose(box.id)!;
    groundContact(spec, ...p.position, ...p.rotation, ...p.linvel, ...p.angvel, 0, 0.05, out);
    expect(out.touching).toBe(true);
    expect(out.slip).toBeCloseTo(out.speed, 1);
    expect(out.slip).toBeGreaterThan(2);
  });
});

describe('what a contact leaves behind', () => {
  const touch = (slip: number, speed = slip, touching = true): GroundContact => ({
    ...newGroundContact(),
    touching,
    slip,
    speed,
  });
  const wheel = { wheel: true, surface: surfaceFor('rubber'), width: 0.3, size: 0.7 };
  const crate = { wheel: false, surface: surfaceFor('wood'), width: 0.4, size: 0.6 };

  it('nothing in the air, nothing when rolling gently', () => {
    expect(planTrail(touch(9, 9, false), wheel, newTrailPlan())).toEqual({
      skid: 0,
      tone: 0,
      smoke: 0,
      sparks: 0,
      dust: 0,
    });
    const p = planTrail(touch(0.2, 2), wheel, newTrailPlan());
    expect(p.skid).toBe(0);
    expect(p.smoke).toBe(0);
    expect(p.dust).toBe(0);
  });

  it('a wheel marks the ground sooner than a sliding body; rubber leaves dark marks, steel pale ones', () => {
    const slip = (WHEEL_SLIP + BODY_SLIP) / 2;
    expect(planTrail(touch(slip, 4), wheel, newTrailPlan()).skid).toBeGreaterThan(0);
    expect(planTrail(touch(slip, 4), crate, newTrailPlan()).skid).toBe(0);
    expect(planTrail(touch(8, 8), crate, newTrailPlan()).skid).toBeGreaterThan(0);
    const dark = planTrail(touch(8), wheel, newTrailPlan());
    const pale = planTrail(touch(8), { ...crate, surface: surfaceFor('steel') }, newTrailPlan());
    expect(dark.tone).toBeLessThan(pale.tone);
    expect(dark.skid).toBeGreaterThan(pale.skid);
    // ice and glass leave no mark at all
    expect(planTrail(touch(9), { ...crate, surface: surfaceFor('ice') }, newTrailPlan()).skid).toBe(0);
  });

  it('tyre smoke starts at the smoke limit and grows with the slip; only wheels and rubber smoke', () => {
    expect(planTrail(touch(SMOKE_SLIP - 0.5, 6), wheel, newTrailPlan()).smoke).toBe(0);
    const a = planTrail(touch(SMOKE_SLIP + 1, 6), wheel, newTrailPlan()).smoke;
    const b = planTrail(touch(SMOKE_SLIP + 8, 6), wheel, newTrailPlan()).smoke;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(planTrail(touch(9), crate, newTrailPlan()).smoke).toBe(0);
  });

  it('grinding metal throws sparks; dust trails need ground speed, not slip', () => {
    const steel = { wheel: false, surface: surfaceFor('steel'), width: 0.3, size: 0.5 };
    expect(planTrail(touch(9), steel, newTrailPlan()).sparks).toBeGreaterThan(0);
    expect(planTrail(touch(9), crate, newTrailPlan()).sparks).toBe(0);
    expect(planTrail(touch(0, DUST_SPEED - 1), wheel, newTrailPlan()).dust).toBe(0);
    expect(planTrail(touch(0, DUST_SPEED + 6), wheel, newTrailPlan()).dust).toBeGreaterThan(0);
  });
});

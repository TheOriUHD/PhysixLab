import { describe, expect, it } from 'vitest';
import {
  G0,
  dampedPeriod,
  dampingFromRatio,
  dampingRatio,
  densityFromMass,
  dragCoefficient,
  dragForTerminalVelocity,
  fallSpeedAt,
  launchAngles,
  launchVelocity,
  massFromDensity,
  momentsOfInertia,
  naturalFrequency,
  pendulumLength,
  pendulumPeriod,
  projectile,
  reducedMass,
  springConstantFromFrequency,
  springConstantFromPeriod,
  terminalVelocity,
} from '../src/ui/inspector/upgrades/calculators';
import { ALL_GROUPS, captureProps, sanitizeSnapshot, snapshotPatch } from '../src/ui/inspector/upgrades/props';
import { createBody, createJoint, run, worldOf } from './helpers';
import { shapeVolume } from '../src/model/shapeRegistry';
import { naturalMass } from '../src/model/compound';

describe('calculator formulas (analytic)', () => {
  it('mass and density are inverse', () => {
    expect(massFromDensity(7850, 0.001)).toBeCloseTo(7.85, 12);
    expect(densityFromMass(7.85, 0.001)).toBeCloseTo(7850, 9);
    expect(densityFromMass(1, 0)).toBeNaN();
  });

  it('spring constant from period / frequency', () => {
    // m = 2 kg, T = 1 s: k = 4 pi² m
    expect(springConstantFromPeriod(2, 1)).toBeCloseTo(8 * Math.PI ** 2, 10);
    expect(springConstantFromFrequency(2, 1)).toBeCloseTo(8 * Math.PI ** 2, 10);
    const k = springConstantFromPeriod(3, 0.5);
    expect(1 / naturalFrequency(k, 3)).toBeCloseTo(0.5, 12);
    expect(reducedMass(2, 2)).toBe(1);
    expect(reducedMass(0, 5)).toBe(5);
  });

  it('damping ratio: critical damping is c = 2√(km)', () => {
    expect(dampingRatio(2 * Math.sqrt(100 * 4), 100, 4)).toBeCloseTo(1, 12);
    expect(dampingFromRatio(0.3, 100, 4)).toBeCloseTo(0.6 * 20, 12);
    expect(dampingRatio(dampingFromRatio(0.42, 55, 3), 55, 3)).toBeCloseTo(0.42, 12);
    // T_d = T / sqrt(1-z²)
    expect(dampedPeriod(100, 1, 0.6)).toBeCloseTo((2 * Math.PI) / 10 / 0.8, 12);
    expect(dampedPeriod(100, 1, 1)).toBeNaN();
  });

  it('terminal velocity v = sqrt(2mg/(ρ Cd A)); round trip with the drag coefficient', () => {
    // 80 kg skydiver: Cd 1.0, A 0.7 m², sea level air -> about 43 m/s (154 km/h)
    const c = dragCoefficient(1.225, 1.0, 0.7);
    const vt = terminalVelocity(80, G0, c);
    expect(vt).toBeCloseTo(Math.sqrt((2 * 80 * G0) / (1.225 * 1.0 * 0.7)), 10);
    expect(vt).toBeGreaterThan(42);
    expect(vt).toBeLessThan(44);
    expect(dragForTerminalVelocity(80, G0, vt)).toBeCloseTo(c, 10);
    // at v = vt the drag force balances the weight
    expect(c * vt * vt).toBeCloseTo(80 * G0, 8);
    // fall speed approaches vt
    expect(fallSpeedAt(vt, G0, 100)).toBeCloseTo(vt, 6);
    expect(fallSpeedAt(vt, G0, 0.01)).toBeCloseTo(G0 * 0.01, 4);
    expect(terminalVelocity(1, 9.81, 0)).toBeNaN();
  });

  it('projectile range: level ground v² sin 2θ / g, and a numeric integration for a raised launch', () => {
    const p = projectile(20, Math.PI / 4, 0, G0);
    expect(p.range).toBeCloseTo((20 * 20) / G0, 10);
    expect(p.time).toBeCloseTo((2 * 20 * Math.sin(Math.PI / 4)) / G0, 10);
    expect(p.apex).toBeCloseTo((20 * Math.sin(Math.PI / 4)) ** 2 / (2 * G0), 10);
    // 45° maximises the range on level ground
    expect(projectile(20, 0.6, 0, G0).range).toBeLessThan(p.range);
    expect(projectile(20, 1.0, 0, G0).range).toBeLessThan(p.range);
    // raised launch, numeric semi-implicit integration with a tiny step
    const th = 0.5,
      v = 15,
      h0 = 12;
    const vx = v * Math.cos(th);
    let x = 0,
      y = h0,
      vy = v * Math.sin(th);
    const dt = 1e-5;
    while (y > 0) {
      vy -= G0 * dt;
      x += vx * dt;
      y += vy * dt;
    }
    expect(projectile(v, th, h0, G0).range).toBeCloseTo(x, 2);
    // a launch downward from the ground never lands "later"
    expect(projectile(10, -0.5, 0, G0).range).toBeCloseTo(0, 9);
    expect(projectile(10, 0.5, 0, 0).range).toBeNaN();
  });

  it('launch angle conversion round-trips', () => {
    const a = launchAngles([3, 4, 12]);
    expect(a.speed).toBeCloseTo(13, 12);
    const back = launchVelocity(a.speed, a.elevation, a.heading);
    expect(back[0]).toBeCloseTo(3, 12);
    expect(back[1]).toBeCloseTo(4, 12);
    expect(back[2]).toBeCloseTo(12, 12);
  });

  it('pendulum period: 2π√(L/g), exact large-angle series, inverse', () => {
    expect(pendulumPeriod(1, G0)).toBeCloseTo(2.006409, 5);
    const L = pendulumLength(1, G0);
    expect(L).toBeCloseTo(0.248, 3);
    expect(pendulumPeriod(L, G0)).toBeCloseTo(1, 12);
    // amplitude 60°: T/T0 = 1.07318 (elliptic integral)
    expect(pendulumPeriod(2, G0, Math.PI / 3) / pendulumPeriod(2, G0)).toBeCloseTo(1.07318, 4);
    // amplitude 90°: 1.18034
    expect(pendulumPeriod(2, G0, Math.PI / 2) / pendulumPeriod(2, G0)).toBeCloseTo(1.18034, 4);
    // tiny amplitudes agree with the small-angle value
    expect(pendulumPeriod(2, G0, 0.01) / pendulumPeriod(2, G0)).toBeCloseTo(1 + 0.01 ** 2 / 16, 8);
    expect(pendulumPeriod(-1, G0)).toBeNaN();
  });

  it('moment of inertia of a box, sphere and cylinder', () => {
    // unit cube of mass 6: I = m/6 * a² = 1
    const box = momentsOfInertia(6, { type: 'box', size: [1, 1, 1] });
    expect(box.exact).toBe(true);
    expect(box.moments.every((m) => Math.abs(m - 1) < 1e-12)).toBe(true);
    // box 2 x 1 x 3 (full extents): Ix = m/12 (1 + 9)
    expect(momentsOfInertia(12, { type: 'box', size: [2, 1, 3] }).moments).toEqual([10, 13, 5].map((x) => x));
    // sphere radius 0.5, m = 10: 2/5 m r²
    const sph = momentsOfInertia(10, { type: 'sphere', size: [1, 1, 1] });
    expect(sph.moments[0]).toBeCloseTo(1, 12);
    expect(sph.moments[1]).toBeCloseTo(1, 12);
    // cylinder r = 1, h = 2, m = 12: Iy = m r²/2 = 6, Ix = m(3r²+h²)/12 = 7
    const cyl = momentsOfInertia(12, { type: 'cylinder', size: [2, 2, 2] });
    expect(cyl.moments[1]).toBeCloseTo(6, 12);
    expect(cyl.moments[0]).toBeCloseTo(7, 12);
    expect(cyl.moments[2]).toBeCloseTo(7, 12);
    expect(momentsOfInertia(1, { type: 'cone', size: [1, 1, 1] }).exact).toBe(false);
  });
});

describe('calculators against the real engine', () => {
  const noDamp = { linearDamping: 0, angularDamping: 0, canSleep: false };

  it('quadratic drag from the calculator gives the predicted terminal velocity', async () => {
    const ball = createBody({
      shape: { type: 'sphere', size: [0.4, 0.4, 0.4] },
      position: [0, 900, 0],
      material: { preset: 'custom', density: 800 },
      ...noDamp,
    });
    const m = naturalMass(ball);
    const vt = 12;
    const c = dragForTerminalVelocity(m, 9.81, vt);
    const body = { ...ball, drag: { linear2: c, angular2: 0 } };
    const w = await worldOf([body], { gravity: [0, -9.81, 0] });
    run(w, 12);
    const speed = -w.getPose(body.id)!.linvel[1];
    expect(speed).toBeGreaterThan(vt * 0.97);
    expect(speed).toBeLessThan(vt * 1.03);
    // and the physical coefficient c = ½ ρ Cd A gives sqrt(m g / c)
    const c2 = dragCoefficient(1.225, 0.47, (Math.PI / 4) * 0.4 * 0.4);
    const expected = terminalVelocity(m, 9.81, c2);
    const high = { ...ball, position: [0, 5000, 0] as [number, number, number], drag: { linear2: c2, angular2: 0 } };
    const w2 = await worldOf([high], { gravity: [0, -9.81, 0] });
    run(w2, 25);
    const v2 = -w2.getPose(ball.id)!.linvel[1];
    expect(Math.abs(v2 - expected) / expected).toBeLessThan(0.02);
  });

  it('a spring built with k from the calculator oscillates with the requested period', async () => {
    const m = 2;
    const T = 0.8;
    const bob = createBody({
      shape: { type: 'box', size: [0.4, 0.4, 0.4] },
      position: [2, 5, 0],
      massOverride: m,
      ...noDamp,
      gravityScale: 0,
    });
    const spring = createJoint({
      type: 'spring',
      bodyA: null,
      bodyB: bob.id,
      anchorA: [0, 5, 0],
      anchorB: [0, 0, 0],
      spring: { restLength: 1, stiffness: springConstantFromPeriod(m, T), damping: 0, breakForce: 0 },
    });
    const w = await worldOf([bob, spring], { gravity: [0, 0, 0] });
    const hz = w.settings.physicsHz;
    const xs: number[] = [];
    for (let i = 0; i < hz * 4; i++) {
      w.stepOnce();
      xs.push(w.getPose(bob.id)!.position[0]);
    }
    const t: number[] = [];
    for (let i = 1; i < xs.length; i++) if (xs[i - 1] - 1 > 0 && xs[i] - 1 <= 0) t.push(i / hz);
    expect(t.length).toBeGreaterThanOrEqual(3);
    const period = (t[t.length - 1] - t[0]) / (t.length - 1);
    expect(Math.abs(period - T) / T).toBeLessThan(0.03);
  });
});

describe('body property snapshots', () => {
  it('captures, patches and keeps unrelated fields', () => {
    const a = createBody({
      shape: { type: 'sphere', size: [1, 1, 1] },
      material: 'rubber',
      linearDamping: 0.5,
      velocity: [1, 2, 3],
    });
    const b = createBody({ shape: { type: 'box', size: [1, 1, 1] }, material: 'steel' });
    const snap = captureProps(a);
    expect(Object.keys(snap).sort()).toEqual([...ALL_GROUPS].sort());
    const patch = snapshotPatch(snap, b);
    expect(patch.material?.density).toBe(a.material.density);
    expect(patch.material?.color).toBe(a.material.color);
    expect(patch.linearDamping).toBe(0.5);
    expect(patch.velocity).toEqual([1, 2, 3]);
    expect('shape' in patch).toBe(false);
    expect('position' in patch).toBe(false);
    // only chosen groups
    const some = snapshotPatch(snap, b, ['damping']);
    expect(Object.keys(some).sort()).toContain('linearDamping');
    expect('material' in some).toBe(false);
    // patch does not alias the snapshot
    (patch.velocity as number[])[0] = 99;
    expect(snap.motion?.velocity).toEqual([1, 2, 3]);
  });

  it('pasting "no mass override" clears an override, and survives sanitising', () => {
    const a = createBody({ shape: { type: 'box', size: [1, 1, 1] } });
    const b = createBody({ shape: { type: 'box', size: [1, 1, 1] }, massOverride: 40 });
    const patch = snapshotPatch(sanitizeSnapshot(JSON.parse(JSON.stringify(captureProps(a)))), b, ['damping']);
    expect('massOverride' in patch).toBe(true);
    expect(patch.massOverride).toBeUndefined();
    const keep = snapshotPatch(captureProps(b), a, ['damping']);
    expect(keep.massOverride).toBe(40);
  });

  it('sanitising drops junk and clamps numbers', () => {
    const s = sanitizeSnapshot({
      appearance: { color: 'red', metalness: 7, roughness: -1 },
      motion: { velocity: [1, 2], angularVelocity: [1e9, 0, 0] },
      thruster: { thrust: { force: [0, 1, 0], torque: [0, 0, 0], mode: 'sideways', key: 'x' } },
      locks: { lockPosition: [true, 1, false], ccd: true, ghost: 'yes' },
      __proto__: { x: 1 },
    });
    expect(s.appearance).toEqual({ metalness: 1, roughness: 0 });
    expect(s.motion).toEqual({ angularVelocity: [1e4, 0, 0] });
    expect(s.thruster).toBeUndefined();
    expect(s.locks).toEqual({ ccd: true });
    expect(sanitizeSnapshot('x')).toEqual({});
    expect(shapeVolume({ type: 'box', size: [1, 2, 3] })).toBe(6);
  });
});

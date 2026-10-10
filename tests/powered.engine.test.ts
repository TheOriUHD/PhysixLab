/** CP-1 — the engine: torque curve → acceleration, rev limiter, throttle, driving a hinge. */
import { describe, expect, it } from 'vitest';
import { toRpm } from '../src/physics/components/powered/common';
import { run, worldOf } from './helpers';
import { anchor, comp, cube, hinge, NO_G, stateOf, withComponents } from './poweredHelpers';

const FLAT = (t: number): [number, number][] => [
  [0, t],
  [12000, t],
];

describe('engine', () => {
  it('a free engine revs up at α = T / I (flat 100 N·m curve, 0.25 kg·m² flywheel → 400 rad/s²)', async () => {
    const e = comp('engine', { curve: FLAT(100), idle: 0, revLimit: 12000, inertia: 0.25, throttle: 1, response: 0 });
    const body = withComponents(cube(1), e);
    const w = await worldOf([body], NO_G);
    run(w, 0.5);
    const [rpm, torque, thr, kw] = stateOf(w, e.id);
    expect(torque).toBeCloseTo(100, 6);
    expect(thr).toBeCloseTo(100, 6);
    expect(rpm).toBeCloseTo(toRpm(400 * 0.5), 0); // 200 rad/s = 1909.9 rpm (one step of lag at most)
    expect(kw).toBeCloseTo((100 * 200) / 1000, 0);
  });

  it('follows the torque curve: the speed at which two throttle levels differ is set by the curve, not by the code', async () => {
    // torque 50 below 600 rpm, 200 above: accelerate 4× faster once past 600 rpm
    const curve: [number, number][] = [
      [0, 50],
      [599, 50],
      [601, 200],
      [12000, 200],
    ];
    const e = comp('engine', { curve, idle: 0, revLimit: 12000, inertia: 1, throttle: 1, response: 0 });
    const w = await worldOf([withComponents(cube(1), e)], NO_G);
    run(w, 0.1);
    const w1 = stateOf(w, e.id)[0];
    expect(toRpm(50 * 0.1)).toBeCloseTo(47.7, 0); // 5 rad/s
    expect(w1).toBeCloseTo(47.7, 0);
    run(w, 1);
    const rpmA = stateOf(w, e.id)[0];
    // 0.1 s at 50 N·m → 5 rad/s (47.7 rpm); reaching 600 rpm (62.8 rad/s) takes 1.156 s; after 1.1 s still below
    expect(rpmA).toBeLessThan(600);
    run(w, 0.5);
    const rpmB = stateOf(w, e.id)[0];
    expect(rpmB).toBeGreaterThan(600); // now accelerating at 200 rad/s²
    run(w, 0.25);
    const rpmC = stateOf(w, e.id)[0];
    expect(rpmC - rpmB).toBeGreaterThan(toRpm(200 * 0.25) * 0.9);
  });

  it('the rev limiter caps the speed, and closing the throttle brakes the engine', async () => {
    const e = comp('engine', { idle: 500, revLimit: 4000, inertia: 0.1, braking: 80, key: 'KeyW', response: 0 });
    const w = await worldOf([withComponents(cube(1), e)], NO_G);
    w.setKeys(['KeyW']);
    run(w, 3);
    const top = stateOf(w, e.id)[0];
    expect(top).toBeLessThanOrEqual(4001);
    expect(top).toBeGreaterThan(3700); // the fuel-cut ramp spans the last 150 rpm
    w.setKeys([]);
    run(w, 0.4);
    expect(stateOf(w, e.id)[0]).toBeLessThan(top * 0.6); // engine braking
  });

  it('the idle governor keeps the engine from stalling at closed throttle', async () => {
    const e = comp('engine', { idle: 900, revLimit: 6800, key: 'KeyW', response: 0 });
    const w = await worldOf([withComponents(cube(1), e)], NO_G);
    run(w, 4);
    const rpm = stateOf(w, e.id)[0];
    expect(rpm).toBeGreaterThan(800);
    expect(rpm).toBeLessThanOrEqual(905);
  });

  it('on a hinge it drives the wheel: α = T / (I_wheel + I_flywheel), and the reaction goes to the other body', async () => {
    const base = anchor();
    const wheel = cube(6); // I = 6/6 = 1 kg·m² about its axis
    const j = withComponents(
      hinge(base, wheel),
      comp('engine', { curve: FLAT(50), idle: 0, revLimit: 12000, inertia: 0.5, throttle: 1, response: 0, ratio: 1 }),
    );
    const w = await worldOf([base, wheel, j], NO_G);
    run(w, 0.6);
    const alpha = 50 / (1 + 0.5);
    const pose = w.getPose(wheel.id)!;
    expect(pose.angvel[2]).toBeCloseTo(alpha * 0.6, 2); // 20 rad/s
    expect(w.getJointRec(j.id)!.speed).toBeCloseTo(alpha * 0.6, 2);
  });

  it('a 3:1 reduction multiplies the torque and divides the speed (flywheel reflected through the gear)', async () => {
    const base = anchor();
    const wheel = cube(6);
    const j = withComponents(
      hinge(base, wheel),
      comp('engine', { curve: FLAT(10), idle: 0, revLimit: 12000, inertia: 0.5, throttle: 1, response: 0, ratio: 3 }),
    );
    const w = await worldOf([base, wheel, j], NO_G);
    run(w, 0.5);
    // τ_wheel = 3·T, effective inertia at the wheel = I_wheel + 9·I_fly
    const alpha = (3 * 10) / (1 + 9 * 0.5);
    expect(w.getPose(wheel.id)!.angvel[2]).toBeCloseTo(alpha * 0.5, 2);
  });
});

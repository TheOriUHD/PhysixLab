/** CP-2 / CP-3 — electric motor, servo, stepper, linear actuator and hydraulic cylinder against analytic results. */
import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/math';
import { createBody, createJoint, run, worldOf } from './helpers';
import { anchor, comp, cube, DT, hinge, NO_G, stateOf, withComponents } from './poweredHelpers';

const G = 9.81;

describe('electric motor', () => {
  it('the speed approaches the no-load speed exponentially: ω(t) = ω0·(1 − e^(−t/τ)), τ = I·ω0 / T_stall', async () => {
    const base = anchor();
    const wheel = cube(0.6); // I = 0.1 kg·m²
    const m = comp('motor', {
      stallTorque: 10,
      noLoadRpm: (60 * 60) / (2 * Math.PI),
      currentLimit: 1000,
      inertia: 0.002,
      duty: 1,
    });
    const j = withComponents(hinge(base, wheel), m);
    const w = await worldOf([base, wheel, j], NO_G);
    const tau = ((0.1 + 0.002) * 60) / 10; // 0.612 s
    run(w, tau);
    expect(w.getPose(wheel.id)!.angvel[2]).toBeCloseTo(60 * (1 - Math.exp(-1)), 0); // 37.9 rad/s
    run(w, 6 * tau);
    expect(w.getPose(wheel.id)!.angvel[2]).toBeGreaterThan(59.8);
    expect(w.getPose(wheel.id)!.angvel[2]).toBeLessThan(60.01);
  });

  it('the supply limit caps the torque: constant acceleration T_max / I until the droop takes over', async () => {
    const base = anchor();
    const wheel = cube(0.6);
    // droop alone would give 10·(1 − ω/60) → 2 N·m only above 48 rad/s; below that the 2 N·m supply cap rules
    const m = comp('motor', { stallTorque: 10, noLoadRpm: 572.96, currentLimit: 2, inertia: 0.002, duty: 1 });
    const w = await worldOf([base, wheel, withComponents(hinge(base, wheel), m)], NO_G);
    run(w, 1);
    expect(w.getPose(wheel.id)!.angvel[2]).toBeCloseTo(2 / 0.102, 1); // 19.6 rad/s after 1 s
    expect(stateOf(w, m.id)[1]).toBeCloseTo(2, 3);
  });

  it('the drive command comes from keys and analog axes; half drive settles at half the no-load speed', async () => {
    const base = anchor();
    const wheel = cube(0.6);
    const m = comp('motor', {
      stallTorque: 10,
      noLoadRpm: 572.96,
      currentLimit: 1000,
      key: 'KeyD',
      keyReverse: 'KeyA',
      axis: 'steer',
    });
    const w = await worldOf([base, wheel, withComponents(hinge(base, wheel), m)], NO_G);
    run(w, 1);
    expect(Math.abs(w.getPose(wheel.id)!.angvel[2])).toBeLessThan(0.2); // no command → shorted → stays still
    w.setAxes({ steer: 0.5 });
    run(w, 6);
    expect(w.getPose(wheel.id)!.angvel[2]).toBeCloseTo(30, 0);
    w.setAxes({});
    w.setKeys(['KeyA']);
    run(w, 8);
    expect(w.getPose(wheel.id)!.angvel[2]).toBeCloseTo(-60, 0);
  });

  it('coasting versus braking at zero drive', async () => {
    const make = async (idle: string) => {
      const base = anchor();
      const wheel = cube(0.6, { angularVelocity: [0, 0, 50] });
      const m = comp('motor', { stallTorque: 10, noLoadRpm: 572.96, currentLimit: 1000, duty: 0, idle });
      const w = await worldOf([base, wheel, withComponents(hinge(base, wheel), m)], NO_G);
      run(w, 0.5);
      return w.getPose(wheel.id)!.angvel[2];
    };
    expect(await make('coast')).toBeGreaterThan(49.9);
    expect(await make('brake')).toBeLessThan(35); // τ = 0.61 s → e^(−0.5/0.61) = 0.44 → 22 rad/s
  });
});

describe('servo', () => {
  const arm = (maxTorque: number, extra: Record<string, number | string> = {}) => {
    const base = anchor();
    // a cube whose centre is 1 m from the hinge: gravity torque m·g·L = 6·9.81·1 = 58.9 N·m about the hinge
    const link = cube(6, { position: [1, 0, 0] });
    const s = comp('servo', { target: 45, maxTorque, ...extra });
    const j = withComponents(hinge(base, link, { anchorA: [0, 0, 0] }), s);
    return { base, link, s, j };
  };

  it('reaches its target angle (PID position control) and stops there', async () => {
    const { base, link, s, j } = arm(200);
    const w = await worldOf([base, link, j], NO_G);
    run(w, 2.5);
    const [angle, target, speed] = stateOf(w, s.id);
    expect(target).toBeCloseTo(45, 6);
    expect(Math.abs(angle - 45)).toBeLessThan(0.5);
    expect(Math.abs(speed)).toBeLessThan(1);
    expect(Math.abs(w.getJointRec(j.id)!.value / DEG - 45)).toBeLessThan(0.5);
  });

  it('never exceeds its speed cap, and takes distance ÷ cap to get there', async () => {
    const { base, link, s, j } = arm(500, { target: 90, maxSpeed: 60, kp: 50 });
    const w = await worldOf([base, link, j], NO_G);
    let peak = 0;
    for (let i = 0; i < 360; i++) {
      w.stepOnce();
      peak = Math.max(peak, Math.abs(w.getJointRec(j.id)!.speed) / DEG);
    }
    expect(peak).toBeLessThanOrEqual(60.5);
    expect(peak).toBeGreaterThan(55);
    // 90° at 60 °/s: at least 1.5 s
    const a = stateOf(w, s.id)[0];
    expect(a).toBeGreaterThan(89); // after 3 s it has arrived
  });

  it('holds against gravity within its torque limit and sags when the load exceeds it', async () => {
    const strong = arm(100, { target: 0 });
    const w1 = await worldOf([strong.base, strong.link, strong.j], { ...NO_G, gravity: [0, -G, 0] });
    run(w1, 3);
    expect(Math.abs(stateOf(w1, strong.s.id)[0])).toBeLessThan(1.5); // 58.9 N·m of load, 100 N·m available
    const weak = arm(30, { target: 0 });
    const w2 = await worldOf([weak.base, weak.link, weak.j], { ...NO_G, gravity: [0, -G, 0] });
    let lowest = 0;
    for (let i = 0; i < 360; i++) {
      w2.stepOnce();
      lowest = Math.min(lowest, w2.getJointRec(weak.j.id)!.value / DEG);
    }
    expect(lowest).toBeLessThan(-60); // 30 N·m cannot hold 58.9 N·m: the arm swings down past its balance point
  });

  it('jog keys move the target and an analog axis maps onto the travel range', async () => {
    const { base, link, s, j } = arm(300, { target: 0, keyPlus: 'KeyL', keyMinus: 'KeyJ', jogRate: 30 });
    const w = await worldOf([base, link, j], NO_G);
    w.setKeys(['KeyL']);
    run(w, 1);
    w.setKeys([]);
    run(w, 1);
    expect(stateOf(w, s.id)[1]).toBeCloseTo(30, 0); // 30 °/s for 1 s
    expect(Math.abs(stateOf(w, s.id)[0] - 30)).toBeLessThan(1);
    const b = arm(300, { axis: 'pan', minAngle: -60, maxAngle: 60 });
    const w2 = await worldOf([b.base, b.link, b.j], NO_G);
    w2.setAxes({ pan: 0.5 });
    run(w2, 2.5);
    expect(Math.abs(stateOf(w2, b.s.id)[0] - 30)).toBeLessThan(0.8); // 0.5 → 30° of ±60°
  });

  it('is clamped to its travel range', async () => {
    const { base, link, s, j } = arm(300, { target: 170, minAngle: -20, maxAngle: 50 });
    const w = await worldOf([base, link, j], NO_G);
    run(w, 3);
    expect(stateOf(w, s.id)[0]).toBeCloseTo(50, 0);
  });
});

describe('stepper', () => {
  const rig = (extra: Record<string, number | string> = {}, density = 0.012) => {
    const base = anchor();
    const rotor = cube(density); // 0.002 kg·m²
    const s = comp('stepper', { stepAngle: 1.8, holdTorque: 2, ...extra });
    const j = withComponents(hinge(base, rotor), s);
    return { base, rotor, s, j };
  };

  it('moves one step per key press and settles on the commanded angle', async () => {
    const { base, rotor, s, j } = rig({ stepKey: 'KeyN' });
    const w = await worldOf([base, rotor, j], NO_G);
    for (let n = 0; n < 5; n++) {
      w.setKeys(['KeyN']);
      run(w, 0.05);
      w.setKeys([]);
      run(w, 0.3);
    }
    const [steps, cmd, angle, lag] = stateOf(w, s.id);
    expect(steps).toBe(5);
    expect(cmd).toBeCloseTo(9, 6);
    expect(angle).toBeCloseTo(9, 1);
    expect(Math.abs(lag)).toBeLessThan(0.05);
  });

  it('a constant pulse train turns at pulses × step angle', async () => {
    const { base, rotor, s, j } = rig({ pulseRate: 100 });
    const w = await worldOf([base, rotor, j], NO_G);
    run(w, 1);
    const [steps, , angle, lag] = stateOf(w, s.id);
    expect(steps).toBeGreaterThanOrEqual(99);
    expect(steps).toBeLessThanOrEqual(101);
    expect(angle).toBeGreaterThan((steps - 2) * 1.8); // the rotor follows the pulses within a step or two
    expect(angle).toBeLessThan(steps * 1.8 + 1.5);
    expect(Math.abs(lag)).toBeLessThan(1.5);
  });

  it('holds a load below its holding torque with the deflection T = T_hold·sin(π/2 · e/step)', async () => {
    const load = 1; // N·m against 2 N·m of holding torque
    const { base, rotor, s, j } = rig({ falloffRate: 1e5 });
    const loaded = { ...rotor, components: [comp('constantForce', { force: [0, 0, 0], torque: [0, 0, load] })] };
    const w = await worldOf([base, loaded, j], NO_G);
    run(w, 2);
    // the rotor sits where the motor's pull equals the load: T_hold·sin(π/2 · e/step) = load  →  e = (2·step/π)·asin(load/hold)
    const e = ((2 * 1.8) / Math.PI) * Math.asin(load / 2);
    expect(stateOf(w, s.id)[2]).toBeCloseTo(e, 2); // 0.6°
  });

  it('cannot start a heavy rotor at a high pulse rate (the pull-in limit): it stalls instead of following', async () => {
    const { base, rotor, s, j } = rig({ pulseRate: 100 }, 0.6); // 0.1 kg·m² against 2 N·m
    const w = await worldOf([base, rotor, j], NO_G);
    run(w, 1);
    const [steps, , angle, lag] = stateOf(w, s.id);
    expect(steps).toBeGreaterThan(95);
    expect(angle).toBeLessThan(steps * 1.8 * 0.5); // far behind the commanded position
    expect(Math.abs(lag)).toBeGreaterThan(20);
  });

  it('loses steps when the load exceeds the holding torque', async () => {
    const { base, rotor, s, j } = rig({ holdTorque: 1 });
    const loaded = { ...rotor, components: [comp('constantForce', { force: [0, 0, 0], torque: [0, 0, 3] })] };
    const w = await worldOf([base, loaded, j], NO_G);
    run(w, 1.5);
    const [steps, , angle, lag] = stateOf(w, s.id);
    expect(steps).toBe(0);
    expect(angle).toBeGreaterThan(20); // the rotor ran away from its commanded position
    expect(Math.abs(lag)).toBeGreaterThan(10);
  });
});

describe('linear actuator', () => {
  /** A platform of mass `mass` on a horizontal (or vertical) slider driven by an actuator. */
  const rig = (mass: number, axis: [number, number, number], extra: Record<string, number | string> = {}) => {
    const base = anchor();
    const platform = cube(mass);
    const a = comp('linearActuator', { target: 0.5, ...extra });
    const j = withComponents(
      createJoint({ type: 'slider', bodyA: base.id, bodyB: platform.id, anchorA: [0, 0, 0], axis }),
      a,
    );
    return { base, platform, a, j };
  };

  it('extends to the target within a few millimetres, no faster than its speed limit', async () => {
    const { base, platform, a, j } = rig(10, [1, 0, 0], { speed: 0.4, force: 500 });
    const w = await worldOf([base, platform, j], NO_G);
    let peak = 0;
    for (let i = 0; i < 360; i++) {
      w.stepOnce();
      peak = Math.max(peak, Math.abs(w.getPose(platform.id)!.linvel[0]));
    }
    expect(peak).toBeLessThanOrEqual(0.41);
    expect(peak).toBeGreaterThan(0.35);
    expect(Math.abs(stateOf(w, a.id)[0] - 0.5)).toBeLessThan(0.005);
    expect(w.getPose(platform.id)!.position[0]).toBeCloseTo(0.5, 2);
  });

  it('cannot exceed its force: a 10 kg load needs 98 N to lift, 50 N is not enough', async () => {
    const lifted = rig(10, [0, 1, 0], { target: 0.3, speed: 1, force: 200 });
    const w1 = await worldOf([lifted.base, lifted.platform, lifted.j], { ...NO_G, gravity: [0, -G, 0] });
    run(w1, 2);
    expect(w1.getPose(lifted.platform.id)!.position[1]).toBeCloseTo(0.3, 1);
    const weak = rig(10, [0, 1, 0], { target: 0.3, speed: 1, force: 50 });
    const w2 = await worldOf([weak.base, weak.platform, weak.j], { ...NO_G, gravity: [0, -G, 0] });
    run(w2, 1);
    expect(w2.getPose(weak.platform.id)!.position[1]).toBeLessThan(-0.5); // it sinks under the load
  });

  it('stops at its travel limits however far it is told to go, and an axis maps onto the range', async () => {
    const r = rig(5, [1, 0, 0], { target: 9, max: 0.6, min: -0.2, force: 1000 });
    const w = await worldOf([r.base, r.platform, r.j], NO_G);
    run(w, 3);
    expect(w.getPose(r.platform.id)!.position[0]).toBeCloseTo(0.6, 2);
    const q = rig(5, [1, 0, 0], { axis: 'reach', max: 1, min: -1, force: 1000 });
    const w2 = await worldOf([q.base, q.platform, q.j], NO_G);
    w2.setAxes({ reach: -0.5 });
    run(w2, 3);
    expect(w2.getPose(q.platform.id)!.position[0]).toBeCloseTo(-0.5, 2);
  });
});

describe('hydraulic cylinder', () => {
  const BORE = 50; // mm
  const AREA = (Math.PI / 4) * 0.05 ** 2;
  const ROD = 28;
  const AREA_RET = AREA - (Math.PI / 4) * 0.028 ** 2;
  const rig = (mass: number, extra: Record<string, number | string> = {}) => {
    const base = anchor();
    const load = cube(mass);
    const h = comp('hydraulicCylinder', {
      pressure: 100,
      bore: BORE,
      rod: ROD,
      flow: 30,
      min: 0,
      max: 2,
      key: 'KeyU',
      keyReverse: 'KeyJ',
      ...extra,
    });
    const j = withComponents(
      createJoint({ type: 'slider', bodyA: base.id, bodyB: load.id, anchorA: [0, 0, 0], axis: [0, 1, 0] }),
      h,
    );
    return { base, load, h, j };
  };

  it('lifts a load at flow ÷ area and pushes with force = load weight while moving', async () => {
    const { base, load, h, j } = rig(100); // 981 N against 19.6 kN available
    const w = await worldOf([base, load, j], { ...NO_G, gravity: [0, -G, 0] });
    w.setKeys(['KeyU']);
    run(w, 1);
    const y1 = w.getPose(load.id)!.position[1];
    run(w, 1);
    const v = w.getPose(load.id)!.position[1] - y1; // distance in the second second = mean speed
    expect(v).toBeCloseTo(30 / 60000 / AREA, 3); // 0.2546 m/s
    const [stroke, speed, force, pressure] = stateOf(w, h.id);
    expect(stroke).toBeGreaterThan(200);
    expect(speed).toBeCloseTo(254.6, -1);
    expect(force).toBeCloseTo(981, -1); // just the weight
    expect(pressure).toBeCloseTo(981 / AREA / 1e5, 1);
  });

  it('a load beyond pressure × area stalls the cylinder at exactly that force', async () => {
    const { base, load, h, j } = rig(3000, { min: -5 }); // 29.4 kN > 100 bar × 19.6 cm² = 19.6 kN
    const w = await worldOf([base, load, j], { ...NO_G, gravity: [0, -G, 0] });
    w.setKeys(['KeyU']);
    run(w, 0.5);
    const force = stateOf(w, h.id)[2];
    expect(force).toBeCloseTo(100 * 1e5 * AREA, -1); // 19 635 N
    expect(w.getPose(load.id)!.linvel[1]).toBeLessThan(-1); // the surplus weight accelerates the load downward
  });

  it('the retract stroke is weaker: the rod takes area away', async () => {
    const { base, load, h, j } = rig(1, { min: -5 });
    // pull a vertical load down with a constant force far beyond the cylinder and read the retract-side limit
    const w = await worldOf([base, withComponents(load, comp('constantForce', { force: [0, 1e6, 0] })), j], NO_G);
    w.setKeys(['KeyJ']);
    run(w, 0.3);
    expect(stateOf(w, h.id)[2]).toBeCloseTo(-100 * 1e5 * AREA_RET, -1);
  });

  it('holds the load with the valve centred (up to the relief pressure) and floats when open', async () => {
    const hold = rig(100, { idle: 'hold', min: -5 });
    const w1 = await worldOf([hold.base, hold.load, hold.j], { ...NO_G, gravity: [0, -G, 0] });
    run(w1, 2);
    expect(Math.abs(w1.getPose(hold.load.id)!.position[1])).toBeLessThan(0.01);
    const float = rig(100, { idle: 'float', min: -5 });
    const w2 = await worldOf([float.base, float.load, float.j], { ...NO_G, gravity: [0, -G, 0] });
    run(w2, 0.5);
    expect(w2.getPose(float.load.id)!.position[1]).toBeLessThan(-0.5);
  });

  it('stops at the ends of the stroke', async () => {
    const { base, load, j } = rig(10, { max: 0.4 });
    const w = await worldOf([base, load, j], NO_G);
    w.setKeys(['KeyU']);
    run(w, 3);
    expect(w.getPose(load.id)!.position[1]).toBeCloseTo(0.4, 2);
    expect(Math.abs(w.getPose(load.id)!.linvel[1])).toBeLessThan(0.01);
  });
});

void createBody;
void DT;

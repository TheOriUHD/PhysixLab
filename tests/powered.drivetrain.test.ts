/** CP-1 / CP-4 — brake, clutch, gearbox, differential and the shaft graph that connects them. */
import { describe, expect, it } from 'vitest';
import { toRpm } from '../src/physics/components/powered/common';
import { run, worldOf } from './helpers';
import { anchor, comp, cube, hinge, NO_G, stateOf, withComponents } from './poweredHelpers';
import type { BodyEntity, JointEntity } from '../src/model/types';

const FLAT = (t: number): [number, number][] => [
  [0, t],
  [12000, t],
];
const wheelSpeed = (w: Awaited<ReturnType<typeof worldOf>>, id: string) => w.getPose(id)!.angvel[2];

describe('brake', () => {
  const rig = (extra: Record<string, number | string | boolean> = {}, load = 0, spin = 20) => {
    const base = anchor();
    let wheel = cube(6, { angularVelocity: [0, 0, spin] }); // I = 1 kg·m²
    if (load) wheel = { ...wheel, components: [comp('constantForce', { force: [0, 0, 0], torque: [0, 0, load] })] };
    const b = comp('brake', { torque: 5, key: 'KeyB', response: 0, ...extra });
    return { base, wheel, b, j: withComponents(hinge(base, wheel), b) };
  };

  it('decelerates a wheel at T / I and stops it exactly — no reversing, no creep', async () => {
    const { base, wheel, b, j } = rig();
    const w = await worldOf([base, wheel, j], NO_G);
    w.setKeys(['KeyB']);
    run(w, 2);
    expect(wheelSpeed(w, wheel.id)).toBeCloseTo(20 - 5 * 2, 2);
    run(w, 3); // would be −5 rad/s without the friction behaviour
    expect(wheelSpeed(w, wheel.id)).toBeCloseTo(0, 6);
    run(w, 1);
    expect(wheelSpeed(w, wheel.id)).toBeCloseTo(0, 6);
    expect(stateOf(w, b.id)[1]).toBeCloseTo(100, 6); // pedal 100 %
  });

  it('holds against a load below its torque and slips above it', async () => {
    const holds = rig({ torque: 5 }, 3, 0);
    const w1 = await worldOf([holds.base, holds.wheel, holds.j], NO_G);
    w1.setKeys(['KeyB']);
    run(w1, 3);
    expect(Math.abs(wheelSpeed(w1, holds.wheel.id))).toBeLessThan(1e-6); // 3 N·m of load against 5 N·m of brake
    const slips = rig({ torque: 5 }, 8, 0);
    const w2 = await worldOf([slips.base, slips.wheel, slips.j], NO_G);
    w2.setKeys(['KeyB']);
    run(w2, 1);
    // 8 N·m of load against 5 N·m of brake: the wheel turns with the difference, (8 − 5) / 1 = 3 rad/s²
    expect(wheelSpeed(w2, slips.wheel.id)).toBeCloseTo(3, 1);
  });

  it('an analog pedal scales the torque, and the parking brake latches', async () => {
    const half = rig({ key: '', axis: 'brake' });
    const w = await worldOf([half.base, half.wheel, half.j], NO_G);
    w.setAxes({ brake: 0.5 });
    run(w, 2);
    expect(wheelSpeed(w, half.wheel.id)).toBeCloseTo(20 - 2.5 * 2, 2); // 2.5 N·m
    const park = rig({ key: '', parkKey: 'KeyP', parkTorque: 10 });
    const w2 = await worldOf([park.base, park.wheel, park.j], NO_G);
    run(w2, 1);
    expect(wheelSpeed(w2, park.wheel.id)).toBeCloseTo(20, 2); // not applied
    w2.setKeys(['KeyP']);
    run(w2, 0.1);
    w2.setKeys([]);
    run(w2, 3);
    expect(Math.abs(wheelSpeed(w2, park.wheel.id))).toBeLessThan(1e-6); // latched on after one press
    expect(stateOf(w2, park.b.id)[2]).toBe(1);
    w2.setKeys(['KeyP']);
    run(w2, 0.1);
    w2.setKeys([]);
    run(w2, 0.2);
    expect(stateOf(w2, park.b.id)[2]).toBe(0); // second press releases it
  });
});

/** A fixed frame carrying the drive-train components, with wheels hinged to it. */
function frameWith(...components: ReturnType<typeof comp>[]): BodyEntity {
  return withComponents(anchor(), ...components);
}
let wheelSlot = 0;
const wheelOn = (frame: BodyEntity, shaft: string, density: number, over: Record<string, unknown> = {}) => {
  // wheels sit apart along their common axis (z) so that they do not touch each other
  const wheel = cube(density, { position: [0, 0, 2 * (wheelSlot++ % 2 === 0 ? 1 : -1)], ...over });
  const j: JointEntity = withComponents(hinge(frame, wheel), comp('driveShaft', { shaft }));
  return { wheel, j };
};

describe('clutch', () => {
  const build = (clutchParams: Record<string, number | string> = {}) => {
    const eng = comp('engine', { curve: FLAT(0), idle: 2000, revLimit: 12000, braking: 0, inertia: 0.25, throttle: 0 });
    const clu = comp('clutch', { in: 'crank', out: 'clutch', maxTorque: 20, response: 0, ...clutchParams });
    const frame = frameWith(eng, clu);
    const { wheel, j } = wheelOn(frame, 'clutch', 6);
    return { eng, clu, frame, wheel, j };
  };

  it('slips at its torque capacity, then locks: the speeds meet where angular momentum says they must', async () => {
    const { eng, clu, frame, wheel, j } = build();
    const w = await worldOf([frame, wheel, j], NO_G);
    const w0 = (2000 * 2 * Math.PI) / 60; // engine starts at idle = 209.4 rad/s
    run(w, 0.5);
    // slipping: the clutch carries exactly its capacity, the wheel accelerates at T / (I_wheel + I_shaft)
    const [, slip, torque, locked] = stateOf(w, clu.id);
    expect(torque).toBeCloseTo(-20, 3); // torque taken from the input shaft
    expect(locked).toBe(0);
    expect(slip).toBeGreaterThan(1000);
    expect(wheelSpeed(w, wheel.id)).toBeCloseTo((20 / 1.02) * 0.5, 1);
    expect(toRpm(w0) - stateOf(w, eng.id)[0]).toBeCloseTo(toRpm((20 / 0.25) * 0.5), 0); // engine slows at T / I_fly
    run(w, 3);
    const final = (0.25 * w0) / (0.25 + 0.02 + 1);
    expect(wheelSpeed(w, wheel.id)).toBeCloseTo(final, 1); // 41.2 rad/s
    expect(stateOf(w, clu.id)[3]).toBe(1);
    expect(stateOf(w, eng.id)[0]).toBeCloseTo(toRpm(final), 0);
  });

  it('the pedal disengages it: the engine runs free while the wheel coasts', async () => {
    const { eng, clu, frame, wheel, j } = build({ maxTorque: 1000, key: 'KeyC' });
    const w = await worldOf([frame, wheel, j], NO_G);
    run(w, 0.5);
    const locked = wheelSpeed(w, wheel.id);
    expect(locked).toBeGreaterThan(30);
    w.setKeys(['KeyC']);
    run(w, 0.5);
    expect(stateOf(w, clu.id)[0]).toBeCloseTo(0, 6);
    expect(wheelSpeed(w, wheel.id)).toBeCloseTo(locked, 2); // nothing drives or slows it
    expect(stateOf(w, eng.id)[0]).toBeCloseTo(toRpm(locked), 0); // and the engine keeps what it had
  });
});

describe('gearbox', () => {
  const build = (gearParams: Record<string, number | string> = {}) => {
    const eng = comp('engine', {
      curve: FLAT(40),
      idle: 0,
      revLimit: 12000,
      braking: 0,
      inertia: 0.25,
      throttle: 1,
      response: 0,
    });
    const gb = comp('gearbox', {
      in: 'crank',
      out: 'driveshaft',
      ratios: '3, 2, 1',
      efficiency: 1,
      inertia: 0.02,
      shiftTime: 0,
      ...gearParams,
    });
    const frame = frameWith(eng, gb);
    const { wheel, j } = wheelOn(frame, 'driveshaft', 6);
    return { eng, gb, frame, wheel, j };
  };

  it('multiplies torque and divides speed: α_wheel = r·T / (I_wheel + I_shaft + r²·I_input)', async () => {
    const { eng, gb, frame, wheel, j } = build({ gear: 1 });
    const w = await worldOf([frame, wheel, j], NO_G);
    run(w, 0.5);
    const r = 3;
    const alpha = (r * 40) / (1 + 0.02 + r * r * (0.25 + 0.02)); // 120 / 3.45
    expect(wheelSpeed(w, wheel.id)).toBeCloseTo(alpha * 0.5, 1);
    const [gear, ratio, inRpm, outRpm, outTorque] = stateOf(w, gb.id);
    expect(gear).toBe(1);
    expect(ratio).toBe(3);
    expect(inRpm / outRpm).toBeCloseTo(3, 3); // input turns 3× per output turn
    expect(stateOf(w, eng.id)[0]).toBeCloseTo(inRpm, 3);
    // torque on the wheel side: r·(T_engine − I_input·α_input)
    expect(outTorque).toBeCloseTo(r * (40 - (0.25 + 0.02) * r * alpha), 0);
  });

  it('shifts with the keys, passes through neutral, and reverses', async () => {
    const { gb, frame, wheel, j } = build({ gear: 1, upKey: 'KeyE', downKey: 'KeyQ', reverseKey: 'KeyR' });
    const w = await worldOf([frame, wheel, j], NO_G);
    const press = (key: string) => {
      w.setKeys([key]);
      run(w, 0.05);
      w.setKeys([]);
      run(w, 0.03); // the release must be seen for the next press to count
    };
    run(w, 0.2);
    press('KeyE');
    run(w, 0.05);
    expect(stateOf(w, gb.id)[0]).toBe(2);
    expect(stateOf(w, gb.id)[1]).toBe(2);
    press('KeyE');
    run(w, 0.05);
    press('KeyE'); // already in the top gear: stays
    run(w, 0.05);
    expect(stateOf(w, gb.id)[0]).toBe(3);
    press('KeyQ');
    press('KeyQ');
    press('KeyQ'); // 3 → 2 → 1 → neutral
    run(w, 0.05);
    expect(stateOf(w, gb.id)[0]).toBe(0);
    const coast = wheelSpeed(w, wheel.id);
    run(w, 0.5);
    expect(wheelSpeed(w, wheel.id)).toBeCloseTo(coast, 3); // neutral: the wheel is disconnected
    press('KeyR');
    run(w, 1);
    expect(stateOf(w, gb.id)[0]).toBe(-1);
    expect(stateOf(w, gb.id)[1]).toBeLessThan(0);
    expect(wheelSpeed(w, wheel.id)).toBeLessThan(coast); // reversed engine torque slows it, then reverses it
  });

  it('an automatic gearbox upshifts as the engine speed passes its threshold and downshifts below the other', async () => {
    const { gb, frame, wheel, j } = build({ mode: 'auto', gear: 1, upRpm: 1200, downRpm: 400, ratios: '3, 2, 1.2' });
    const w = await worldOf([frame, wheel, j], NO_G);
    const seen = new Set<number>();
    for (let i = 0; i < 360; i++) {
      w.stepOnce();
      if (i % 6 === 0) seen.add(stateOf(w, gb.id)[0]);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it('shifting interrupts the drive for the shift time', async () => {
    const { gb, frame, wheel, j } = build({ gear: 1, shiftTime: 0.5, upKey: 'KeyE' });
    const w = await worldOf([frame, wheel, j], NO_G);
    run(w, 0.3);
    w.setKeys(['KeyE']);
    run(w, 0.05);
    w.setKeys([]);
    const at = wheelSpeed(w, wheel.id);
    run(w, 0.3);
    expect(wheelSpeed(w, wheel.id)).toBeCloseTo(at, 3); // coasting during the shift
    run(w, 0.4);
    expect(wheelSpeed(w, wheel.id)).toBeGreaterThan(at + 1); // engaged again in 2nd
    expect(stateOf(w, gb.id)[0]).toBe(2);
  });
});

describe('differential', () => {
  const build = (
    mode: string,
    wheelDensity: [number, number],
    extra: Record<string, number | string> = {},
    ang: [number, number] = [0, 0],
  ) => {
    const eng = comp('engine', {
      curve: FLAT(30),
      idle: 0,
      revLimit: 12000,
      braking: 0,
      inertia: 0.25,
      throttle: 1,
      response: 0,
    });
    const diff = comp('differential', {
      in: 'crank',
      left: 'left',
      right: 'right',
      finalDrive: 2,
      mode,
      inertia: 0.0001,
      ...extra,
    });
    const frame = frameWith(eng, diff);
    const L = wheelOn(frame, 'left', wheelDensity[0], { angularVelocity: [0, 0, ang[0]] });
    const R = wheelOn(frame, 'right', wheelDensity[1], { angularVelocity: [0, 0, ang[1]] });
    return { eng, diff, frame, L, R };
  };
  const world = async (b: ReturnType<typeof build>) => worldOf([b.frame, b.L.wheel, b.R.wheel, b.L.j, b.R.j], NO_G);

  it('open: equal torque to both wheels, speeds free — the carrier turns at the average: ω_in = fd·(ω_L + ω_R) / 2', async () => {
    const b = build('open', [6, 18]); // wheel inertias 1 and 3 kg·m²
    const w = await world(b);
    run(w, 0.5);
    const [, , tl, tr] = stateOf(w, b.diff.id);
    expect(tl).toBeCloseTo(tr, 6); // equal torque, whatever the loads
    const wl = wheelSpeed(w, b.L.wheel.id);
    const wr = wheelSpeed(w, b.R.wheel.id);
    expect(wl / wr).toBeCloseTo((3 + 0.02) / (1 + 0.02), 2); // the lighter wheel spins faster: α ∝ 1 / I at equal torque
    expect(stateOf(w, b.eng.id)[0]).toBeCloseTo(toRpm((2 * (wl + wr)) / 2), 1);
    // each wheel obeys T = I·α
    expect(tl).toBeCloseTo((1.02 * wl) / 0.5, 0);
    expect(tr).toBeCloseTo((3.02 * wr) / 0.5, 0);
  });

  it('open: a speed difference between the wheels persists (cornering) — nothing forces them equal', async () => {
    const b = build('open', [6, 6], { finalDrive: 2 }, [10, 0]);
    const w = await world(b);
    run(w, 1);
    expect(wheelSpeed(w, b.L.wheel.id) - wheelSpeed(w, b.R.wheel.id)).toBeCloseTo(10, 2);
  });

  it('locked: both wheels turn together and the torque goes where the load is — it splits by inertia', async () => {
    const b = build('locked', [6, 18]);
    const w = await world(b);
    run(w, 0.5);
    expect(wheelSpeed(w, b.L.wheel.id)).toBeCloseTo(wheelSpeed(w, b.R.wheel.id), 3);
    const [, , tl, tr] = stateOf(w, b.diff.id);
    expect(tl / tr).toBeCloseTo(1.02 / 3.02, 2); // T_L : T_R = I_L : I_R when they share one acceleration
    expect(stateOf(w, b.diff.id)[4]).toBe(1);
  });

  it('the lock key locks an open differential while held', async () => {
    const b = build('open', [6, 6], { lockKey: 'KeyL' }, [10, 0]);
    const w = await world(b);
    run(w, 0.2);
    expect(wheelSpeed(w, b.L.wheel.id) - wheelSpeed(w, b.R.wheel.id)).toBeCloseTo(10, 2);
    w.setKeys(['KeyL']);
    run(w, 0.2);
    expect(Math.abs(wheelSpeed(w, b.L.wheel.id) - wheelSpeed(w, b.R.wheel.id))).toBeLessThan(0.01);
  });

  it('limited slip: resists a speed difference with its clutch-pack torque, so it closes at T / I_reduced', async () => {
    const b = build('lsd', [6, 6], { preload: 4, bias: 0 }, [10, 0]);
    const w = await world(b);
    run(w, 0.5);
    // two 1.02 kg·m² wheels pulled together by 4 N·m: relative acceleration 2·4/1.02
    const d = wheelSpeed(w, b.L.wheel.id) - wheelSpeed(w, b.R.wheel.id);
    expect(d).toBeCloseTo(10 - (2 * 4 * 0.5) / 1.02, 0);
    run(w, 2);
    expect(Math.abs(wheelSpeed(w, b.L.wheel.id) - wheelSpeed(w, b.R.wheel.id))).toBeLessThan(0.05); // fully locked once the difference is closed
  });
});

describe('the shaft graph', () => {
  it('shaft names are private to an assembly: two copies of a drive train in one scene do not share a crank', async () => {
    const make = (on: boolean, x: number) => {
      const eng = comp('engine', {
        curve: FLAT(40),
        idle: 0,
        revLimit: 12000,
        inertia: 0.25,
        throttle: on ? 1 : 0,
        response: 0,
        braking: 0,
      });
      const frame = withComponents(anchor([x, 0, 0]), eng);
      const wheel = cube(6, { position: [x, 0, 0] });
      const j = withComponents(hinge(frame, wheel), comp('driveShaft', { shaft: 'crank' }));
      return { frame, wheel, j };
    };
    const a = make(true, 0);
    const b = make(false, 10);
    const w = await worldOf([a.frame, a.wheel, a.j, b.frame, b.wheel, b.j], NO_G);
    run(w, 1);
    expect(wheelSpeed(w, a.wheel.id)).toBeGreaterThan(5);
    expect(Math.abs(wheelSpeed(w, b.wheel.id))).toBeLessThan(1e-6); // its engine is at zero throttle and the other crank is not its crank
  });

  it('a name starting with @ is shared by the whole scene', async () => {
    const eng = comp('engine', {
      out: '@main',
      curve: FLAT(40),
      idle: 0,
      revLimit: 12000,
      inertia: 0.25,
      throttle: 1,
      response: 0,
      braking: 0,
    });
    const motorFrame = withComponents(anchor([0, 0, 0]), eng);
    const wheelFrame = anchor([10, 0, 0]);
    const wheel = cube(6, { position: [10, 0, 0] });
    const j = withComponents(hinge(wheelFrame, wheel), comp('driveShaft', { shaft: '@main' }));
    const w = await worldOf([motorFrame, wheelFrame, wheel, j], NO_G);
    run(w, 1);
    expect(wheelSpeed(w, wheel.id)).toBeGreaterThan(5); // two unconnected assemblies, one global shaft
  });

  it('the whole chain engine → clutch → gearbox → differential → two wheels pulls a car-like load and stays finite', async () => {
    const parts = [
      comp('engine', { idle: 900, key: 'KeyW', response: 0.05 }),
      comp('clutch', { maxTorque: 400 }),
      comp('gearbox', { gear: 1, ratios: '3.5, 2.2, 1.5', efficiency: 0.97 }),
      comp('differential', { finalDrive: 3 }),
    ];
    const frame = frameWith(...parts);
    const L = wheelOn(frame, 'left', 6);
    const R = wheelOn(frame, 'right', 6);
    const w = await worldOf([frame, L.wheel, R.wheel, L.j, R.j], NO_G);
    w.setKeys(['KeyW']);
    run(w, 3);
    const a = wheelSpeed(w, L.wheel.id);
    const b = wheelSpeed(w, R.wheel.id);
    expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
    expect(a).toBeGreaterThan(10);
    expect(a).toBeCloseTo(b, 2);
    const eng = stateOf(w, parts[0].id)[0];
    expect(eng).toBeGreaterThan(900);
    // locked train: crank speed = 3.5 · 3 · wheel speed
    expect(eng).toBeCloseTo(toRpm(3.5 * 3 * a), -1);
  });
});

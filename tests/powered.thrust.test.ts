/** CP-5 — thrusters and rockets (rocket equation), jets, propellers and rotors against analytic results. */
import { describe, expect, it } from 'vitest';
import { DEG, vlen } from '../src/core/math';
import { createJoint, run, worldOf } from './helpers';
import { anchor, comp, cube, DT, hinge, NO_G, stateOf, withComponents } from './poweredHelpers';

const G = 9.81;
const LN = Math.log;

describe('thruster / rocket', () => {
  const rocket = (params: Record<string, number | string | boolean | number[]> = {}, dry = 2) => {
    const t = comp('thruster', {
      thrust: 100,
      fuelMass: 8,
      burnTime: 4,
      ramp: 0,
      direction: [0, 1, 0],
      position: [0, 0, 0],
      ...params,
    });
    return { t, body: withComponents(cube(dry), t) };
  };

  it('obeys the rocket equation: Δv = v_e·ln(m₀/m₁), v_e = thrust·burn time / fuel', async () => {
    const { t, body } = rocket(); // 2 kg dry + 8 kg fuel, 100 N for 4 s → ṁ = 2 kg/s, v_e = 50 m/s
    const w = await worldOf([body], NO_G);
    run(w, 4.5);
    const dv = w.getPose(body.id)!.linvel[1];
    expect(dv).toBeCloseTo(50 * LN(10 / 2), 0); // 80.47 m/s
    expect(Math.abs(dv / (50 * LN(5)) - 1)).toBeLessThan(0.002);
    const [thrust, , fuel, mass, ve] = stateOf(w, t.id);
    expect(thrust).toBe(0); // burnt out
    expect(fuel).toBeCloseTo(0, 6);
    expect(mass).toBeCloseTo(2, 3); // only the dry mass is left
    expect(ve).toBeCloseTo(50, 6);
  });

  it('loses mass while it burns: m(t) = m₀ − ṁ·t', async () => {
    const { t, body } = rocket();
    const w = await worldOf([body], NO_G);
    run(w, 1);
    const [, , fuel, mass] = stateOf(w, t.id);
    expect(fuel).toBeCloseTo(6, 3);
    expect(mass).toBeCloseTo(8, 3); // 10 kg − 2 kg/s · 1 s
    // v(t) = v_e·ln(m₀/m(t))
    expect(w.getPose(body.id)!.linvel[1]).toBeCloseTo(50 * LN(10 / 8), 1);
  });

  it('with gravity: v(t) = v_e·ln(m₀/m) − g·t while it burns', async () => {
    const { body } = rocket({ thrust: 400, burnTime: 4, fuelMass: 8 });
    const w = await worldOf([body], { ...NO_G, gravity: [0, -G, 0] });
    run(w, 2);
    // ṁ = 2 kg/s, v_e = 200 m/s, m(2 s) = 6
    expect(w.getPose(body.id)!.linvel[1]).toBeCloseTo(200 * LN(10 / 6) - G * 2, 0);
  });

  it('half throttle gives half the thrust and burns half the fuel per second, at the same exhaust speed', async () => {
    const { t, body } = rocket({ key: '', axis: 'throttle' });
    const w = await worldOf([body], NO_G);
    w.setAxes({ throttle: 0.5 });
    run(w, 2);
    const [thrust, throttle, fuel, , ve] = stateOf(w, t.id);
    expect(thrust).toBeCloseTo(50, 3);
    expect(throttle).toBeCloseTo(50, 3);
    expect(fuel).toBeCloseTo(8 - 1 * 2, 3); // 1 kg/s for 2 s
    expect(ve).toBeCloseTo(50, 6);
    expect(w.getPose(body.id)!.linvel[1]).toBeCloseTo(50 * LN(10 / 8), 1);
  });

  it('a liquid motor is held with a key; a solid motor, once lit, burns to the end', async () => {
    const liquid = rocket({ key: 'KeyT', mode: 'liquid' });
    const w1 = await worldOf([liquid.body], NO_G);
    run(w1, 0.5);
    expect(w1.getPose(liquid.body.id)!.linvel[1]).toBe(0); // not fired yet
    w1.setKeys(['KeyT']);
    run(w1, 0.5);
    w1.setKeys([]);
    const vCut = w1.getPose(liquid.body.id)!.linvel[1];
    expect(vCut).toBeGreaterThan(5);
    run(w1, 0.5);
    expect(w1.getPose(liquid.body.id)!.linvel[1]).toBeCloseTo(vCut, 6); // shut down: coasting

    const solid = rocket({ key: 'KeyT', mode: 'solid' });
    const w2 = await worldOf([solid.body], NO_G);
    w2.setKeys(['KeyT']);
    run(w2, 0.1);
    w2.setKeys([]); // released at once — a solid motor does not care
    run(w2, 4.5);
    expect(w2.getPose(solid.body.id)!.linvel[1]).toBeCloseTo(50 * LN(5), 0);
  });

  it('thrust at an offset nozzle also turns the body: τ = r × F', async () => {
    const { body } = rocket({ fuelMass: 0, position: [0.5, 0, 0], direction: [0, 1, 0], thrust: 10 });
    const w = await worldOf([body], NO_G);
    run(w, 0.1);
    // r = (0.5, 0, 0), F = (0, 10, 0) → τ_z = 5 N·m, I = m/6 = 1/3 for the 2 kg cube
    expect(w.getPose(body.id)!.angvel[2]).toBeCloseTo((5 / (1 / 3)) * 0.1, 1);
  });

  it('fuel 0 is a plain thruster: unlimited, mass unchanged', async () => {
    const { t, body } = rocket({ fuelMass: 0, thrust: 20 });
    const w = await worldOf([body], NO_G);
    run(w, 3);
    expect(w.getPose(body.id)!.linvel[1]).toBeCloseTo((20 / 2) * 3, 1);
    expect(stateOf(w, t.id)[3]).toBeCloseTo(2, 6);
  });

  it('raises ignite and burnout events (the hooks for sound and particle effects)', async () => {
    const { body } = rocket({ burnTime: 1 });
    const w = await worldOf([body], NO_G);
    run(w, 2);
    const names = w
      .drainEvents()
      .filter((e) => e.kind === 'component')
      .map((e) => (e as { name: string }).name);
    expect(names).toEqual(['ignite', 'burnout']);
  });

  it('survives a snapshot: restore, run on, and the result equals the uninterrupted run (mass included)', async () => {
    const { t, body } = rocket();
    const w = await worldOf([body], NO_G);
    run(w, 1.5);
    const snap = w.snapshot();
    run(w, 1);
    const first = { v: w.getPose(body.id)!.linvel[1], s: stateOf(w, t.id) };
    w.restore(snap);
    run(w, 1);
    expect(w.getPose(body.id)!.linvel[1]).toBe(first.v);
    expect(stateOf(w, t.id)).toEqual(first.s);
  });

  it('disabling the component hands the fuel mass back; a shorter tank is a refuel when edited live', async () => {
    const { t, body } = rocket({ key: 'KeyT' });
    const w = await worldOf([body], NO_G);
    run(w, 0.1);
    expect(stateOf(w, t.id)[3]).toBeCloseTo(10, 6);
    w.updateBody({ ...body, components: [{ ...t, enabled: false }] });
    run(w, 0.1);
    expect(w.builtInfo().mass[body.id]).toBeDefined();
    w.updateBody({ ...body, components: [{ ...t, params: { ...t.params, fuelMass: 4 } }] });
    run(w, 0.1);
    expect(stateOf(w, t.id)[3]).toBeCloseTo(6, 6); // 2 kg dry + 4 kg of fuel
  });
});

describe('jet', () => {
  const jet = (params: Record<string, number | string | boolean | number[]> = {}, mass = 10) => {
    const j = comp('jet', {
      thrust: 100,
      spool: 1,
      maxSpeed: 1e6,
      direction: [0, 1, 0],
      position: [0, 0, 0],
      ...params,
    });
    return { j, body: withComponents(cube(mass), j) };
  };

  it('spools up as 1 − e^(−t/τ) and then delivers its dry thrust', async () => {
    const { j, body } = jet();
    const w = await worldOf([body], NO_G);
    run(w, 1);
    expect(stateOf(w, j.id)[1]).toBeCloseTo(100 * (1 - Math.exp(-1)), 0);
    expect(stateOf(w, j.id)[0]).toBeCloseTo(100 * (1 - Math.exp(-1)), 0);
    run(w, 8);
    expect(stateOf(w, j.id)[0]).toBeCloseTo(100, 0);
  });

  it('the afterburner multiplies thrust, and only once the engine is near full speed', async () => {
    const { j, body } = jet({ abKey: 'KeyA', afterburner: 1.6, spool: 0.3 });
    const w = await worldOf([body], NO_G);
    w.setKeys(['KeyA']);
    run(w, 0.1);
    expect(stateOf(w, j.id)[2]).toBe(0); // not up to speed yet
    run(w, 3);
    const [thrust, n, ab] = stateOf(w, j.id);
    expect(ab).toBe(1);
    expect(n).toBeGreaterThan(99);
    expect(thrust).toBeCloseTo(160, 0);
  });

  it('thrust fades with airspeed: × (1 − (v/vmax)²)', async () => {
    const { j, body } = jet({ spool: 0, maxSpeed: 100 });
    const moving = { ...body, velocity: [0, 50, 0] as [number, number, number] };
    const w = await worldOf([moving], NO_G);
    run(w, 0.02);
    expect(stateOf(w, j.id)[0]).toBeCloseTo(100 * (1 - 0.25), 0);
  });

  it('fuel is real mass and burns with thrust until the engine flames out', async () => {
    const { j, body } = jet({ spool: 0, fuelMass: 1, sfc: 1000, thrust: 100 }); // 1 g per N·s ... = 1 kg per 10 s at 100 N
    const w = await worldOf([body], NO_G);
    run(w, 5);
    expect(stateOf(w, j.id)[3]).toBeCloseTo(0.5, 2);
    run(w, 6);
    expect(stateOf(w, j.id)[3]).toBe(0);
    expect(stateOf(w, j.id)[0]).toBe(0); // flame-out
  });
});

describe('propeller', () => {
  const D = 1;
  const RHO = 1.225;
  const CT = 0.1;
  const CQ = 0.012;

  it('thrust ∝ rpm²: T = C_T·ρ·n²·D⁴, a quarter at half speed', async () => {
    const make = async (throttle: number) => {
      const p = comp('propeller', {
        maxRpm: 3000,
        throttle,
        spool: 0,
        diameter: D,
        thrustCoeff: CT,
        density: RHO,
        direction: [0, 1, 0],
        reaction: false,
      });
      const body = withComponents(cube(1e6), p); // heavy: stays put, so no advance-ratio effect
      const w = await worldOf([body], NO_G);
      run(w, 0.1);
      return stateOf(w, p.id);
    };
    const [rpmFull, thrustFull] = await make(1);
    const [rpmHalf, thrustHalf] = await make(0.5);
    expect(rpmFull).toBeCloseTo(3000, 0);
    expect(thrustFull).toBeCloseTo(CT * RHO * 50 ** 2 * D ** 4, 1); // 306.25 N at n = 50 rev/s
    expect(rpmHalf).toBeCloseTo(1500, 0);
    expect(thrustHalf / thrustFull).toBeCloseTo(0.25, 2);
  });

  it('thrust falls with the advance ratio: half the static thrust at J = J₀/2', async () => {
    const p = comp('propeller', {
      maxRpm: 3000,
      throttle: 1,
      spool: 0,
      diameter: D,
      thrustCoeff: CT,
      density: RHO,
      advance: 1.1,
      direction: [0, 1, 0],
      reaction: false,
    });
    const n = 50;
    const v = 0.55 * n * D; // J = 0.55
    const body = withComponents(cube(1e6, { velocity: [0, v, 0] }), p);
    const w = await worldOf([body], NO_G);
    run(w, 0.05);
    const [, thrust, , j] = stateOf(w, p.id);
    expect(j).toBeCloseTo(0.55, 2);
    expect(thrust).toBeCloseTo((CT * RHO * n * n * D ** 4) / 2, 0);
  });

  it('driven through a drive-train shaft the speed settles where engine torque = load torque (C_Q·ρ·n²·D⁵)', async () => {
    const eng = comp('engine', {
      out: 'prop',
      curve: [
        [0, 20],
        [20000, 20],
      ],
      idle: 0,
      revLimit: 20000,
      inertia: 0.05,
      throttle: 1,
      response: 0,
      braking: 0,
    });
    const p = comp('propeller', {
      shaft: 'prop',
      diameter: D,
      thrustCoeff: CT,
      torqueCoeff: CQ,
      density: RHO,
      direction: [0, 1, 0],
    });
    const body = withComponents(cube(1e6), eng, p);
    const w = await worldOf([body], NO_G);
    run(w, 8);
    const n = Math.sqrt(20 / (CQ * RHO * D ** 5)); // rev/s
    const [rpm, thrust, torque] = stateOf(w, p.id);
    expect(rpm).toBeCloseTo(n * 60, -1); // within 5 rpm of 2214
    expect(torque).toBeCloseTo(20, 0);
    expect(thrust).toBeCloseTo(CT * RHO * n * n * D ** 4, 0);
  });

  it('on a hinge: an engine turns the propeller, the load torque slows the engine and the thrust pushes the carrier', async () => {
    const base = cube(1000);
    const rotorBody = cube(0.3, { position: [0, 0, 0] });
    const j = withComponents(
      createJoint({ type: 'hinge', bodyA: base.id, bodyB: rotorBody.id, anchorA: [0, 0, 0], axis: [0, 1, 0] }),
      comp('engine', {
        curve: [
          [0, 2],
          [20000, 2],
        ],
        idle: 0,
        revLimit: 20000,
        inertia: 0.02,
        throttle: 1,
        response: 0,
        braking: 0,
        ratio: 1,
      }),
      comp('propeller', { diameter: D, thrustCoeff: CT, torqueCoeff: CQ, density: RHO }),
    );
    const w = await worldOf([base, rotorBody, j], NO_G);
    run(w, 14);
    const n = Math.sqrt(2 / (CQ * RHO * D ** 5)); // 11.7 rev/s = 73 rad/s, below the engine's 45°-per-step speed limit
    const spin = w.getJointRec(j.id)!.speed;
    expect(spin).toBeCloseTo(2 * Math.PI * n, 0);
    expect(w.getPose(base.id)!.linvel[1]).toBeGreaterThan(0); // pushed along the hinge axis (+y)
  });

  it('a self-driven propeller turns its body the other way (torque reaction)', async () => {
    const make = async (reaction: boolean) => {
      const p = comp('propeller', {
        maxRpm: 3000,
        throttle: 1,
        spool: 0,
        diameter: D,
        torqueCoeff: CQ,
        density: RHO,
        direction: [0, 1, 0],
        reaction,
      });
      const body = withComponents(cube(6), p);
      const w = await worldOf([body], NO_G);
      run(w, 0.2);
      return w.getPose(body.id)!.angvel[1];
    };
    const spun = await make(true);
    const Q = CQ * RHO * 50 ** 2 * D ** 5;
    expect(spun).toBeCloseTo(-(Q / 1) * 0.2, 1); // I = 6/6 = 1 kg·m²
    expect(await make(false)).toBeCloseTo(0, 9);
  });
});

describe('rotor', () => {
  const R = 1.5;
  const RHO = 1.225;
  const CT = 0.012;
  const lift = (collective: number, rpm = 360) => {
    const tip = ((rpm * 2 * Math.PI) / 60) * R;
    return CT * collective * RHO * Math.PI * R * R * tip * tip;
  };
  const heli = (params: Record<string, number | string | boolean | number[]> = {}, mass = 20) => {
    const r = comp('rotor', {
      radius: R,
      thrustCoeff: CT,
      density: RHO,
      maxRpm: 360,
      spool: 0,
      throttle: 1,
      direction: [0, 1, 0],
      position: [0, 0, 0],
      reaction: false,
      hubMoment: 0,
      ...params,
    });
    return { r, body: withComponents(cube(mass), r) };
  };

  it('lift = C_T·collective·ρ·πR²·(ΩR)²: collective sized to the weight hovers, more climbs at (L − W)/m', async () => {
    const mass = 20;
    const hover = (mass * G) / lift(1);
    const a = heli({ collective: hover }, mass);
    const w = await worldOf([a.body], { ...NO_G, gravity: [0, -G, 0] });
    run(w, 1);
    expect(stateOf(w, a.r.id)[1]).toBeCloseTo(mass * G, 0);
    expect(Math.abs(w.getPose(a.body.id)!.linvel[1])).toBeLessThan(0.02);
    const b = heli({ collective: hover + 0.2 }, mass);
    const w2 = await worldOf([b.body], { ...NO_G, gravity: [0, -G, 0] });
    run(w2, 1);
    expect(w2.getPose(b.body.id)!.linvel[1]).toBeCloseTo((lift(hover + 0.2) - mass * G) / mass, 1);
  });

  it('collective follows its keys at the set rate and the axis directly; lift tracks it', async () => {
    const a = heli({ collective: 0, collectiveUp: 'KeyU', collectiveDown: 'KeyJ', collectiveRate: 0.5 });
    const w = await worldOf([a.body], NO_G);
    w.setKeys(['KeyU']);
    run(w, 1);
    expect(stateOf(w, a.r.id)[2]).toBeCloseTo(50, 1); // 0.5/s for 1 s
    expect(stateOf(w, a.r.id)[1]).toBeCloseTo(lift(0.5), 0);
    w.setKeys([]);
    const b = heli({ collective: 0, collectiveAxis: 'coll' });
    const w2 = await worldOf([b.body], NO_G);
    w2.setAxes({ coll: -0.4 });
    run(w2, 0.2);
    expect(stateOf(w2, b.r.id)[1]).toBeCloseTo(lift(-0.4), 0); // negative collective pushes down
  });

  it('lift ∝ rpm²', async () => {
    const lo = heli({ collective: 1, throttle: 0.5 });
    const w = await worldOf([lo.body], NO_G);
    run(w, 0.2);
    expect(stateOf(w, lo.r.id)[1]).toBeCloseTo(lift(1, 180), 0);
    expect(stateOf(w, lo.r.id)[1] / lift(1)).toBeCloseTo(0.25, 3);
  });

  it('cyclic pitch leans the thrust forward: forward part L·sin(tilt), vertical part L·cos(tilt)', async () => {
    const mass = 20;
    const a = heli({ collective: 0.8, maxTilt: 10, pitchAxis: 'pitch', forward: [0, 0, 1] }, mass);
    const w = await worldOf([a.body], NO_G);
    w.setAxes({ pitch: 1 });
    run(w, 0.5);
    const v = w.getPose(a.body.id)!.linvel;
    const L = lift(0.8);
    const tilt = 10 * DEG;
    // the thrust keeps its size and leans by θ: forward part L·sin θ, vertical part L·cos θ
    expect(v[2]).toBeCloseTo(((L * Math.sin(tilt)) / mass) * 0.5, 1);
    expect(v[1]).toBeCloseTo(((L * Math.cos(tilt)) / mass) * 0.5, 1);
    expect(Math.abs(v[0])).toBeLessThan(1e-6);
  });

  it('a rotor above the centre of mass turns the body when the disc tilts (hub lever), and a stiff head adds more', async () => {
    const make = async (hub: number) => {
      const a = heli({ collective: 0.8, maxTilt: 10, rollAxis: 'roll', position: [0, 1, 0], hubMoment: hub });
      const w = await worldOf([a.body], NO_G);
      w.setAxes({ roll: 1 });
      run(w, 0.05);
      return w.getPose(a.body.id)!.angvel;
    };
    const soft = await make(0);
    const stiff = await make(0.5);
    expect(vlen(soft)).toBeGreaterThan(0.001);
    expect(vlen(stiff)).toBeGreaterThan(vlen(soft) * 1.5);
  });

  it('the drag torque turns a self-driven fuselage the other way, and loads a shaft-driven rotor', async () => {
    const a = heli({ reaction: true, collective: 0.5 });
    const w = await worldOf([a.body], NO_G);
    run(w, 0.2);
    const split = 0.3 + 0.7 * 0.5; // the drag is 30 % profile (always there) + 70 % induced (grows with the collective)
    const q = split * 0.001 * (RHO * Math.PI * R * R * (((360 * 2 * Math.PI) / 60) * R) ** 2) * R; // C_Q·q·R·split
    expect(w.getPose(a.body.id)!.angvel[1]).toBeCloseTo(-(q / (20 / 6)) * 0.2, 1);
    // driven by an engine through a shaft: the speed settles where engine torque equals the drag
    const eng = comp('engine', {
      out: 'mast',
      curve: [
        [0, 30],
        [20000, 30],
      ],
      idle: 0,
      revLimit: 20000,
      inertia: 0.5,
      throttle: 1,
      response: 0,
      braking: 0,
    });
    const r = comp('rotor', {
      shaft: 'mast',
      radius: R,
      thrustCoeff: CT,
      torqueCoeff: 0.001,
      density: RHO,
      collective: 0.5,
      direction: [0, 1, 0],
      position: [0, 0, 0],
    });
    const body = withComponents(cube(1000), eng, r);
    const w2 = await worldOf([body], NO_G);
    run(w2, 20);
    const omega = Math.sqrt(30 / (split * 0.001 * RHO * Math.PI * R ** 5));
    expect(stateOf(w2, r.id)[0]).toBeCloseTo((omega * 60) / (2 * Math.PI), -1);
  });
});

void DT;
void anchor;
void hinge;

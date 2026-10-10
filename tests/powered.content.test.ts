/** The example scenes and prefabs of the powered parts do what they promise. */
import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/math';
import { listPrefabs, listTemplates } from '../src/model/content';
import { newDocument } from '../src/model/factory';
import { sanitizeDocument } from '../src/model/serialize';
import type { BodyEntity, Entity, JointEntity, SceneDocument } from '../src/model/types';
import { PhysicsWorld } from '../src/physics/world';

const scene = (id: string): SceneDocument => {
  const t = listTemplates().find((x) => x.id === id);
  if (!t) throw new Error(`no example scene "${id}"`);
  return sanitizeDocument(JSON.parse(JSON.stringify(t.build())));
};
const named = <T extends Entity>(doc: SceneDocument, name: string): T => {
  const e = doc.entities.find((x) => x.name === name);
  if (!e) throw new Error(`no entity "${name}"`);
  return e as T;
};
const run = (w: PhysicsWorld, s: number) => {
  for (let i = 0; i < Math.round(s * w.settings.physicsHz); i++) w.stepOnce();
};
const published = new Map<string, number[]>();
const gauge = (w: PhysicsWorld, id: string): number[] => {
  for (const [k, e] of Object.entries(w.drainComponentState().changed)) if (e.values) published.set(k, [...e.values]);
  return published.get(id) ?? [];
};
const compOf = (e: BodyEntity | JointEntity, type: string) => e.components.find((c) => c.type === type)!;
const press = (w: PhysicsWorld, keys: string[], seconds: number) => {
  w.setKeys(keys);
  run(w, seconds);
  w.setKeys([]);
};

describe('every powered example', () => {
  for (const id of [
    'powertrain-car',
    'engine-stand',
    'electric-rover',
    'servo-arm',
    'stepper-dial',
    'lift-table',
    'hydraulic-crane',
  ]) {
    it(`${id}: is registered as an example scene${id === 'powertrain-car' || id === 'engine-stand' ? '' : ' and a prefab'}`, () => {
      expect(listTemplates().some((t) => t.id === id)).toBe(true);
      if (id !== 'engine-stand') expect(listPrefabs().some((p) => p.id === id)).toBe(true);
    });
  }
});

describe('engine test stand', () => {
  it('the throttle spins the flywheel through the clutch and the 8:1 gear; neutral frees it; the brake stops it', async () => {
    const doc = scene('engine-stand');
    const stand = named<BodyEntity>(doc, 'Stand');
    const fly = named<BodyEntity>(doc, 'Flywheel');
    const w = await PhysicsWorld.create(doc);
    run(w, 1);
    // idling with the clutch engaged: the flywheel turns at the idle speed ÷ 8 (900 rpm ÷ 8 ≈ 10 rad/s)
    expect(Math.abs(w.getPose(fly.id)!.angvel[2])).toBeGreaterThan(5);
    expect(Math.abs(w.getPose(fly.id)!.angvel[2])).toBeLessThan(15);
    w.setKeys(['KeyW']);
    run(w, 4);
    const spin = Math.abs(w.getPose(fly.id)!.angvel[2]);
    expect(spin).toBeGreaterThan(40); // rad/s
    const [rpm, , thr] = gauge(w, compOf(stand, 'engine').id);
    expect(rpm).toBeGreaterThan(3000);
    expect(thr).toBeGreaterThan(90);
    // the locked train: crank rpm = 8 × flywheel rpm (to within the slip of the clutch)
    expect(rpm / ((spin * 60) / (2 * Math.PI))).toBeCloseTo(8, 0);
    // neutral: the flywheel coasts, the engine revs on alone
    w.setKeys(['KeyW', 'KeyN']);
    run(w, 0.5);
    const coast = Math.abs(w.getPose(fly.id)!.angvel[2]);
    run(w, 1);
    expect(Math.abs(w.getPose(fly.id)!.angvel[2])).toBeGreaterThan(coast * 0.9); // coasting (a little hinge damping)
    w.setKeys(['KeyS']);
    run(w, 4);
    expect(Math.abs(w.getPose(fly.id)!.angvel[2])).toBeLessThan(0.05);
  });
});

describe('electric rover', () => {
  it('both sides forward drives straight; opposite sides turn it on the spot; the analog axes work too', async () => {
    // each world is built from its own copy of the scene, with its own ids
    const fresh = async () => {
      const doc = scene('electric-rover');
      return { w: await PhysicsWorld.create(doc), rover: named<BodyEntity>(doc, 'Rover chassis') };
    };
    const a = await fresh();
    press(a.w, ['KeyQ', 'KeyE'], 3);
    const v = a.w.getPose(a.rover.id)!.linvel;
    expect(v[0]).toBeGreaterThan(2);
    expect(Math.abs(v[2])).toBeLessThan(1);
    const b = await fresh();
    press(b.w, ['KeyQ', 'KeyD'], 3);
    expect(Math.abs(b.w.getPose(b.rover.id)!.angvel[1])).toBeGreaterThan(0.8);
    expect(Math.hypot(...b.w.getPose(b.rover.id)!.linvel)).toBeLessThan(2); // turning about the wheel axle, not driving off
    const c = await fresh();
    c.w.setAxes({ left: 0.5, right: 0.5 });
    run(c.w, 3);
    const half = c.w.getPose(c.rover.id)!.linvel[0];
    expect(half).toBeGreaterThan(1);
    const d = await fresh();
    d.w.setAxes({ left: 1, right: 1 });
    run(d.w, 3);
    expect(d.w.getPose(d.rover.id)!.linvel[0]).toBeGreaterThan(half * 1.2);
  });
});

describe('servo arm', () => {
  it('both servos swing the arm to their targets against gravity and hold them', async () => {
    const doc = scene('servo-arm');
    const sh = named<JointEntity>(doc, 'Shoulder servo');
    const el = named<JointEntity>(doc, 'Elbow servo');
    const w = await PhysicsWorld.create(doc);
    run(w, 6);
    const [shoulder] = gauge(w, compOf(sh, 'servo').id);
    const [elbow] = gauge(w, compOf(el, 'servo').id);
    expect(Math.abs(shoulder - 25)).toBeLessThan(2.5);
    expect(Math.abs(elbow - -35)).toBeLessThan(2.5);
    // jogging the shoulder up moves the target and the arm follows
    press(w, ['KeyW'], 1);
    run(w, 1.5);
    expect(gauge(w, compOf(sh, 'servo').id)[0]).toBeGreaterThan(shoulder + 25);
  });
});

describe('stepper turntable', () => {
  it('each key press is one 7.5° step, and the table settles on the step', async () => {
    const doc = scene('stepper-dial');
    const st = named<JointEntity>(doc, 'Stepper');
    const w = await PhysicsWorld.create(doc);
    for (let i = 0; i < 3; i++) {
      press(w, ['KeyE'], 0.05);
      run(w, 1.5); // the 5 kg table rings for a moment after each step
    }
    const [steps, , angle, lag] = gauge(w, compOf(st, 'stepper').id);
    expect(steps).toBe(3);
    expect(angle).toBeCloseTo(22.5, 0);
    expect(Math.abs(lag)).toBeLessThan(0.1);
    press(w, ['KeyQ'], 0.05);
    run(w, 1.5);
    expect(gauge(w, compOf(st, 'stepper').id)[0]).toBe(2);
    expect(gauge(w, compOf(st, 'stepper').id)[2]).toBeCloseTo(15, 0);
  });
});

describe('lift table', () => {
  it('rises to where the analog axis says and carries the crate; lowering returns it', async () => {
    const doc = scene('lift-table');
    const deck = named<BodyEntity>(doc, 'Lift deck');
    const crate = named<BodyEntity>(doc, 'Crate');
    const joint = named<JointEntity>(doc, 'Lift actuator');
    const w = await PhysicsWorld.create(doc);
    const y0 = w.getPose(deck.id)!.position[1];
    w.setAxes({ lift: 0 }); // the middle of the 0 … 2.6 m range
    run(w, 6);
    expect(w.getPose(deck.id)!.position[1] - y0).toBeCloseTo(1.3, 1);
    w.setAxes({ lift: 1 });
    run(w, 5);
    expect(w.getPose(deck.id)!.position[1] - y0).toBeCloseTo(2.6, 1);
    expect(w.getPose(crate.id)!.position[1]).toBeGreaterThan(y0 + 2.6); // riding on the deck
    expect(gauge(w, compOf(joint, 'linearActuator').id)[0]).toBeCloseTo(2.6, 1);
    w.setAxes({ lift: -1 });
    run(w, 8);
    expect(w.getPose(deck.id)!.position[1] - y0).toBeCloseTo(0, 1);
  });
});

describe('hydraulic crane', () => {
  it('W raises the boom, releasing the key holds the payload where it is, S lowers it', async () => {
    const doc = scene('hydraulic-crane');
    const boom = named<BodyEntity>(doc, 'Boom');
    const angleOf = (w: PhysicsWorld) => {
      const q = w.getPose(boom.id)!.rotation;
      return (2 * Math.atan2(q[2], q[3])) / DEG;
    };
    const w = await PhysicsWorld.create(doc);
    run(w, 1);
    const a0 = angleOf(w);
    expect(Math.abs(a0 - 40)).toBeLessThan(2);
    press(w, ['KeyW'], 3);
    run(w, 0.3);
    const raised = angleOf(w);
    expect(raised).toBeGreaterThan(a0 + 8);
    run(w, 3);
    expect(Math.abs(angleOf(w) - raised)).toBeLessThan(1); // held by the trapped oil
    press(w, ['KeyS'], 3);
    run(w, 0.3);
    expect(angleOf(w)).toBeLessThan(raised - 8);
  });
});

void newDocument;

describe('rocket launch', () => {
  it('holds F and the rocket follows the rocket equation: v = v_e·ln(m₀/m) − g·t, losing the fuel mass as it goes', async () => {
    const doc = scene('rocket-launch');
    const rocket = named<BodyEntity>(doc, 'Rocket');
    const w = await PhysicsWorld.create(doc);
    run(w, 1);
    expect(Math.abs(w.getPose(rocket.id)!.linvel[1])).toBeLessThan(0.01); // sits on its pad until fired
    w.setKeys(['KeyF']);
    run(w, 6);
    const [thrust, throttle, fuel, mass, ve] = gauge(w, compOf(rocket, 'thruster').id);
    expect(thrust).toBeCloseTo(900, 0);
    expect(throttle).toBeCloseTo(100, 0);
    expect(ve).toBeCloseTo(432, 3);
    expect(Math.abs(fuel - (25 - (25 / 12) * 6))).toBeLessThan(0.5); // 12.5 kg left after 6 s (the thrust spools up over 0.15 s)
    expect(Math.abs(mass - (12 + 12.5))).toBeLessThan(0.5);
    // m₀ = 38.5 kg including the nose cone (a separate body, joined to the rocket); m is what the sim reports
    const total = mass + 1.5;
    const expected = 432 * Math.log(38.5 / total) - 9.81 * 6;
    expect(Math.abs(w.getPose(rocket.id)!.linvel[1] - expected)).toBeLessThan(0.5); // ≈ 106 m/s, to within 0.5 m/s
    run(w, 7);
    const burnout = w.getPose(rocket.id)!.linvel[1];
    expect(gauge(w, compOf(rocket, 'thruster').id)[0]).toBe(0);
    expect(gauge(w, compOf(rocket, 'thruster').id)[2]).toBeCloseTo(0, 6); // out of fuel
    expect(gauge(w, compOf(rocket, 'thruster').id)[3]).toBeCloseTo(12, 2); // only the dry mass is left
    // after burnout the climb is v_e·ln(38.5/13.5) − g·(time), the burn having ended a spool-up (0.15 s) late
    const flightTime = 13;
    expect(Math.abs(burnout - (432 * Math.log(38.5 / 13.5) - 9.81 * flightTime))).toBeLessThan(0.5); // ≈ 325 m/s
  });

  it('the throttle axis scales the thrust', async () => {
    const doc = scene('rocket-launch');
    const rocket = named<BodyEntity>(doc, 'Rocket');
    const w = await PhysicsWorld.create(doc);
    w.setAxes({ throttle: 0.5 });
    run(w, 2);
    expect(gauge(w, compOf(rocket, 'thruster').id)[0]).toBeCloseTo(450, 0);
  });
});

describe('jet car', () => {
  it('W spools the engine up and drives the cart; the afterburner adds thrust; thrust fades with speed', async () => {
    const doc = scene('jet-car');
    const car = named<BodyEntity>(doc, 'Jet car chassis');
    const w = await PhysicsWorld.create(doc);
    const jet = compOf(car, 'jet');
    w.setKeys(['KeyW']);
    run(w, 0.5);
    const early = gauge(w, jet.id);
    expect(early[1]).toBeLessThan(50); // still spooling up
    run(w, 3);
    const dry = gauge(w, jet.id);
    expect(dry[1]).toBeGreaterThan(90);
    expect(dry[0]).toBeGreaterThan(1500);
    const v1 = w.getPose(car.id)!.linvel[0];
    expect(v1).toBeGreaterThan(5);
    w.setKeys(['KeyW', 'ShiftLeft']);
    run(w, 1);
    const burner = gauge(w, jet.id);
    expect(burner[2]).toBe(1);
    expect(burner[0]).toBeGreaterThan(dry[0] * 1.3);
    w.setKeys(['KeyS']);
    run(w, 8);
    expect(Math.abs(w.getPose(car.id)!.linvel[0])).toBeLessThan(0.5); // the brakes stop it again
  });
});

describe('propeller cart', () => {
  it('the engine and the propeller settle where engine torque = C_Q·ρ·n²·D⁵, and the thrust pushes the cart', async () => {
    const doc = scene('propeller-cart');
    const car = named<BodyEntity>(doc, 'Propeller cart chassis');
    const w = await PhysicsWorld.create(doc);
    w.setKeys(['KeyW']);
    run(w, 4);
    const [rpm, thrust, torque] = gauge(w, compOf(car, 'propeller').id);
    expect(rpm).toBeGreaterThan(2000);
    expect(thrust).toBeGreaterThan(300);
    // at the equilibrium the load torque equals what the engine delivers
    const engine = gauge(w, compOf(car, 'engine').id);
    expect(torque).toBeCloseTo(engine[1], -1);
    expect(w.getPose(car.id)!.linvel[0]).toBeGreaterThan(3);
  });
});

describe('helicopter', () => {
  const tilt = (w: PhysicsWorld, id: string) => {
    const q = w.getPose(id)!.rotation;
    return (Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q[0] * q[0] + q[2] * q[2])))) * 180) / Math.PI;
  };

  it('spools up, sits on its skids at zero collective, lifts off when the collective is raised and comes down again', async () => {
    const doc = scene('helicopter');
    const heli = named<BodyEntity>(doc, 'Helicopter');
    const w = await PhysicsWorld.create(doc);
    const main = heli.components.filter((c) => c.type === 'rotor')[0];
    run(w, 5);
    expect(Math.abs(w.getPose(heli.id)!.position[1] - 0.55)).toBeLessThan(0.05); // collective 0: sits on its skids
    expect(gauge(w, main.id)[0]).toBeGreaterThan(330); // rpm: spooled up
    press(w, ['KeyR'], 2.5); // collective 0 → 0.75 at 0.3 / s
    run(w, 1.5);
    const up = w.getPose(heli.id)!;
    expect(up.position[1]).toBeGreaterThan(1.5);
    expect(up.linvel[1]).toBeGreaterThan(0.5);
    expect(tilt(w, heli.id)).toBeLessThan(15); // it climbs level, not on its side
    expect(Math.abs(up.angvel[1])).toBeLessThan(1.5); // the tail rotor answers most of the main rotor's torque
    press(w, ['KeyF'], 4);
    run(w, 6);
    expect(w.getPose(heli.id)!.linvel[1]).toBeLessThan(up.linvel[1]); // lowering the collective slows the climb
  });

  it('without its tail rotor the fuselage spins the other way (torque reaction)', async () => {
    const doc = scene('helicopter');
    const heli = named<BodyEntity>(doc, 'Helicopter');
    doc.entities = doc.entities.map((e) =>
      e.id === heli.id && e.kind === 'body'
        ? { ...e, components: e.components.filter((c, i) => i === 0 || c.type !== 'rotor') }
        : e,
    );
    const w = await PhysicsWorld.create(doc);
    run(w, 4);
    press(w, ['KeyR'], 2.5);
    run(w, 1);
    expect(w.getPose(heli.id)!.angvel[1]).toBeLessThan(-1.5); // spinning the opposite way, fast
  });

  it('cyclic tilts the disc: the arrow keys lean the thrust and the heli drifts that way', async () => {
    const doc = scene('helicopter');
    const heli = named<BodyEntity>(doc, 'Helicopter');
    const w = await PhysicsWorld.create(doc);
    run(w, 5);
    press(w, ['KeyR'], 2.5);
    const x0 = w.getPose(heli.id)!.position[0];
    press(w, ['ArrowUp'], 1.5); // pitch forward: the nose is +x
    run(w, 0.5);
    expect(w.getPose(heli.id)!.position[0]).toBeGreaterThan(x0 + 0.3);
  });
});

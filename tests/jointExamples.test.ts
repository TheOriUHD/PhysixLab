/**
 * JT-A: the example scenes of the ten new joint types (`src/model/content/joints-mechanisms.ts`), run headless in the
 * real engine and checked against physics: Atwood acceleration, gear / belt ratios, rack travel r·θ, screw advance
 * pitch·turns, winch lift and load rating, the cone of the ragdoll, the limited axes of a 6-DOF mount, spin carried
 * through two universal joints, and the sag m·g/k of soft welds. Every example (and prefab) also survives a save /
 * load round trip unchanged, stays finite and stays in the scene.
 */
import { describe, expect, it } from 'vitest';
import { getPrefab, getTemplate, listPrefabs, listTemplates } from '../src/model/content';
import { newDocument } from '../src/model/factory';
import { newReport } from '../src/model/errors';
import { parseDocument, serializeDocument } from '../src/model/serialize';
import { JT_A_TYPES } from '../src/model/jointParams';
import { PhysicsWorld } from '../src/physics/world';
import type { BodyEntity, JointEntity, SceneDocument } from '../src/model/types';

const G = 9.81;
const JT_IDS = [
  'jt-atwood',
  'jt-gear-train',
  'jt-belt-drive',
  'jt-rack-pinion',
  'jt-screw-jack',
  'jt-crane-winch',
  'jt-ragdoll-arms',
  'jt-sixdof-platform',
  'jt-cardan-shaft',
  'jt-soft-diving-board',
];

const build = (id: string): SceneDocument => {
  const t = getTemplate(id);
  if (!t) throw new Error(`template ${id} is not registered`);
  return t.build();
};
const body = (doc: SceneDocument, name: string): BodyEntity => {
  const e = doc.entities.find((x) => x.kind === 'body' && x.name === name);
  if (!e) throw new Error(`no body "${name}"`);
  return e as BodyEntity;
};
const joint = (doc: SceneDocument, name: string): JointEntity => {
  const e = doc.entities.find((x) => x.kind === 'joint' && x.name === name);
  if (!e) throw new Error(`no joint "${name}"`);
  return e as JointEntity;
};
const jointsOf = (doc: SceneDocument, type: string): JointEntity[] =>
  doc.entities.filter((x): x is JointEntity => x.kind === 'joint' && x.type === type);
const bodiesOf = (doc: SceneDocument): BodyEntity[] => doc.entities.filter((x): x is BodyEntity => x.kind === 'body');

const steps = (w: PhysicsWorld, sec: number, each?: (i: number) => void): void => {
  const n = Math.round(sec * w.settings.physicsHz);
  for (let i = 0; i < n; i++) {
    w.stepOnce();
    each?.(i);
  }
};
const start = (doc: SceneDocument): Promise<PhysicsWorld> => PhysicsWorld.create(doc);
const yawOf = (q: [number, number, number, number]): number => 2 * Math.asin(Math.max(-1, Math.min(1, q[1])));

describe('the library carries one example per new joint type', () => {
  it('registers all ten scenes, each with at least one joint of its type', () => {
    const ids = new Set(listTemplates().map((t) => t.id));
    for (const id of JT_IDS) expect(ids.has(id), id).toBe(true);
    const used = new Set<string>();
    for (const id of JT_IDS) for (const e of build(id).entities) if (e.kind === 'joint') used.add(e.type);
    for (const t of JT_A_TYPES) expect(used.has(t), `an example uses "${t}"`).toBe(true);
  });
});

describe('Atwood machine (pulley, JT-3)', () => {
  it('the heavier mass sinks at (m2 − m1)g/(m1 + m2), the rope carries 2 m1 m2 g/(m1 + m2)', async () => {
    const doc = build('jt-atwood');
    const light = body(doc, 'Light mass (2 kg)');
    const heavy = body(doc, 'Heavy mass (3 kg)');
    const rope = joint(doc, 'Rope over the pulley');
    const w = await start(doc);
    steps(w, 1);
    const a = ((3 - 2) * G) / (3 + 2);
    const dHeavy = heavy.position[1] - w.getPose(heavy.id)!.position[1];
    const dLight = w.getPose(light.id)!.position[1] - light.position[1];
    expect(dHeavy).toBeGreaterThan(0.5 * a * 0.95);
    expect(dHeavy).toBeLessThan(0.5 * a * 1.05);
    expect(dLight).toBeCloseTo(dHeavy, 2); // the rope length is conserved
    expect(w.getJointRec(rope.id)!.force / ((2 * 2 * 3 * G) / 5)).toBeCloseTo(1, 1);
  });
});

describe('gear train (gear, JT-4)', () => {
  it('each mesh reverses and applies its ratio: the output turns the same way at one third of the input speed', async () => {
    const doc = build('jt-gear-train');
    const gears = ['Input gear (0.4 m)', 'Idler gear (0.8 m)', 'Output gear (1.2 m)'].map((n) => body(doc, n));
    const w = await start(doc);
    steps(w, 2);
    const [wa, wb, wc] = gears.map((g) => w.getPose(g.id)!.angvel[2]);
    expect(wa).toBeGreaterThan(4); // the motor turns the input gear
    expect(wb / wa).toBeCloseTo(-0.4 / 0.8, 1); // reversed, ×1/2
    expect(wc / wb).toBeCloseTo(-0.8 / 1.2, 1); // reversed, ×2/3
    expect(wc / wa).toBeCloseTo(1 / 3, 1); // same direction, ÷3
  });
});

describe('belt and chain drive (belt, JT-5)', () => {
  it('the belt keeps the radius ratio, the loaded chain slips at its slip torque', async () => {
    const doc = build('jt-belt-drive');
    const bd = body(doc, 'Belt driver');
    const bn = body(doc, 'Belt driven');
    const cd = body(doc, 'Chain driver');
    const cn = body(doc, 'Chain driven');
    const chain = joint(doc, 'Chain (0.5 m → 0.5 m)');
    const w = await start(doc);
    steps(w, 2);
    const wBelt = w.getPose(bn.id)!.angvel[2] / w.getPose(bd.id)!.angvel[2];
    expect(wBelt).toBeCloseTo(0.35 / 0.7, 1); // r_A / r_B, same direction
    const wChain = w.getPose(cn.id)!.angvel[2] / w.getPose(cd.id)!.angvel[2];
    expect(wChain).toBeGreaterThan(0.1);
    expect(wChain).toBeLessThan(0.8); // slipping: a rigid 1:1 chain would give 1
    expect(w.getJointRec(chain.id)!.force).toBeCloseTo(chain.params.slipTorque, 0); // carries exactly the slip torque
  });
});

describe('rack and pinion (rack, JT-4)', () => {
  it('the rack travels r·θ and is stopped by its guide', async () => {
    const doc = build('jt-rack-pinion');
    const rack = body(doc, 'Rack');
    const pinion = joint(doc, 'Pinion axle');
    const w = await start(doc);
    steps(w, 1.5);
    const theta = w.getJointRec(pinion.id)!.value;
    const travel = w.getPose(rack.id)!.position[0] - rack.position[0];
    expect(Math.abs(theta)).toBeGreaterThan(0.8);
    expect(Math.abs(travel) / (0.4 * Math.abs(theta))).toBeGreaterThan(0.97);
    expect(Math.abs(travel) / (0.4 * Math.abs(theta))).toBeLessThan(1.03);
    steps(w, 4);
    const end = w.getPose(rack.id)!.position[0] - rack.position[0];
    expect(Math.abs(end)).toBeLessThan(1.0 + 0.06); // the slider limit
    expect(Math.abs(end)).toBeGreaterThan(0.9);
  });
});

describe('screw jack (screw, JT-7)', () => {
  const platformName = 'Platform (nut + 30 kg crate)';
  it('without gravity the platform advances exactly pitch × turns', async () => {
    const doc = build('jt-screw-jack');
    doc.settings = { ...doc.settings, gravity: [0, 0, 0] };
    const platform = body(doc, platformName);
    const drive = joint(doc, 'Spindle drive');
    const pitch = joint(doc, 'Thread (pitch 0.3 m)').params.pitch;
    const w = await start(doc);
    steps(w, 2);
    const turns = Math.abs(w.getJointRec(drive.id)!.value) / (2 * Math.PI);
    const rise = w.getPose(platform.id)!.position[1] - platform.position[1];
    expect(turns).toBeGreaterThan(1);
    expect(rise / (pitch * turns)).toBeGreaterThan(0.97);
    expect(rise / (pitch * turns)).toBeLessThan(1.03);
  });
  it('under load it lifts the 38 kg platform upwards, turn by turn (known: lags the kinematic value, see LIMITATIONS)', async () => {
    const doc = build('jt-screw-jack');
    const platform = body(doc, platformName);
    const drive = joint(doc, 'Spindle drive');
    const w = await start(doc);
    steps(w, 3);
    const turns = Math.abs(w.getJointRec(drive.id)!.value) / (2 * Math.PI);
    const rise = w.getPose(platform.id)!.position[1] - platform.position[1];
    expect(rise).toBeGreaterThan(0.2);
    expect(rise / (0.3 * turns)).toBeGreaterThan(0.6);
    expect(rise / (0.3 * turns)).toBeLessThan(1.03);
  });
});

describe('crane hoists (winch, JT-7)', () => {
  it('the rated hoist reels its crate in at the motor speed, the overloaded one pays out and lifts nothing', async () => {
    const doc = build('jt-crane-winch');
    const ok = body(doc, 'Hoist crate (25 kg)');
    const weak = body(doc, 'Overloaded hoist crate (25 kg)');
    const okJoint = joint(doc, 'Hoist (rating 600 N)');
    const weakJoint = joint(doc, 'Overloaded hoist (rating 120 N)');
    const w = await start(doc);
    steps(w, 1);
    const y1 = w.getPose(ok.id)!.position[1];
    steps(w, 3);
    const y4 = w.getPose(ok.id)!.position[1];
    expect((y4 - y1) / 3).toBeGreaterThan(0.45 * 0.9); // 0.45 m/s of rope
    expect((y4 - y1) / 3).toBeLessThan(0.45 * 1.05);
    expect(w.getJointRec(okJoint.id)!.force / (25 * G)).toBeCloseTo(1, 1); // the rope carries the crate's weight
    expect(w.getPose(weak.id)!.position[1]).toBeLessThan(weak.position[1] + 0.05);
    expect(w.getJointRec(weakJoint.id)!.force).toBeCloseTo(120, 0); // capped at the load rating
  });
});

describe('ragdoll arms (cone-twist, JT-1)', () => {
  it('the shoulders reach their swing cone and are stopped there, the elbows stay in their range', async () => {
    const doc = build('jt-ragdoll-arms');
    const shoulders = jointsOf(doc, 'conetwist');
    expect(shoulders.length).toBe(2);
    const elbows = doc.entities.filter(
      (e): e is JointEntity => e.kind === 'joint' && e.type === 'hinge' && e.name.startsWith('Elbow'),
    );
    const w = await start(doc);
    const peak = new Map<string, number>();
    const twist = new Map<string, number>();
    const elbowRange = { lo: 0, hi: 0 };
    steps(w, 4, () => {
      for (const s of shoulders) {
        const r = w.getJointRec(s.id)!;
        peak.set(s.id, Math.max(peak.get(s.id) ?? 0, r.value));
      }
      for (const e of elbows) {
        const v = w.getJointRec(e.id)!.value;
        elbowRange.lo = Math.min(elbowRange.lo, v);
        elbowRange.hi = Math.max(elbowRange.hi, v);
      }
    });
    for (const s of shoulders) {
      const p = peak.get(s.id)!;
      expect(p, `${s.name} swung out`).toBeGreaterThan(s.params.swing * 0.8);
      expect(p, `${s.name} stays inside the cone (speculative limit: a few cm of give)`).toBeLessThan(
        s.params.swing + 0.15,
      );
      twist.set(s.id, Math.abs(w.getJointRec(s.id)!.speed));
      expect(twist.get(s.id)!).toBeLessThan(s.params.twistMax + 0.15);
    }
    expect(elbowRange.lo).toBeGreaterThan(-2.2 - 0.1);
    expect(elbowRange.hi).toBeLessThan(0.1);
    expect(elbowRange.lo).toBeLessThan(-0.1); // and the right elbow did flex
  });
});

describe('spring-mounted platform (6-DOF, JT-2)', () => {
  const REST_Y = 1.7;
  it('heave and tilt move on springs inside their limits, the locked axes do not move', async () => {
    const doc = build('jt-sixdof-platform');
    const plat = body(doc, 'Platform (20 kg)');
    const j = jointsOf(doc, 'sixdof')[0];
    const w = await start(doc);
    let lowest = Infinity;
    let highest = -Infinity;
    let tilt = 0;
    let drift = 0;
    let yaw = 0;
    steps(w, 5, () => {
      const p = w.getPose(plat.id)!;
      lowest = Math.min(lowest, p.position[1]);
      highest = Math.max(highest, p.position[1]);
      tilt = Math.max(tilt, Math.abs(2 * Math.asin(p.rotation[0])), Math.abs(2 * Math.asin(p.rotation[2])));
      drift = Math.max(drift, Math.abs(p.position[0]), Math.abs(p.position[2]));
      yaw = Math.max(yaw, Math.abs(yawOf(p.rotation)));
    });
    const heave = j.params.dof[0];
    expect(lowest).toBeGreaterThan(REST_Y + heave.min - 0.05); // never through the lower limit
    expect(highest).toBeLessThan(REST_Y + heave.max + 0.05);
    expect(lowest).toBeLessThan(REST_Y - 0.15); // it did compress under the balls
    expect(tilt).toBeGreaterThan(0.03); // and tilt under off-centre hits
    expect(tilt).toBeLessThan(j.params.dof[4].max + 0.1);
    expect(drift).toBeLessThan(0.02); // X and Z are locked
    expect(yaw).toBeLessThan(0.05); // yaw is locked
  });
  it('settles at the static deflection m·g/k', async () => {
    const doc = build('jt-sixdof-platform');
    doc.entities = doc.entities.filter((e) => !(e.kind === 'body' && e.tags.includes('drop')));
    const plat = body(doc, 'Platform (20 kg)');
    const k = jointsOf(doc, 'sixdof')[0].params.dof[0].stiffness;
    const w = await start(doc);
    steps(w, 6);
    const sag = plat.position[1] - w.getPose(plat.id)!.position[1];
    expect(sag / ((20 * G) / k)).toBeGreaterThan(0.95);
    expect(sag / ((20 * G) / k)).toBeLessThan(1.05);
  });
});

describe('Cardan drive shaft (universal, JT-6)', () => {
  it('carries the spin of the input shaft round the jog to the flywheel while the middle shaft bends', async () => {
    const doc = build('jt-cardan-shaft');
    const input = body(doc, 'Input shaft');
    const mid = body(doc, 'Intermediate shaft');
    const output = body(doc, 'Output shaft');
    const fly = body(doc, 'Flywheel');
    const w = await start(doc);
    steps(w, 3);
    const wi = w.getPose(input.id)!.angvel[0];
    const wo = w.getPose(output.id)!.angvel[0];
    expect(wi).toBeGreaterThan(5);
    expect(wo / wi).toBeGreaterThan(0.97);
    expect(wo / wi).toBeLessThan(1.03);
    expect(w.getPose(fly.id)!.angvel[0] / wi).toBeCloseTo(1, 1);
    const m = w.getPose(mid.id)!;
    expect(Math.hypot(m.angvel[1], m.angvel[2])).toBeGreaterThan(0.5); // the jog shaft tumbles about the other axes
  });
});

describe('soft diving board (soft weld, JT-8)', () => {
  it('sags by the cantilever deflection of its welds, holds and stays still', async () => {
    const doc = build('jt-soft-diving-board');
    doc.entities = doc.entities.filter((e) => !(e.kind === 'body' && e.tags.includes('diver')));
    const planks = bodiesOf(doc).filter((b) => b.tags.includes('board'));
    const welds = jointsOf(doc, 'softweld');
    expect(welds.length).toBe(planks.length);
    const w = await start(doc);
    steps(w, 6);
    const y6 = w.getPose(planks[planks.length - 1].id)!.position[1];
    steps(w, 2);
    // Small-angle cantilever: each weld turns by M/kθ, M = weight outboard × lever; the centre of the end plank drops
    // Σ θ·(its distance from the weld). A chain of coupling rows is solved in one pass per step, so the real board sags
    // a little more than this (about 1.5× for two welds, see docs/LIMITATIONS.md): the band is [1, 1.8]×.
    const m = planks[0].massOverride!;
    const len = planks[0].shape.size[0];
    const k = welds[0].params.angStiffness;
    const n = planks.length;
    let expected = 0;
    for (let i = 0; i < n; i++) {
      let moment = 0;
      for (let p = i; p < n; p++) moment += m * G * (p + 0.5 - i) * len;
      expected += (moment / k) * (n - 0.5 - i) * len;
    }
    const tip = planks[n - 1];
    const drop = tip.position[1] - w.getPose(tip.id)!.position[1];
    expect(drop).toBeGreaterThan(expected * 0.95);
    expect(drop).toBeLessThan(expected * 1.8);
    expect(drop).toBeGreaterThan(0.1);
    expect(Math.abs(w.getPose(tip.id)!.position[1] - y6)).toBeLessThan(0.002); // at rest
    for (const j of welds) expect(w.getJointRec(j.id)!.value).toBeLessThan(0.1); // the weld itself stays together (a few cm of chain give)
  });
  it('bends further under the diver and recovers', async () => {
    const doc = build('jt-soft-diving-board');
    const tipName = 'Board segment 2';
    const tip = body(doc, tipName);
    const w = await start(doc);
    let lowest = Infinity;
    steps(w, 3, () => {
      lowest = Math.min(lowest, w.getPose(tip.id)!.position[1]);
    });
    const bare = build('jt-soft-diving-board');
    bare.entities = bare.entities.filter((e) => !(e.kind === 'body' && e.tags.includes('diver')));
    const w2 = await start(bare);
    steps(w2, 4);
    const bareDrop = tip.position[1] - w2.getPose(body(bare, tipName).id)!.position[1];
    expect(tip.position[1] - lowest).toBeGreaterThan(bareDrop);
    steps(w, 6);
    expect(w.getPose(tip.id)!.position[1]).toBeGreaterThan(tip.position[1] - 0.6);
  });
});

describe('every JT-A example and prefab is a well-formed document', () => {
  const jointParams = (doc: SceneDocument) =>
    doc.entities.filter((e): e is JointEntity => e.kind === 'joint').map((j) => JSON.stringify(j.params));

  for (const id of JT_IDS) {
    it(`${id}: save → load is lossless and warning-free, then it simulates without NaN or escapees`, async () => {
      const doc = build(id);
      const report = newReport();
      const loaded = parseDocument(serializeDocument(doc), report);
      expect(report.warnings, 'nothing had to be repaired').toEqual([]);
      expect(jointParams(loaded)).toEqual(jointParams(doc));
      for (const j of loaded.entities.filter((e): e is JointEntity => e.kind === 'joint'))
        expect(Object.keys(j.params).length).toBeGreaterThan(10);

      const w = await start(loaded);
      steps(w, 5);
      for (const b of bodiesOf(doc)) {
        const p = w.getPose(b.id)!;
        expect(p.position.every(Number.isFinite), `${b.name} finite`).toBe(true);
        expect(p.rotation.every(Number.isFinite), `${b.name} rotation finite`).toBe(true);
        expect(Math.abs(p.position[0]) < 60 && Math.abs(p.position[2]) < 60, `${b.name} stays in the scene`).toBe(true);
        expect(p.position[1] > -1 && p.position[1] < 60, `${b.name} stays above the ground`).toBe(true);
      }
      for (const j of doc.entities.filter((e): e is JointEntity => e.kind === 'joint')) {
        const r = w.getJointRec(j.id)!;
        expect(Number.isFinite(r.value) && Number.isFinite(r.speed) && Number.isFinite(r.force), j.name).toBe(true);
        expect(r.broken, `${j.name} did not break`).toBe(false);
      }
    });
  }

  for (const id of ['jt-gear-pair', 'jt-ragdoll-arm', 'jt-soft-board']) {
    it(`prefab ${id}: loads clean, simulates and keeps its joints`, async () => {
      const p = getPrefab(id);
      expect(p, id).toBeDefined();
      const doc = { ...newDocument(p!.name), entities: p!.build() };
      const report = newReport();
      const loaded = parseDocument(serializeDocument(doc), report);
      expect(report.warnings).toEqual([]);
      expect(jointParams(loaded)).toEqual(jointParams(doc));
      const w = await start(loaded);
      steps(w, 3);
      for (const b of bodiesOf(doc)) expect(w.getPose(b.id)!.position.every(Number.isFinite), b.name).toBe(true);
    });
  }

  it('the prefab library lists them', () => {
    const ids = new Set(listPrefabs().map((p) => p.id));
    for (const id of ['jt-gear-pair', 'jt-ragdoll-arm', 'jt-soft-board']) expect(ids.has(id)).toBe(true);
  });
});

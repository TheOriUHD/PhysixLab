import { describe, expect, it } from 'vitest';
import { newDocument } from '../src/model/factory';
import { newReport } from '../src/model/errors';
import { hasShape } from '../src/model/shapeRegistry';
import { listPrefabs, listTemplates } from '../src/model/content';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { PhysicsWorld } from '../src/physics/world';
import { qrot, type Quat, type Vec3 } from '../src/core/math';
import { buildCar } from '../src/model/templates';
import type { BodyEntity, SceneDocument } from '../src/model/types';

const log = (...a: unknown[]) =>
  process.stderr.write('\n' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const TEMPLATES = listTemplates();
const PREFABS = listPrefabs();
const byId = (id: string) => TEMPLATES.find((t) => t.id === id)!;
const nameOf = (doc: SceneDocument, name: string) => doc.entities.find((e) => e.name === name) as BodyEntity;
const run = (w: PhysicsWorld, s: number) => {
  for (let i = 0; i < Math.round(s * w.settings.physicsHz); i++) w.stepOnce();
};

describe('every example scene', () => {
  for (const t of TEMPLATES) {
    it(`${t.name}: round-trips, simulates without blow-ups`, async () => {
      const doc = t.build();
      const clean = sanitizeDocument(JSON.parse(JSON.stringify(doc)));
      expect(clean.entities.length).toBe(doc.entities.length);
      const w = await PhysicsWorld.create(clean);
      run(w, 4);
      const soft = w.readSoft();
      expect(soft.positions.every(Number.isFinite), 'soft particles are finite').toBe(true);
      for (const b of doc.entities) {
        if (b.kind !== 'body') continue;
        const p = w.getPose(b.id)!;
        expect(p.position.every(Number.isFinite), `${b.name} finite`).toBe(true);
        expect(Math.abs(p.position[0]) < 400 && Math.abs(p.position[2]) < 400, `${b.name} stays near the origin`).toBe(
          true,
        );
      }
    });
  }
});

/** Deep equality, except that numbers may differ in the last bits (the loader re-normalises quaternions). */
function expectSame(a: unknown, b: unknown, path: string): void {
  if (typeof a === 'number' && typeof b === 'number') {
    expect(Math.abs(a - b), path).toBeLessThan(1e-12);
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a).sort(), `${path} keys`).toEqual(Object.keys(b).sort());
    for (const k of Object.keys(a))
      expectSame((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
  } else {
    expect(a, path).toEqual(b);
  }
}

// `ShapeType` is a plain string (the registry decides what exists), so a typo in a template would not be a
// compile error — and would silently be drawn and simulated as a box. These tests are the safety net.
describe('bundled content only uses what the registries know', () => {
  const sources: [string, () => SceneDocument][] = [
    ...TEMPLATES.map((t): [string, () => SceneDocument] => [`example scene "${t.id}"`, () => t.build()]),
    ...PREFABS.map((p): [string, () => SceneDocument] => [
      `prefab "${p.id}"`,
      () => ({ ...newDocument(p.name), entities: p.build() }),
    ]),
  ];
  for (const [name, build] of sources) {
    it(`${name}: registered shapes, loads without repairs and saves back unchanged`, () => {
      const doc = build();
      for (const e of doc.entities) {
        if (e.kind !== 'body') continue;
        expect(hasShape(e.shape.type), `${e.name}: shape "${e.shape.type}" is registered`).toBe(true);
      }
      const report = newReport();
      const loaded = parseDocument(serializeDocument(doc), report);
      expect(report.warnings, 'nothing had to be repaired').toEqual([]);
      expectSame(loaded.entities, JSON.parse(JSON.stringify(doc.entities)), 'entities');
    });
  }
});

describe('soft-body scenes', () => {
  it('banner tears under the wrecking ball', async () => {
    const doc = byId('banner').build();
    const w = await PhysicsWorld.create(doc);
    const n0 = w.readSoft().layout![0].count;
    run(w, 3);
    const r = w.readSoft();
    log('banner particles', n0, '→', r.positions.length / 3, 'layout changed', !!r.layout);
    expect(r.layout).toBeDefined();
    expect(r.positions.length / 3).toBeGreaterThan(n0);
  });

  it('cloth drapes over the sphere instead of falling through it', async () => {
    const doc = byId('cloth').build();
    const w = await PhysicsWorld.create(doc);
    run(w, 4);
    const { positions } = w.readSoft();
    // Particles of the first (free) cloth: the first 22×22. None may be inside the sphere (centre y 1.3, r 0.8, x −3).
    let inside = 0;
    for (let i = 0; i < 22 * 22; i++) {
      const d = Math.hypot(positions[3 * i] + 3, positions[3 * i + 1] - 1.3, positions[3 * i + 2]);
      if (d < 0.78) inside++;
    }
    expect(inside).toBe(0);
  });

  it('jelly cubes of different stiffness deform differently', async () => {
    const doc = byId('jelly').build();
    const w = await PhysicsWorld.create(doc);
    const minHeight = [1e9, 1e9, 1e9];
    for (let i = 0; i < 120 * 3; i++) {
      w.stepOnce();
      if (i % 4) continue;
      const { positions } = w.readSoft();
      for (let k = 0; k < 3; k++) {
        let lo = 1e9,
          hi = -1e9;
        for (let n = 0; n < 125; n++) {
          const y = positions[3 * (k * 125 + n) + 1];
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
        if (i > 60) minHeight[k] = Math.min(minHeight[k], hi - lo);
      }
    }
    log('jelly min heights stiff/medium/soft', minHeight);
    expect(minHeight[2]).toBeLessThan(minHeight[0] - 0.05); // the soft cube squashes much more than the stiff one
  });
});

describe('scene behaviour', () => {
  it('car drives forward, stays upright and steers', async () => {
    const doc = byId('car').build();
    const chassis = nameOf(doc, 'Chassis');
    const w = await PhysicsWorld.create(doc);
    run(w, 1.5); // settle on the suspension
    const p0 = w.getPose(chassis.id)!;
    log('car settled', p0.position);
    expect(Math.abs(p0.position[1] - 0.52)).toBeLessThan(0.1);
    w.setKeys(['KeyW']);
    run(w, 2.5);
    const p1 = w.getPose(chassis.id)!;
    const up = qrot(p1.rotation, [0, 1, 0]);
    log('car after 2.5s W', p1.position, 'v', p1.linvel, 'up', up);
    expect(p1.position[0] - p0.position[0]).toBeGreaterThan(5);
    // upright: the track's ramp (17 degrees) can be under the car at this moment, so the bound only has to catch a flip
    expect(up[1]).toBeGreaterThan(0.9);
    // Steer left (A) from a standstill start in a fresh world.
    const w2 = await PhysicsWorld.create(doc);
    run(w2, 1.5);
    w2.setKeys(['KeyW', 'KeyA']);
    run(w2, 2.5);
    const q = w2.getPose(chassis.id)!;
    const fwd = qrot(q.rotation, [1, 0, 0]);
    log('car turning left: heading', fwd, 'pos', q.position);
    expect(fwd[2]).toBeLessThan(-0.2); // positive rotation about +Y turns the nose toward −Z
    // Reverse
    const w3 = await PhysicsWorld.create(doc);
    run(w3, 1.5);
    w3.setKeys(['KeyS']);
    run(w3, 2);
    expect(w3.getPose(chassis.id)!.position[0]).toBeLessThan(-2);
  });

  it("newton's cradle transfers momentum", async () => {
    const doc = byId('cradle').build();
    const w = await PhysicsWorld.create(doc);
    const first = nameOf(doc, 'Ball 1'),
      last = nameOf(doc, 'Ball 5');
    let maxLastX = -9,
      minFirstAfter = 9;
    for (let i = 0; i < 120 * 4; i++) {
      w.stepOnce();
      maxLastX = Math.max(maxLastX, w.getPose(last.id)!.position[0]);
      if (i > 120) minFirstAfter = Math.min(minFirstAfter, w.getPose(first.id)!.position[0]);
    }
    log('cradle: last ball max x', maxLastX, 'rest x', last.position[0]);
    expect(maxLastX).toBeGreaterThan(last.position[0] + 0.3);
  });

  it('double pendulum conserves energy', async () => {
    const doc = byId('double').build();
    const w = await PhysicsWorld.create(doc);
    const E = () => {
      w.readPoses(1);
      const e = w.stats().energy;
      return e.kinetic + e.rotational + e.potential;
    };
    const e0 = E();
    let worst = 0;
    for (let i = 0; i < 240 * 6; i++) {
      w.stepOnce();
      if (i % 24 === 0) worst = Math.max(worst, Math.abs(E() - e0));
    }
    log('double pendulum energy drift (J)', worst, 'E0', e0, 'KE+PE ranges');
    // measure relative to the swing of the potential energy
    expect(worst / Math.abs(e0)).toBeLessThan(0.01);
  });

  it('lever launcher throws the payload toward the crates', async () => {
    const doc = byId('lever').build();
    const w = await PhysicsWorld.create(doc);
    const ball = nameOf(doc, 'Payload');
    let maxX = -99,
      maxY = 0;
    for (let i = 0; i < 120 * 5; i++) {
      w.stepOnce();
      const p = w.getPose(ball.id)!.position;
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
    log('lever: payload max x', maxX, 'max y', maxY, 'final', w.getPose(ball.id)!.position);
    expect(maxX).toBeGreaterThan(8);
  });

  it('wrecking ball destroys part of the wall', async () => {
    const doc = byId('wreck').build();
    const w = await PhysicsWorld.create(doc);
    const bricks = doc.entities.filter((e) => e.name === 'Brick') as BodyEntity[];
    run(w, 6);
    const moved = bricks.filter((b) => {
      const p = w.getPose(b.id)!.position;
      return Math.hypot(p[0] - b.position[0], p[1] - b.position[1], p[2] - b.position[2]) > 0.3;
    }).length;
    log('wrecking ball displaced bricks', moved, 'of', bricks.length);
    expect(moved).toBeGreaterThan(8);
  });

  it('jenga tower stands until hit', async () => {
    const doc = byId('jenga').build();
    const w = await PhysicsWorld.create(doc);
    const blocks = doc.entities.filter((e) => e.name === 'Block') as BodyEntity[];
    run(w, 0.5);
    const drift = Math.max(
      ...blocks.map((b) => {
        const p = w.getPose(b.id)!.position;
        return Math.hypot(p[0] - b.position[0], p[1] - b.position[1], p[2] - b.position[2]);
      }),
    );
    log('jenga drift before impact', drift);
    expect(drift).toBeLessThan(0.05);
    run(w, 5);
    const toppled = blocks.filter((b) => w.getPose(b.id)!.position[1] < b.position[1] - 0.5).length;
    log('jenga blocks fallen after impact', toppled);
    expect(toppled).toBeGreaterThan(3);
  });

  it('friction lab: ice slides furthest, rubber stays', async () => {
    const doc = byId('friction').build();
    const w = await PhysicsWorld.create(doc);
    run(w, 2.5);
    const d = (n: string) => {
      const b = nameOf(doc, n);
      const p = w.getPose(b.id)!.position;
      return Math.hypot(p[0] - b.position[0], p[1] - b.position[1]);
    };
    const res = { ice: d('Ice block'), steel: d('Steel block'), wood: d('Wood block'), rubber: d('Rubber block') };
    log('friction lab distances', res);
    expect(res.ice).toBeGreaterThan(res.steel);
    expect(res.rubber).toBeLessThan(0.3);
  });

  it('billiards conserve momentum', async () => {
    const doc = byId('billiards').build();
    const w = await PhysicsWorld.create(doc);
    w.readPoses(1);
    const p0 = w.stats().energy.momentum;
    run(w, 3);
    w.readPoses(1);
    const p1 = w.stats().energy.momentum;
    log('billiards momentum', p0, p1);
    expect(Math.abs(p1[0] - p0[0]) / Math.abs(p0[0])).toBeLessThan(0.02);
  });

  it('piston press responds to the arrow keys', async () => {
    const doc = byId('piston').build();
    const w = await PhysicsWorld.create(doc);
    const ram = nameOf(doc, 'Ram');
    run(w, 1);
    expect(Math.abs(w.getPose(ram.id)!.position[1] - 3.4)).toBeLessThan(0.05);
    w.setKeys(['ArrowDown']);
    run(w, 2.5);
    const y = w.getPose(ram.id)!.position[1];
    log('ram y after pressing down', y);
    expect(y).toBeLessThan(2.4);
  });

  it('ball pit steps fast enough', async () => {
    const doc = byId('pit').build();
    const w = await PhysicsWorld.create(doc);
    const t0 = performance.now();
    run(w, 3);
    const ms = (performance.now() - t0) / (3 * 120);
    log('ball pit ms/step', ms);
    expect(ms).toBeLessThan(8);
  });
});
void ({} as Vec3);

describe('drivable car handling', () => {
  /** Run the car on a huge flat ground: throttle for `thr` seconds, then throttle + `key`; returns what the steering did. */
  async function steerTrial(key: 'KeyA' | 'KeyD', thr: number) {
    const doc = buildCar(false);
    doc.settings.ground.halfSize = 1000;
    const chassis = nameOf(doc, 'Chassis');
    const fl = doc.entities.find((e) => e.name === 'Front left steering')!;
    const fr = doc.entities.find((e) => e.name === 'Front right steering')!;
    const w = await PhysicsWorld.create(doc);
    run(w, 1.5);
    w.setKeys(['KeyW']);
    run(w, thr);
    const p0 = w.getPose(chassis.id)!;
    const heading = (q: Quat) => {
      const f = qrot(q, [1, 0, 0]);
      return Math.atan2(f[2], f[0]);
    };
    w.setKeys(['KeyW', key]);
    run(w, 1.25); // let the wheels swing over and the turn build up
    const h1 = heading(w.getPose(chassis.id)!.rotation);
    run(w, 0.75);
    const p1 = w.getPose(chassis.id)!;
    let dh = heading(p1.rotation) - h1;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    return {
      yawRate: (Math.abs(dh) * 180) / Math.PI / 0.75, // deg/s once the turn has settled
      up: qrot(p1.rotation, [0, 1, 0])[1],
      left: (w.getJointRec(fl.id)!.value * 180) / Math.PI,
      right: (w.getJointRec(fr.id)!.value * 180) / Math.PI,
      speed: Math.hypot(...p0.linvel),
    };
  }

  it('the front wheels reach a real steering lock (they used to jam against the body at ~8 degrees)', async () => {
    const r = await steerTrial('KeyA', 2);
    log('car lock A', r);
    expect(Math.abs(r.left)).toBeGreaterThan(25); // inner wheel
    expect(Math.abs(r.right)).toBeGreaterThan(17); // outer wheel
    expect(Math.abs(r.left)).toBeGreaterThan(Math.abs(r.right) + 4); // Ackermann: the inner wheel turns more
  });

  it('turns hard at every speed, to both sides, without tipping over', async () => {
    for (const thr of [0.8, 2, 5]) {
      const a = await steerTrial('KeyA', thr);
      const d = await steerTrial('KeyD', thr);
      log(
        `car turn rate after ${thr}s throttle: speed ${a.speed.toFixed(1)} A ${a.yawRate.toFixed(0)} D ${d.yawRate.toFixed(0)} deg/s`,
      );
      expect(a.yawRate).toBeGreaterThan(30); // deg/s (it was 5-20 before)
      expect(d.yawRate).toBeGreaterThan(30);
      // roughly symmetric: the drive torque leans the body one way, so the two sides differ a little but never by 2x
      expect(Math.abs(a.yawRate - d.yawRate) / Math.max(a.yawRate, d.yawRate)).toBeLessThan(0.5);
      expect(a.up).toBeGreaterThan(0.9);
      expect(d.up).toBeGreaterThan(0.9);
    }
  });

  it('a motor can deflect further one way than the other (targetPositionNeg)', async () => {
    const doc = buildCar(false);
    const joint = doc.entities.find((e) => e.name === 'Front left steering')!;
    if (joint.kind !== 'joint') throw new Error('not a joint');
    joint.motor.targetPosition = 0.2;
    joint.motor.targetPositionNeg = 0.5;
    const trial = async (key: string) => {
      const w = await PhysicsWorld.create(doc);
      run(w, 1.5);
      w.setKeys([key]);
      run(w, 1.2);
      return Math.abs(w.getJointRec(joint.id)!.value);
    };
    const pos = await trial('KeyA'); // + direction: 0.2 rad
    const neg = await trial('KeyD'); // − direction: 0.5 rad
    log('asymmetric steering', pos, neg);
    expect(neg).toBeGreaterThan(pos + 0.12);
  });

  it('the wheels and the body do not collide with each other but both still hit the world', () => {
    const doc = buildCar(false);
    const wheel = doc.entities.find((e) => e.name === 'Front left wheel');
    const chassis = doc.entities.find((e) => e.name === 'Chassis');
    if (wheel?.kind !== 'body' || chassis?.kind !== 'body') throw new Error('missing bodies');
    // each one's membership group is outside the other's filter, while the default group 0 is inside both
    expect(wheel.collision.mask & (1 << chassis.collision.group)).toBe(0);
    expect(chassis.collision.mask & (1 << wheel.collision.group)).toBe(0);
    expect(wheel.collision.mask & 1).toBe(1);
    expect(chassis.collision.mask & 1).toBe(1);
  });
});

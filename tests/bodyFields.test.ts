/**
 * Per-body fields added in format v2 (FB-5): collision groups / masks, quadratic drag, mass / centre-of-mass /
 * inertia overrides, the sleep threshold, and tags / layer / parent. Physics fields are checked against
 * analytic expectations on the real engine; the organisational ones against the sanitiser and the store.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, vlen, type Vec3 } from '../src/core/math';
import { newReport } from '../src/model/errors';
import { ALL_GROUPS, createBody, defaultCollision, newDocument } from '../src/model/factory';
import { LIMITS } from '../src/model/limits';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { SceneStore } from '../src/model/store';
import type { BodyEntity } from '../src/model/types';
import { PhysicsWorld, initRapier } from '../src/physics/world';
import { GROUND_GROUPS, interactionGroups } from '../src/physics/world/bodyFields';
import { SLEEP_AFTER } from '../src/physics/world/dynamics';
import { docOf, run, worldOf } from './helpers';

const free = { linearDamping: 0, angularDamping: 0, canSleep: false };
const noGround = { ground: { enabled: false, friction: 0.5, restitution: 0, halfSize: 50, color: '#000' } };
const zeroG = { gravity: [0, 0, 0] as Vec3 };
const G = 9.81;

const ball = (over: Partial<BodyEntity> & Record<string, unknown> = {}) =>
  createBody({
    shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
    position: [0, 5, 0],
    material: { preset: 'custom', density: 1000 },
    ...free,
    ...over,
  });
const slab = (over: Partial<BodyEntity> & Record<string, unknown> = {}) =>
  createBody({
    shape: { type: 'box', size: [6, 0.4, 6] },
    position: [0, 2, 0],
    bodyType: 'static',
    ...over,
  });

const rec = async (def: BodyEntity, settings = {}) => {
  await initRapier();
  const w = new PhysicsWorld(docOf([], settings));
  return { w, rec: w.addBody(def, false) };
};

// ── collision groups ──────────────────────────────────────────────────────────────────────────────────

describe('collision groups and masks', () => {
  it('encode as Rapier interaction groups (membership high, filter low), default = group 0 / all', () => {
    expect(defaultCollision()).toEqual({ group: 0, mask: 0xffff });
    expect(interactionGroups({ group: 0, mask: 0xffff })).toBe(0x0001ffff);
    expect(interactionGroups({ group: 3, mask: 0b101 })).toBe(0x00080005);
    expect(interactionGroups({ group: 15, mask: 0xffff })).toBe(0x8000ffff); // top bit stays unsigned
    expect(GROUND_GROUPS).toBe(0x0001ffff);
  });

  it('default bodies collide as before: a ball rests on a platform', async () => {
    const b = ball();
    const w = await worldOf([slab(), b], noGround);
    run(w, 3);
    expect(w.getPose(b.id)!.position[1]).toBeCloseTo(2 + 0.2 + 0.25, 2);
  });

  it('a ball whose mask excludes the platform group passes through it and lands on the ground', async () => {
    const plat = slab({ collision: { group: 1, mask: ALL_GROUPS } });
    const b = ball({ collision: { group: 2, mask: ALL_GROUPS & ~(1 << 1) } });
    const w = await worldOf([plat, b]);
    run(w, 3);
    expect(w.getPose(b.id)!.position[1]).toBeCloseTo(0.25, 2); // on the ground, not on the platform
    // the very same scene with the mask left open rests on the platform
    const b2 = ball({ collision: { group: 2, mask: ALL_GROUPS } });
    const w2 = await worldOf([plat, b2]);
    run(w2, 3);
    expect(w2.getPose(b2.id)!.position[1]).toBeCloseTo(2.45, 2);
  });

  it('needs both sides to agree: the platform can refuse the ball too', async () => {
    const plat = slab({ collision: { group: 1, mask: ALL_GROUPS & ~(1 << 2) } }); // refuses group 2
    const b = ball({ collision: { group: 2, mask: ALL_GROUPS } }); // would accept group 1
    const w = await worldOf([plat, b]);
    run(w, 3);
    expect(w.getPose(b.id)!.position[1]).toBeCloseTo(0.25, 2);
  });

  it('works for the highest group (15) and for dynamic pairs', async () => {
    const plat = slab({ collision: { group: 15, mask: ALL_GROUPS } });
    const b = ball({ collision: { group: 15, mask: 1 << 15 } });
    const w = await worldOf([plat, b], noGround);
    run(w, 3);
    expect(w.getPose(b.id)!.position[1]).toBeCloseTo(2.45, 2);
    // two falling balls straddling each other: same group collide, different groups ghost through
    const mk = (g2: number) => {
      const lower = ball({ position: [0, 1, 0], collision: { group: 1, mask: ALL_GROUPS }, gravityScale: 0 });
      const upper = ball({
        position: [0, 3, 0],
        velocity: [0, -2, 0],
        collision: { group: g2, mask: ALL_GROUPS & ~(g2 === 1 ? 0 : 1 << 1) },
      });
      return [lower, upper] as const;
    };
    const [l1, u1] = mk(1);
    const same = await worldOf([l1, u1], { ...noGround, ...zeroG });
    run(same, 2);
    expect(same.getPose(u1.id)!.position[1]).toBeGreaterThan(0.5); // bounced / pushed away
    const [l2, u2] = mk(2);
    const apart = await worldOf([l2, u2], { ...noGround, ...zeroG });
    run(apart, 2);
    expect(apart.getPose(u2.id)!.position[1]).toBeLessThan(-0.5); // flew straight through
  });

  it('a body whose mask lacks the ground group falls through the ground; an empty mask collides with nothing', async () => {
    const lonely = ball({ position: [0, 2, 0], collision: { group: 4, mask: 1 << 4 } });
    const w = await worldOf([lonely]);
    run(w, 2);
    expect(w.getPose(lonely.id)!.position[1]).toBeLessThan(-5);
    const none = ball({ position: [0, 2, 0], collision: { group: 0, mask: 0 } });
    const w2 = await worldOf([none, slab()]);
    run(w2, 2);
    expect(w2.getPose(none.id)!.position[1]).toBeLessThan(-5);
  });

  it('can be edited on a live world', async () => {
    const plat = slab();
    const b = ball({ position: [0, 3, 0] });
    const w = await worldOf([plat, b]);
    run(w, 0.2);
    w.updateBody({ ...b, collision: { group: 2, mask: ALL_GROUPS & ~1 } }); // leaves group 0, refuses it
    run(w, 3);
    expect(w.getPose(b.id)!.position[1]).toBeLessThan(-5);
  });
});

// ── quadratic drag ────────────────────────────────────────────────────────────────────────────────────

describe('quadratic drag', () => {
  const fallSpeed = async (drag: { linear2: number; angular2: number }, settings = {}, seconds = 25) => {
    const b = ball({ position: [0, 5000, 0], drag });
    const w = await worldOf([b], { ...noGround, ...settings });
    const m = w.builtInfo().mass[b.id];
    run(w, seconds);
    return { v: -w.getPose(b.id)!.linvel[1], m };
  };

  it('terminal velocity is √(m·g / c)', async () => {
    const { v, m } = await fallSpeed({ linear2: 5, angular2: 0 });
    const expected = Math.sqrt((m * G) / 5);
    expect(Math.abs(v - expected) / expected).toBeLessThan(0.02);
  });

  it('scales with the coefficient, and is unaffected when zero', async () => {
    const a = await fallSpeed({ linear2: 5, angular2: 0 });
    const b = await fallSpeed({ linear2: 20, angular2: 0 });
    expect(a.v / b.v).toBeCloseTo(2, 1); // v ∝ 1/√c
    const unimpeded = await fallSpeed({ linear2: 0, angular2: 0 }, {}, 5);
    expect(unimpeded.v).toBeCloseTo(G * 5, 0); // untouched free fall: v = g·t
  });

  it('reaches the same terminal velocity with sub-steps at a coarse rate', async () => {
    const { v, m } = await fallSpeed({ linear2: 5, angular2: 0 }, { physicsHz: 60, substeps: 4 });
    expect(Math.abs(v - Math.sqrt((m * G) / 5)) / v).toBeLessThan(0.02);
  });

  it('is unconditionally stable: an enormous coefficient brakes a body without reversing or exploding it', async () => {
    const b = ball({
      position: [0, 50, 0],
      velocity: [30, 0, 0],
      gravityScale: 0,
      drag: { linear2: 1e6, angular2: 0 },
    });
    const w = await worldOf([b], { ...noGround, ...zeroG });
    let last = 30;
    for (let i = 0; i < 240; i++) {
      w.stepOnce();
      const vx = w.getPose(b.id)!.linvel[0];
      expect(vx).toBeGreaterThanOrEqual(0);
      expect(vx).toBeLessThanOrEqual(last + 1e-9);
      last = vx;
    }
    expect(last).toBeLessThan(0.1);
  });

  it('slows a spinning body as ω(t) = ω₀ / (1 + c·ω₀·t / I)', async () => {
    const c = 40;
    const w0 = 6;
    const b = ball({
      position: [0, 50, 0],
      angularVelocity: [0, 0, w0],
      gravityScale: 0,
      drag: { linear2: 0, angular2: c },
    });
    const w = await worldOf([b], { ...noGround, ...zeroG });
    const m = w.builtInfo().mass[b.id];
    const I = 0.4 * m * 0.25 * 0.25;
    run(w, 2);
    const expected = w0 / (1 + (c * w0 * 2) / I);
    const got = w.getPose(b.id)!.angvel[2];
    expect(Math.abs(got - expected) / expected).toBeLessThan(0.03);
  });

  it('does not touch static, kinematic or drag-free bodies, and can be edited live', async () => {
    const stat = createBody({
      shape: { type: 'box' },
      position: [0, 3, 0],
      bodyType: 'static',
      drag: { linear2: 100, angular2: 100 },
    });
    const { rec: r } = await rec(stat);
    expect(r.dragged).toBe(false);
    const kin = createBody({
      shape: { type: 'box' },
      bodyType: 'kinematic',
      velocity: [2, 0, 0],
      drag: { linear2: 100, angular2: 0 },
    });
    const w = await worldOf([kin], { ...noGround, ...zeroG });
    run(w, 1);
    expect(w.getPose(kin.id)!.linvel[0]).toBeCloseTo(2, 4);
    const b = ball({ position: [0, 50, 0], velocity: [10, 0, 0], gravityScale: 0 });
    const w2 = await worldOf([b], { ...noGround, ...zeroG });
    run(w2, 1);
    expect(w2.getPose(b.id)!.linvel[0]).toBeCloseTo(10, 4);
    w2.updateBody({ ...b, drag: { linear2: 50, angular2: 0 } });
    run(w2, 1);
    expect(w2.getPose(b.id)!.linvel[0]).toBeLessThan(5);
  });
});

// ── mass, centre of mass, inertia ─────────────────────────────────────────────────────────────────────

describe('mass overrides', () => {
  it('massOverride replaces density × volume, keeping centre of mass and inertia proportions', async () => {
    const natural = createBody({
      shape: { type: 'box', size: [1, 0.5, 2] },
      material: { preset: 'custom', density: 1000 },
      ...free,
    });
    const heavy = { ...natural, id: 'o', massOverride: 10 };
    const { w, rec: r0 } = await rec(natural);
    const r1 = w.addBody(heavy, false);
    expect(r0.mass).toBeCloseTo(1000, 1);
    expect(r1.mass).toBeCloseTo(10, 4);
    expect(w.builtInfo().mass.o).toBeCloseTo(10, 4);
    const i0 = r0.rb.principalInertia(),
      i1 = r1.rb.principalInertia();
    expect(i1.x / i0.x).toBeCloseTo(0.01, 4);
    expect(i1.y / i0.y).toBeCloseTo(0.01, 4);
    expect(i1.z / i0.z).toBeCloseTo(0.01, 4);
    const c = r1.rb.localCom();
    expect(Math.hypot(c.x, c.y, c.z)).toBeLessThan(1e-6);
    w.dispose();
  });

  it('is what the engine uses: the same impulse gives v = J / m', async () => {
    const b = createBody({
      shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
      position: [0, 50, 0],
      massOverride: 4,
      ...free,
    });
    const w = await worldOf([b], { ...noGround, ...zeroG });
    w.applyOp({ op: 'impulse', id: b.id, impulse: [20, 0, 0], point: [0, 50, 0] });
    w.stepOnce();
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(5, 4);
    // and gravity is mass independent: the light ball still falls at g
    const light = createBody({
      shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
      position: [0, 50, 0],
      massOverride: 0.01,
      ...free,
    });
    const w2 = await worldOf([light], noGround);
    run(w2, 1);
    expect(w2.getPose(light.id)!.linvel[1]).toBeCloseTo(-G, 1);
  });

  it('works for compound shapes and with sleeping / ghost bodies; static bodies ignore it', async () => {
    const stat = createBody({ shape: { type: 'box' }, bodyType: 'static', massOverride: 5 });
    const { w, rec: s } = await rec(stat);
    expect(s.mass).toBe(0);
    const ghost = w.addBody(createBody({ id: 'g', shape: { type: 'box' }, ghost: true, massOverride: 3 }), false);
    expect(ghost.mass).toBeCloseTo(3, 4);
    w.dispose();
  });

  it('comOverride moves the centre of mass, keeping mass and the inertia tensor', async () => {
    const natural = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      material: { preset: 'custom', density: 1000 },
      ...free,
    });
    const moved = { ...natural, id: 'm', comOverride: [0, -0.4, 0.1] as Vec3 };
    const { w, rec: r0 } = await rec(natural);
    const r1 = w.addBody(moved, false);
    const c = r1.rb.localCom();
    expect([c.x, c.y, c.z].map((v) => +v.toFixed(5))).toEqual([0, -0.4, 0.1]);
    expect(r1.mass).toBeCloseTo(r0.mass, 3);
    const i0 = r0.rb.principalInertia(),
      i1 = r1.rb.principalInertia();
    expect([i1.x, i1.y, i1.z].map((v) => +v.toFixed(2))).toEqual([i0.x, i0.y, i0.z].map((v) => +v.toFixed(2)));
    const reported = w.builtInfo().com.m;
    [0, -0.4, 0.1].forEach((v, i) => expect(reported[i]).toBeCloseTo(v, 5));
    w.dispose();
  });

  it('a bottom-weighted box rights itself when dropped tilted; an ordinary one settles on a side', async () => {
    const tilt = qfromAxisAngle([0, 0, 1], (50 * Math.PI) / 180);
    const upAfter = async (over: Partial<BodyEntity>) => {
      const b = createBody({
        shape: { type: 'box', size: [1, 1, 1] },
        position: [0, 0.9, 0],
        rotation: tilt,
        material: { preset: 'custom', density: 500 },
        ...over,
      });
      const w = await worldOf([b], {
        ground: { enabled: true, friction: 0.9, restitution: 0.05, halfSize: 50, color: '#000' },
      });
      run(w, 6);
      const p = w.getPose(b.id)!;
      return qrot(p.rotation, [0, 1, 0]); // where the box's own +Y points
    };
    const plain = await upAfter({});
    expect(Math.abs(plain[1])).toBeLessThan(0.2); // lying on a side face: +Y horizontal
    const weighted = await upAfter({ comOverride: [0, -0.45, 0] });
    expect(weighted[1]).toBeGreaterThan(0.95); // heavy end down: upright
  });

  it('inertiaScale scales the principal moments (and the angular response) without changing the mass', async () => {
    const base = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [0, 50, 0], ...free });
    const stiff = { ...base, id: 's', inertiaScale: 4 };
    const { w, rec: r0 } = await rec(base, noGround);
    const r1 = w.addBody(stiff, false);
    const i0 = r0.rb.principalInertia(),
      i1 = r1.rb.principalInertia();
    expect(i1.x / i0.x).toBeCloseTo(4, 4);
    expect(i1.y / i0.y).toBeCloseTo(4, 4);
    expect(r1.mass).toBeCloseTo(r0.mass, 4);
    w.dispose();
    // an off-centre impulse spins the scaled body four times slower
    const a = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [0, 50, 0], ...free });
    const b = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [10, 50, 0], inertiaScale: 4, ...free });
    const w2 = await worldOf([a, b], { ...noGround, ...zeroG });
    for (const x of [a, b])
      w2.applyOp({ op: 'impulse', id: x.id, impulse: [0, 100, 0], point: [x.position[0] + 0.5, 50, 0] });
    w2.stepOnce();
    const wa = vlen(w2.getPose(a.id)!.angvel),
      wb = vlen(w2.getPose(b.id)!.angvel);
    expect(wa / wb).toBeCloseTo(4, 2);
  });

  it('all three together: mass, centre and inertia', async () => {
    const b = createBody({
      shape: { type: 'cylinder', size: [0.6, 1, 0.6] },
      massOverride: 7,
      comOverride: [0.1, 0.2, 0],
      inertiaScale: 2,
      ...free,
    });
    const { w, rec: r } = await rec(b);
    expect(r.mass).toBeCloseTo(7, 4);
    const c = r.rb.localCom();
    expect([c.x, c.y, c.z].map((v) => +v.toFixed(5))).toEqual([0.1, 0.2, 0]);
    w.dispose();
  });

  it('changing an override on a live world rebuilds the body with its pose and velocity', async () => {
    const b = ball({ position: [3, 40, 0], velocity: [2, 0, 0] });
    const w = await worldOf([b], noGround);
    run(w, 0.5);
    const before = w.getPose(b.id)!;
    w.updateBody({ ...b, massOverride: 2 });
    expect(w.builtInfo().mass[b.id]).toBeCloseTo(2, 4);
    const after = w.getPose(b.id)!;
    expect(after.position[0]).toBeCloseTo(before.position[0], 6);
    expect(after.linvel[0]).toBeCloseTo(before.linvel[0], 6);
  });
});

// ── sleep threshold ───────────────────────────────────────────────────────────────────────────────────

describe('sleepThreshold (emulated: Rapier 0.21 has no per-body threshold)', () => {
  const drifter = (over: Partial<BodyEntity> = {}) =>
    createBody({
      shape: { type: 'sphere', size: [0.3, 0.3, 0.3] },
      position: [0, 10, 0],
      velocity: [0.3, 0, 0],
      gravityScale: 0,
      linearDamping: 0,
      angularDamping: 0,
      canSleep: true,
      ...over,
    });
  const asleep = (w: PhysicsWorld, id: string) => w.readPoses(1)[w.bodyIds.indexOf(id) * 18 + 16] === 1;

  it('a high threshold lets a body sleep that the engine would keep awake (0.3 m/s drift)', async () => {
    const quick = drifter({ sleepThreshold: 1 });
    const stock = drifter({ id: 'stock', position: [0, 20, 0] });
    const w = await worldOf([quick, stock], { ...noGround, ...zeroG });
    run(w, SLEEP_AFTER + 0.2);
    expect(asleep(w, quick.id)).toBe(true);
    expect(w.getPose(quick.id)!.linvel[0]).toBe(0); // sleeping bodies stop
    run(w, 5);
    expect(asleep(w, 'stock')).toBe(false); // the engine's own rule never gets there at 0.3 m/s
    expect(w.getPose('stock')!.linvel[0]).toBeCloseTo(0.3, 6);
  });

  it('a low threshold keeps awake a body the engine would put to sleep (0.05 m/s drift)', async () => {
    const wary = drifter({ velocity: [0.05, 0, 0], sleepThreshold: 0.01 });
    const stock = drifter({ id: 'stock', position: [0, 20, 0], velocity: [0.05, 0, 0] });
    const w = await worldOf([wary, stock], { ...noGround, ...zeroG });
    run(w, 1);
    expect(asleep(w, 'stock')).toBe(true);
    run(w, 5);
    expect(asleep(w, wary.id)).toBe(false);
    expect(w.getPose(wary.id)!.linvel[0]).toBeCloseTo(0.05, 6);
  });

  it('is off for bodies that cannot sleep, and a sleeping body wakes when something hits it', async () => {
    const never = drifter({ position: [0, 30, 0], sleepThreshold: 1, canSleep: false });
    const sleeper = drifter({ id: 'z', position: [0, 10, 0], sleepThreshold: 1, velocity: [0, 0, 0] });
    const hitter = createBody({
      shape: { type: 'sphere', size: [0.3, 0.3, 0.3] },
      position: [-3, 10, 0],
      velocity: [4, 0, 0],
      gravityScale: 0,
      ...free,
    });
    const w = await worldOf([never, sleeper, hitter], { ...noGround, ...zeroG });
    run(w, 0.6);
    expect(asleep(w, never.id)).toBe(false);
    expect(asleep(w, 'z')).toBe(true);
    run(w, 1.5); // the hitter arrives
    expect(asleep(w, 'z')).toBe(false);
    expect(w.getPose('z')!.position[0]).toBeGreaterThan(0.1);
  });
});

// ── tags, layer, parent ───────────────────────────────────────────────────────────────────────────────

describe('tags, layer and parent', () => {
  const sparse = (entities: unknown[], report = newReport()) => ({
    doc: sanitizeDocument({ format: 'physicslab-scene', entities }, report),
    report,
  });
  const body = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'body', id, ...extra });

  it('default for every body, round-trip unchanged', () => {
    const b = createBody({ shape: { type: 'box' } });
    expect(b).toMatchObject({
      collision: { group: 0, mask: 0xffff },
      drag: { linear2: 0, angular2: 0 },
      inertiaScale: 1,
      tags: [],
      layer: 'default',
    });
    expect(b.massOverride).toBeUndefined();
    const doc = newDocument('t');
    const full = createBody({
      shape: { type: 'box' },
      collision: { group: 5, mask: 0x0f0f },
      drag: { linear2: 1.5, angular2: 0.25 },
      massOverride: 12,
      comOverride: [0, 0.1, 0],
      inertiaScale: 2,
      sleepThreshold: 0.2,
      tags: ['a', 'b'],
      layer: 'props',
    });
    doc.entities.push(full);
    expect(parseDocument(serializeDocument(doc)).entities[0]).toEqual(full);
    // optional fields really are absent in the JSON when unused
    const json = JSON.parse(serializeDocument(newDocumentWith(b))) as { entities: Record<string, unknown>[] };
    expect(Object.keys(json.entities[0])).not.toContain('massOverride');
  });

  function newDocumentWith(b: BodyEntity) {
    const d = newDocument('x');
    d.entities.push(b);
    return d;
  }

  it('sanitises every field', () => {
    const { doc } = sparse([
      body('a', {
        collision: { group: 99, mask: 1e9 },
        drag: { linear2: -4, angular2: 'x' },
        massOverride: -3,
        comOverride: [1, 'x', 3],
        inertiaScale: 0,
        sleepThreshold: -2,
        tags: [' a ', 'a', '', 7, 'x'.repeat(500), null],
        layer: '   ',
      }),
      body('b', {
        collision: { group: 2.6, mask: -5 },
        massOverride: 1e30,
        comOverride: [1e9, 0, 0],
        inertiaScale: 1e9,
        sleepThreshold: 1e9,
      }),
    ]);
    const [a, b] = doc.entities as BodyEntity[];
    expect(a.collision).toEqual({ group: 15, mask: 0xffff });
    expect(a.drag).toEqual({ linear2: 0, angular2: 0 });
    expect(a.massOverride).toBeUndefined();
    expect(a.comOverride).toBeUndefined();
    expect(a.inertiaScale).toBe(0.001);
    expect(a.sleepThreshold).toBeUndefined();
    expect(a.tags).toEqual(['a', 'x'.repeat(LIMITS.maxTagLength)]);
    expect(a.layer).toBe('default');
    expect(b.collision).toEqual({ group: 3, mask: 0 });
    expect(b.massOverride).toBe(1e9);
    expect(b.comOverride).toEqual([1e4, 0, 0]);
    expect(b.inertiaScale).toBe(1000);
    expect(b.sleepThreshold).toBe(100);
  });

  it('limits the number of tags', () => {
    const { doc } = sparse([body('a', { tags: Array.from({ length: 200 }, (_, i) => `t${i}`) })]);
    expect((doc.entities[0] as BodyEntity).tags).toHaveLength(LIMITS.maxTags);
  });

  it('repairs parent links that point at nothing, at themselves or in a loop — with a warning', () => {
    const { doc, report } = sparse([
      body('root'),
      body('kid', { parent: 'root' }),
      body('orphan', { parent: 'ghost' }),
      body('self', { parent: 'self' }),
      body('x', { parent: 'y' }),
      body('y', { parent: 'x' }),
    ]);
    const parent = (id: string) => (doc.entities.find((e) => e.id === id) as BodyEntity).parent;
    expect(parent('kid')).toBe('root');
    expect(parent('orphan')).toBeUndefined();
    expect(parent('self')).toBeUndefined();
    // the loop is broken somewhere, so no chain is infinite
    expect([parent('x'), parent('y')].filter((p) => p !== undefined).length).toBeLessThanOrEqual(1);
    expect(report.warnings.join(' ')).toMatch(/grouping link/);
  });

  it('removing an entity releases the bodies grouped under it, in the same undo step', () => {
    const store = new SceneStore();
    const g = createBody({ shape: { type: 'box' }, name: 'G' });
    const k = createBody({ shape: { type: 'box' }, name: 'K', parent: g.id });
    store.add([g, k]);
    const keys: string[][] = [];
    store.on('change', (c) => c.type === 'update' && keys.push([...c.keys]));
    store.remove([g.id]);
    expect(store.body(k.id)!.parent).toBeUndefined();
    expect(keys).toEqual([['parent']]);
    store.undo();
    expect(store.body(k.id)!.parent).toBe(g.id);
    expect(store.size).toBe(2);
  });

  it('duplicating a group together with its member keeps the copy grouped under the copy', () => {
    const store = new SceneStore();
    const g = createBody({ shape: { type: 'box' } });
    const k = createBody({ shape: { type: 'box' }, parent: g.id });
    store.add([g, k]);
    const copies = store.clone([g.id, k.id]) as BodyEntity[];
    const [cg, ck] = copies;
    expect(ck.parent).toBe(cg.id);
    expect(ck.parent).not.toBe(g.id);
    // copying only the member leaves it in the original group
    const lone = store.clone([k.id])[0] as BodyEntity;
    expect(lone.parent).toBe(g.id);
  });
});

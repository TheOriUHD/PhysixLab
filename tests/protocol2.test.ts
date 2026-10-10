/**
 * Protocol v2 in the physics world: the seeded RNG, the events channel (contact / sensor / component), published
 * component state, the custom channel, ray casts and snapshot / restore — each against analytic expectations or
 * exact determinism, not "it did not throw".
 */
import { describe, expect, it } from 'vitest';
import { vdist, vlen, type Vec3 } from '../src/core/math';
import { makeComponent, registerComponent } from '../src/model/componentRegistry';
import { createSoft, defaultSettings } from '../src/model/factory';
import { makePart } from '../src/model/compound';
import type { BodyEntity, ComponentSpec, JointEntity, SoftEntity } from '../src/model/types';
import { registerRuntime } from '../src/physics/components';
import { registerCustomChannel, unregisterCustomChannel } from '../src/physics/custom';
import {
  DEFAULT_EVENT_CONFIG,
  GROUND_ID,
  PROTOCOL_VERSION,
  type ContactEvent,
  type SensorEvent,
  type SimEvent,
} from '../src/physics/protocol';
import { createBody, createJoint, run, worldOf } from './helpers';

const NO_GROUND = { ground: { ...defaultSettings().ground, enabled: false } };
const NO_G = { gravity: [0, 0, 0] as Vec3, ...NO_GROUND };
const DT = 1 / 120;

const ball = (over: Parameters<typeof createBody>[0] = {}) =>
  createBody({
    shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
    position: [0, 5, 0],
    linearDamping: 0,
    angularDamping: 0,
    canSleep: false,
    ...over,
  });
const withComponents = (b: BodyEntity, ...components: ComponentSpec[]): BodyEntity => ({ ...b, components });
/** Step `seconds` in frames of `perFrame` fixed steps, draining events after each frame like the worker does. */
function frames(w: Awaited<ReturnType<typeof worldOf>>, seconds: number, perFrame = 2): SimEvent[] {
  const out: SimEvent[] = [];
  const n = Math.round(seconds * w.settings.physicsHz);
  for (let i = 0; i < n; i++) {
    w.stepOnce();
    if ((i + 1) % perFrame === 0) out.push(...w.drainEvents());
  }
  out.push(...w.drainEvents());
  return out;
}
const contacts = (events: SimEvent[]) => events.filter((e): e is ContactEvent => e.kind === 'contact');
const sensors = (events: SimEvent[]) => events.filter((e): e is SensorEvent => e.kind === 'sensor');

describe('protocol constants', () => {
  it('declares version 2 and a ground id that cannot clash with an entity id', () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(GROUND_ID.startsWith('$')).toBe(true);
    expect(DEFAULT_EVENT_CONFIG.contacts).toBe(false); // contact events are opt-in
  });
});

// ── seeded RNG ────────────────────────────────────────────────────────────────────────────────────

describe('seeded random numbers', () => {
  registerComponent({
    type: 'testDice',
    label: 'Dice',
    icon: 'component',
    category: 'Tests',
    blurb: '',
    appliesTo: 'body',
    fields: [],
  });
  const rolls: number[] = [];
  registerRuntime<null>({
    type: 'testDice',
    create: () => null,
    prestep: (_s, _dt, ctx) => void rolls.push(ctx.random()),
  });
  const dice = () => withComponents(ball({ position: [0, 0, 0] }), makeComponent('testDice'));

  it('ctx.random() draws from the world generator seeded by settings.seed: same seed, same numbers', async () => {
    rolls.length = 0;
    const a = await worldOf([dice()], { ...NO_G, seed: 1234 });
    run(a, 0.1);
    const first = [...rolls];
    rolls.length = 0;
    const b = await worldOf([dice()], { ...NO_G, seed: 1234 });
    run(b, 0.1);
    expect(rolls).toEqual(first);
    expect(first.length).toBe(12);
    rolls.length = 0;
    const c = await worldOf([dice()], { ...NO_G, seed: 99 });
    run(c, 0.1);
    expect(rolls).not.toEqual(first);
    for (const x of first) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('setSeed restarts the stream; changing the seed in the settings does too; the state is observable', async () => {
    rolls.length = 0;
    const w = await worldOf([dice()], { ...NO_G, seed: 5 });
    run(w, 0.05);
    const ref = [...rolls];
    w.applyOp({ op: 'setSeed', seed: 5 });
    rolls.length = 0;
    run(w, 0.05);
    expect(rolls).toEqual(ref);
    w.applyOp({ op: 'setSeed', seed: 6 });
    rolls.length = 0;
    run(w, 0.05);
    expect(rolls).not.toEqual(ref);
    // a different seed in the settings restarts the stream exactly like a fresh world with that seed
    rolls.length = 0;
    const fresh = await worldOf([dice()], { ...NO_G, seed: 77 });
    run(fresh, 0.05);
    const seed77 = [...rolls];
    w.applyOp({ op: 'settings', settings: { ...w.settings, seed: 77 } });
    rolls.length = 0;
    run(w, 0.05);
    expect(rolls).toEqual(seed77);
    expect(seed77).not.toEqual(ref);
    // an unchanged seed in a settings update does not restart it
    const before = w.rngState;
    w.applyOp({ op: 'settings', settings: { ...w.settings, airDrag: 0.1 } });
    expect(w.rngState).toBe(before);
    expect(w.random()).toBeLessThan(1);
  });
});

// ── contact events ────────────────────────────────────────────────────────────────────────────────

describe('contact events', () => {
  const drop = (over: Parameters<typeof createBody>[0] = {}) =>
    ball({
      position: [0, 2.25, 0],
      material: { preset: 'custom', density: 1000, restitution: 0.5, friction: 0.5 },
      ...over,
    });

  it('are off until asked for', async () => {
    const w = await worldOf([drop()]);
    run(w, 1.5);
    expect(contacts(w.drainEvents())).toEqual([]);
  });

  it('a ball dropped from 2 m reports one hit: ids, point, normal, impulse, speed and materials', async () => {
    const b = drop();
    const w = await worldOf([b]);
    w.configureEvents({ contacts: true, pairInterval: 100 });
    const ev = contacts(frames(w, 1.5));
    expect(ev).toHaveLength(1);
    const c = ev[0];
    expect(c).toMatchObject({ kind: 'contact', a: b.id, b: GROUND_ID, matB: 'ground', matA: 'custom' });
    expect(c.count).toBeGreaterThanOrEqual(1);
    // the ball bottom is at 2.0 m: v = √(2·g·h) at impact, the contact point is at the ground plane, below the ball
    const v = Math.sqrt(2 * 9.81 * 2);
    expect(c.speed).toBeGreaterThan(v * 0.95);
    expect(c.speed).toBeLessThan(v * 1.05);
    const mass = w.builtInfo().mass[b.id];
    // J = m·(1 + e)·v for a central impact; e = max(0.5, 0.1) in this engine's combine rule
    expect(c.impulse).toBeGreaterThan(mass * 1.5 * v * 0.95);
    expect(c.impulse).toBeLessThan(mass * 1.5 * v * 1.06);
    expect(c.normal[1]).toBeCloseTo(1, 3); // out of the ground, toward the ball
    expect(Math.abs(c.normal[0])).toBeLessThan(1e-3);
    expect(Math.abs(c.point[1])).toBeLessThan(0.02);
    expect(Math.hypot(c.point[0], c.point[2])).toBeLessThan(0.05);
    // it happened when the ball reached the floor: t = √(2h/g)
    expect(c.t).toBeCloseTo(Math.sqrt((2 * 2) / 9.81), 1);
  });

  it('are rate limited per pair (bounces within pairInterval merge into the first) and filtered by minImpulse', async () => {
    const b = drop();
    const slow = await worldOf([b]);
    slow.configureEvents({ contacts: true, pairInterval: 100 });
    expect(contacts(frames(slow, 3))).toHaveLength(1);

    const fast = await worldOf([drop()]);
    fast.configureEvents({ contacts: true, pairInterval: 0, minImpulse: 0 });
    const all = contacts(frames(fast, 3));
    expect(all.length).toBeGreaterThanOrEqual(3); // it bounces several times in three seconds
    // each bounce is weaker than the one before (restitution < 1)
    for (let i = 1; i < all.length; i++) expect(all[i].t).toBeGreaterThan(all[i - 1].t);

    const picky = await worldOf([drop()]);
    picky.configureEvents({ contacts: true, pairInterval: 0, minImpulse: 1e9 });
    expect(contacts(frames(picky, 3))).toEqual([]);
  });

  it('a resting body reports nothing after it settles, and a soft touch is below the default threshold', async () => {
    const rest = ball({ position: [0, 0.2501, 0], material: { preset: 'custom', density: 1000, restitution: 0 } });
    const w = await worldOf([rest]);
    w.configureEvents({ contacts: true });
    frames(w, 1);
    expect(contacts(frames(w, 2))).toEqual([]);
  });

  it('body-on-body: ordered older-first, normal pointing out of the lower body toward the upper one', async () => {
    const floor = createBody({
      shape: { type: 'box', size: [4, 0.4, 4] },
      bodyType: 'static',
      position: [0, 0.2, 0],
      material: { preset: 'steel' },
    });
    const top = ball({ position: [0, 3, 0], material: { preset: 'rubber' } });
    const w = await worldOf([floor, top], NO_GROUND);
    w.configureEvents({ contacts: true });
    const [c] = contacts(frames(w, 1));
    expect(c).toBeDefined();
    expect(c.a).toBe(floor.id); // the older body comes first…
    expect(c.b).toBe(top.id);
    expect(c.matA).toBe('steel');
    expect(c.matB).toBe('rubber');
    expect(c.normal[1]).toBeCloseTo(-1, 3); // …so the normal points out of `b` (the ball) down toward `a`
    // swap the creation order: the pair is reported the other way round, the normal flips with it
    const w2 = await worldOf([top, floor], NO_GROUND);
    w2.configureEvents({ contacts: true });
    const [c2] = contacts(frames(w2, 1));
    expect(c2.a).toBe(top.id);
    expect(c2.normal[1]).toBeCloseTo(1, 3);
  });

  it('the strongest events win when more than maxPerFrame occur in one frame', async () => {
    const balls = Array.from({ length: 6 }, (_, i) => drop({ position: [i * 2, 1 + i * 0.5, 0], name: `b${i}` }));
    const w = await worldOf(balls);
    w.configureEvents({ contacts: true, maxPerFrame: 2, pairInterval: 0 });
    // one frame spanning the whole fall: every hit lands in it, only the two strongest leave the worker
    for (let i = 0; i < Math.round(1.2 * 120); i++) w.stepOnce();
    const ev = contacts(w.drainEvents());
    expect(ev.length).toBe(2);
    expect(ev[0].impulse).toBeGreaterThanOrEqual(ev[1].impulse);
    // the two highest balls hit hardest
    expect(new Set(ev.map((e) => e.a))).toEqual(new Set([balls[5].id, balls[4].id]));
  });

  it('a component can ask for them (ctx.watchContacts) and receives onEvent for its own body', async () => {
    const seen: ContactEvent[] = [];
    registerComponent({
      type: 'testToucher',
      label: 'Toucher',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'body',
      fields: [],
    });
    registerRuntime<null>({
      type: 'testToucher',
      create: (ctx) => {
        ctx.watchContacts();
        return null;
      },
      onEvent: (_s, ev) => {
        if (ev.kind === 'contact') seen.push(ev);
      },
    });
    const b = withComponents(drop(), makeComponent('testToucher'));
    const bystander = drop({ position: [8, 1, 0] });
    const w = await worldOf([b, bystander]);
    run(w, 1.2);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((e) => e.a === b.id || e.b === b.id)).toBe(true); // not the other ball's own hit…
    // removing the component stops the world generating events again
    w.updateBody({ ...b, components: [] });
    w.drainEvents();
    seen.length = 0;
    w.applyOp({ op: 'teleport', id: b.id, position: [0, 2.25, 0], rotation: [0, 0, 0, 1] });
    run(w, 1.2);
    expect(contacts(w.drainEvents())).toEqual([]);
  });
});

// ── sensor events ─────────────────────────────────────────────────────────────────────────────────

describe('sensor events', () => {
  const zone = (over: Partial<BodyEntity> = {}) =>
    createBody({
      shape: { type: 'box', size: [2, 0.2, 2] },
      bodyType: 'static',
      position: [0, 2, 0],
      parts: [makePart({ id: 'trigger', shape: { type: 'box', size: [2, 2, 2] }, sensor: true })],
      ...over,
    });

  it('a falling body entering and leaving a sensor part reports enter then exit with the ids and the part', async () => {
    const z = zone();
    const b = ball({ position: [0, 5, 0] });
    const w = await worldOf([z, b], NO_GROUND);
    run(w, 1.2);
    const ev = sensors(w.drainEvents());
    expect(ev.map((e) => e.phase)).toEqual(['enter', 'exit']);
    for (const e of ev) expect(e).toMatchObject({ sensor: z.id, part: 'trigger', other: b.id });
    // free fall: it reaches the top of the 2 m box (y = 3) after √(2·(5−0.25−3)/g) s
    expect(ev[0].t).toBeCloseTo(Math.sqrt((2 * (5 - 0.25 - 3)) / 9.81), 1);
    expect(ev[1].t).toBeGreaterThan(ev[0].t);
    // the ball passed straight through: sensors do not push
    expect(w.getPose(b.id)!.position[1]).toBeLessThan(2);
  });

  it('are always on (no configuration needed) and a ghost body is a sensor too', async () => {
    const ghost = createBody({
      shape: { type: 'box', size: [2, 2, 2] },
      bodyType: 'static',
      ghost: true,
      position: [0, 1, 0],
    });
    const b = ball({ position: [0, 4, 0] });
    const w = await worldOf([ghost, b], NO_GROUND);
    run(w, 1);
    const ev = sensors(w.drainEvents());
    expect(ev.map((e) => `${e.phase}:${e.sensor}:${e.other}`)).toEqual([
      `enter:${ghost.id}:${b.id}`,
      `exit:${ghost.id}:${b.id}`,
    ]);
    expect(ev[0].part).toBeUndefined();
  });

  it('a body removed while inside still produces its exit event, naming it', async () => {
    const z = zone();
    const b = ball({ position: [0, 2, 0] }); // floats inside the zone (no gravity)
    const w = await worldOf([z, b], NO_G);
    run(w, 0.1);
    expect(sensors(w.drainEvents()).map((e) => e.phase)).toEqual(['enter']);
    w.removeEntities([b.id]);
    run(w, 0.05);
    const ev = sensors(w.drainEvents());
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ phase: 'exit', sensor: z.id, other: b.id });
  });

  it('are offered to the components of both bodies (zone logic needs them)', async () => {
    const got: string[] = [];
    registerComponent({
      type: 'testZone',
      label: 'Zone probe',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'body',
      fields: [],
    });
    registerRuntime<null>({
      type: 'testZone',
      create: () => null,
      onEvent: (_s, ev, ctx) => {
        if (ev.kind === 'sensor') got.push(`${ctx.ownerId}<-${ev.phase}`);
      },
    });
    const z = withComponents(zone(), makeComponent('testZone'));
    const b = withComponents(ball({ position: [0, 5, 0] }), makeComponent('testZone'));
    const w = await worldOf([z, b], NO_GROUND);
    run(w, 1.2);
    expect(got).toEqual([`${z.id}<-enter`, `${b.id}<-enter`, `${z.id}<-exit`, `${b.id}<-exit`]);
  });
});

// ── component events, state and the custom channel ────────────────────────────────────────────────

describe('component events and state', () => {
  it('ctx.emit raises a component event with owner, component, type, name and data', async () => {
    registerComponent({
      type: 'testEmit',
      label: 'Emitter',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'body',
      fields: [],
    });
    registerRuntime<null>({
      type: 'testEmit',
      create: () => null,
      poststep: (_s, _dt, ctx) => {
        if (ctx.step === 3) ctx.emit('lap', { n: 7 });
      },
    });
    const c = makeComponent('testEmit');
    const b = withComponents(ball(), c);
    const w = await worldOf([b], NO_G);
    run(w, 0.1);
    const ev = w.drainEvents().filter((e) => e.kind === 'component');
    expect(ev).toEqual([
      { kind: 'component', t: 3 * DT, owner: b.id, component: c.id, type: 'testEmit', name: 'lap', data: { n: 7 } },
    ]);
  });

  it('numbers and JSON published through ctx.state arrive once per change, and are withdrawn with the component', async () => {
    registerComponent({
      type: 'testGauge',
      label: 'Gauge',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'body',
      fields: [],
    });
    registerRuntime<null>({
      type: 'testGauge',
      create: () => null,
      poststep: (_s, _dt, ctx) => {
        ctx.state.set([ctx.step, ctx.body!.linvel()[1]]);
        ctx.state.setJson({ falling: ctx.body!.linvel()[1] < 0 });
      },
    });
    const c = makeComponent('testGauge');
    const b = withComponents(ball(), c);
    const w = await worldOf([b], NO_GROUND);
    run(w, 0.05); // 6 steps
    const first = w.drainComponentState().changed[c.id];
    expect(first.owner).toBe(b.id);
    expect(first.values![0]).toBe(6);
    expect(first.values![1]).toBeCloseTo(-9.81 * 6 * DT, 4);
    expect(first.json).toEqual({ falling: true });
    expect(w.drainComponentState().changed).toEqual({}); // nothing changed since
    w.stepOnce();
    expect(w.drainComponentState().changed[c.id].values![0]).toBe(7);
    // the snapshot of values handed out is a copy: later steps do not mutate what was already delivered
    expect(first.values![0]).toBe(6);
    w.removeEntities([b.id]);
    expect(w.drainComponentState().removed).toEqual([c.id]);
  });
});

describe('custom channel', () => {
  it('routes a message to the handler registered for its channel and returns its replies', async () => {
    registerCustomChannel('test:echo', (data, api) => {
      api.reply('test:echo', { got: data, bodies: api.world.bodyIds.length });
      api.reply('test:other', 'second');
    });
    try {
      const w = await worldOf([ball(), ball({ position: [3, 5, 0] })]);
      expect(w.custom('test:echo', { hello: 1 })).toEqual([
        { channel: 'test:echo', data: { got: { hello: 1 }, bodies: 2 } },
        { channel: 'test:other', data: 'second' },
      ]);
      expect(w.custom('test:nobody', 1)).toEqual([]);
      expect(() => registerCustomChannel('test:echo', () => undefined)).toThrow(/already registered/);
      expect(() => registerCustomChannel('', () => undefined)).toThrow(/needs a name/);
    } finally {
      unregisterCustomChannel('test:echo');
    }
  });
});

// ── ray casts ─────────────────────────────────────────────────────────────────────────────────────

describe('ray casts', () => {
  const crate = () => createBody({ shape: { type: 'box', size: [2, 2, 2] }, bodyType: 'static', position: [0, 1, 0] });

  it('hit the nearest surface: id, distance, point and a normal facing the ray', async () => {
    const c = crate();
    const w = await worldOf([c], NO_GROUND);
    const hit = w.raycast([0.3, 10, 0.2], [0, -1, 0], 50)!;
    expect(hit.id).toBe(c.id);
    expect(hit.distance).toBeCloseTo(8, 5);
    expect(hit.point[1]).toBeCloseTo(2, 5);
    expect(hit.point[0]).toBeCloseTo(0.3, 5);
    expect(hit.normal).toEqual([0, 1, 0]);
    // the direction need not be normalised
    expect(w.raycast([0.3, 10, 0.2], [0, -5, 0], 50)!.distance).toBeCloseTo(8, 5);
    // from the side
    const side = w.raycast([-10, 1, 0], [1, 0, 0], 50)!;
    expect(side.distance).toBeCloseTo(9, 5);
    expect(side.normal).toEqual([-1, 0, 0]);
  });

  it('see the ground, honour maxDist, miss cleanly and refuse a zero direction', async () => {
    const w = await worldOf([crate()]);
    const g = w.raycast([5, 4, 5], [0, -1, 0], 50)!;
    expect(g.id).toBe(GROUND_ID);
    expect(g.distance).toBeCloseTo(4, 5);
    expect(w.raycast([5, 4, 5], [0, -1, 0], 3)).toBeNull();
    expect(w.raycast([0, 10, 0], [0, 1, 0], 100)).toBeNull();
    expect(w.raycast([0, 10, 0], [0, 0, 0], 100)).toBeNull();
    expect(w.raycast([0, 10, 0], [0, -1, 0], 0)).toBeNull();
  });

  it('can ignore bodies and skips sensors unless asked', async () => {
    const front = createBody({ shape: { type: 'box', size: [1, 1, 1] }, bodyType: 'static', position: [0, 5, 0] });
    const back = createBody({ shape: { type: 'box', size: [1, 1, 1] }, bodyType: 'static', position: [0, 2, 0] });
    const w = await worldOf([front, back], NO_GROUND);
    expect(w.raycast([0, 10, 0], [0, -1, 0], 50)!.id).toBe(front.id);
    expect(w.raycast([0, 10, 0], [0, -1, 0], 50, { ignore: [front.id] })!.id).toBe(back.id);
    expect(w.raycast([0, 10, 0], [0, -1, 0], 50, { ignore: [front.id, back.id] })).toBeNull();
    const ghost = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      bodyType: 'static',
      ghost: true,
      position: [4, 2, 0],
    });
    const w2 = await worldOf([ghost], NO_GROUND);
    expect(w2.raycast([4, 10, 0], [0, -1, 0], 50)).toBeNull();
    expect(w2.raycast([4, 10, 0], [0, -1, 0], 50, { sensors: true })!.id).toBe(ghost.id);
  });

  it('report the compound part that was hit', async () => {
    const body = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      bodyType: 'static',
      position: [0, 1, 0],
      parts: [
        makePart({ id: 'left', shape: { type: 'box', size: [1, 1, 1] }, position: [-2, 0, 0] }),
        makePart({ id: 'right', shape: { type: 'box', size: [1, 1, 1] }, position: [2, 0, 0] }),
      ],
    });
    const w = await worldOf([body], NO_GROUND);
    expect(w.raycast([2, 10, 0], [0, -1, 0], 50)).toMatchObject({ id: body.id, part: 'right' });
    expect(w.raycast([-2, 10, 0], [0, -1, 0], 50)).toMatchObject({ id: body.id, part: 'left' });
  });

  it('see bodies added or removed since the last step (the query structures are refreshed first)', async () => {
    const w = await worldOf([], NO_GROUND);
    expect(w.raycast([0, 10, 0], [0, -1, 0], 50)).toBeNull();
    const c = crate();
    w.addBody(c, false); // no step has run since
    expect(w.raycast([0, 10, 0], [0, -1, 0], 50)!.id).toBe(c.id);
    w.removeEntities([c.id]);
    expect(w.raycast([0, 10, 0], [0, -1, 0], 50)).toBeNull();
    w.addBody(c, false);
    w.applyOp({ op: 'teleport', id: c.id, position: [20, 1, 0], rotation: [0, 0, 0, 1] });
    expect(w.raycast([0, 10, 0], [0, -1, 0], 50)).toBeNull();
    expect(w.raycast([20, 10, 0], [0, -1, 0], 50)!.id).toBe(c.id);
    expect(w.simTime).toBe(0); // looking does not advance time
  });

  it('answer the raycast op by request id (one reply per request, drained once)', async () => {
    const c = crate();
    const w = await worldOf([c], NO_GROUND);
    w.applyOp({ op: 'raycast', id: 7, origin: [0, 10, 0], dir: [0, -1, 0], maxDist: 50 });
    w.applyOp({ op: 'raycast', id: 8, origin: [50, 10, 0], dir: [0, -1, 0], maxDist: 50 });
    const r = w.drainReplies();
    expect(r.raycasts.map((x) => x.id)).toEqual([7, 8]);
    expect(r.raycasts[0].hit?.id).toBe(c.id);
    expect(r.raycasts[1].hit).toBeNull();
    expect(w.drainReplies().raycasts).toEqual([]);
  });

  it('ctx.raycast gives components the same answer (a downward distance sensor)', async () => {
    registerComponent({
      type: 'testAltimeter',
      label: 'Altimeter',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'body',
      fields: [],
    });
    registerRuntime<null>({
      type: 'testAltimeter',
      create: () => null,
      poststep: (_s, _dt, ctx) => {
        const p = ctx.body!.position();
        const hit = ctx.raycast([p[0], p[1] - 0.26, p[2]], [0, -1, 0], 100, { ignore: [ctx.ownerId] });
        ctx.state.set([hit ? hit.distance : -1]);
      },
    });
    const c = makeComponent('testAltimeter');
    const b = withComponents(ball({ position: [0, 3.26, 0], bodyType: 'kinematic' }), c);
    const w = await worldOf([b]);
    run(w, 0.05);
    expect(w.drainComponentState().changed[c.id].values![0]).toBeCloseTo(3, 2);
  });
});

// ── snapshots ─────────────────────────────────────────────────────────────────────────────────────

describe('snapshot / restore', () => {
  /** A busy scene: stack, hinge with a motor, spring, compound body, drag, a component, a soft body. */
  const scene = () => {
    const stack = Array.from({ length: 4 }, (_, i) =>
      createBody({
        name: `box${i}`,
        shape: { type: 'box', size: [0.8, 0.5, 0.8] },
        position: [0.05 * i, 0.25 + i * 0.52, 0],
        material: { preset: 'wood' },
      }),
    );
    const anchor = createBody({
      name: 'anchor',
      shape: { type: 'box', size: [0.3, 0.3, 0.3] },
      bodyType: 'static',
      position: [6, 4, 0],
    });
    const arm = createBody({ name: 'arm', shape: { type: 'box', size: [2, 0.2, 0.2] }, position: [7, 4, 0] });
    const hinge: JointEntity = createJoint({
      type: 'hinge',
      bodyA: anchor.id,
      bodyB: arm.id,
      anchorA: [0.5, 0, 0],
      axis: [0, 0, 1],
    });
    hinge.motor = { ...hinge.motor, mode: 'velocity', targetVelocity: 2, maxForce: 500 };
    const hanging = createBody({ name: 'bob', shape: { type: 'sphere', size: [0.4, 0.4, 0.4] }, position: [-4, 3, 0] });
    const spring: JointEntity = createJoint({
      type: 'spring',
      bodyA: null,
      bodyB: hanging.id,
      anchorA: [-4, 5, 0],
      anchorB: [0, 0, 0],
    });
    spring.spring = { restLength: 1.5, stiffness: 300, damping: 4, breakForce: 0 };
    const dumbbell = createBody({
      name: 'dumbbell',
      shape: { type: 'box', size: [1.6, 0.4, 0.4] },
      position: [-1, 3, 3],
      drag: { linear2: 0.5, angular2: 0.1 },
      parts: [
        makePart({ shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [-0.6, 0, 0] }),
        makePart({ shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [0.6, 0, 0] }),
      ],
    });
    const pushed = withComponents(
      createBody({
        name: 'pushed',
        shape: { type: 'box', size: [0.5, 0.5, 0.5] },
        position: [3, 0.25, 3],
        material: { preset: 'custom', density: 100, friction: 0.2 },
      }),
      makeComponent('constantForce', { force: [150, 0, 0] }),
    );
    return [...stack, anchor, arm, hinge, hanging, spring, dumbbell, pushed];
  };

  /** Every observable number of a world, for bit-exact comparison. */
  const observe = (w: Awaited<ReturnType<typeof worldOf>>) => ({
    bodies: w.bodyIds.map((id) => {
      const p = w.getPose(id)!;
      return [id, ...p.position, ...p.rotation, ...p.linvel, ...p.angvel];
    }),
    joints: w.jointIds.map((id) => {
      const j = w.getJointRec(id)!;
      return [id, j.value, j.speed, j.force, j.broken];
    }),
    simTime: w.simTime,
    steps: w.stepCount,
    rng: w.rngState,
  });

  it('run N steps, snapshot, run M more, restore, run M again → identical to the last bit', async () => {
    const w = await worldOf(scene());
    run(w, 1);
    const snap = w.snapshot();
    expect(snap.version).toBe(1);
    expect(snap.rapier.byteLength).toBeGreaterThan(100);
    run(w, 1.5);
    const first = observe(w);
    w.restore(snap);
    expect(w.stepCount).toBe(snap.stepCount);
    run(w, 1.5);
    expect(observe(w)).toEqual(first);
    // and again, from the same snapshot (restoring does not consume it)
    w.restore(snap);
    run(w, 1.5);
    expect(observe(w)).toEqual(first);
  });

  it('a snapshot restored into a brand-new world continues exactly like the original (and survives postMessage)', async () => {
    const entities = scene(); // one set of definitions (and ids) for all three worlds
    const straight = await worldOf(entities);
    run(straight, 2.5);
    const original = await worldOf(entities);
    run(original, 1);
    const wire = structuredClone(original.snapshot()); // what a worker message does to it
    const other = await worldOf([]); // an empty world: restoring replaces its contents wholesale
    other.restore(wire);
    run(other, 1.5);
    expect(observe(other)).toEqual(observe(straight));
  });

  it('brings back removed bodies and removes added ones; clock and RNG go back too', async () => {
    const [first, ...rest] = scene();
    const w = await worldOf([first, ...rest]);
    run(w, 0.5);
    w.random();
    const snap = w.snapshot();
    const idsThen = [...w.bodyIds];
    const rngThen = w.rngState;
    w.removeEntities([first.id]);
    w.addBody(ball({ id: 'late', position: [0, 9, 0] }), false);
    run(w, 0.5);
    w.random();
    expect(w.bodyIds).not.toEqual(idsThen);
    w.restore(snap);
    expect(w.bodyIds).toEqual(idsThen);
    expect(w.getPose('late')).toBeNull();
    expect(w.getPose(first.id)).not.toBeNull();
    expect(w.simTime).toBeCloseTo(0.5, 9);
    expect(w.rngState).toBe(rngThen);
    run(w, 0.5); // the restored world steps normally
    expect(w.getPose(first.id)!.position.every(Number.isFinite)).toBe(true);
  });

  it('restores joints (motor cache, hinge angle), compound parts and components that were running', async () => {
    const entities = scene();
    const hinge = entities.find((e) => e.kind === 'joint' && e.type === 'hinge')!;
    const dumbbell = entities.find((e) => e.name === 'dumbbell') as BodyEntity;
    const pushed = entities.find((e) => e.name === 'pushed') as BodyEntity;
    const w = await worldOf(entities);
    run(w, 1);
    const snap = w.snapshot();
    const angle = w.getJointRec(hinge.id)!.value;
    expect(Math.abs(angle)).toBeGreaterThan(0.1); // the motor turned it
    run(w, 1);
    w.restore(snap);
    expect(w.getJointRec(hinge.id)!.value).toBeCloseTo(angle, 12);
    expect(w.isComponentRunning(pushed.components[0].id)).toBe(true);
    // the compound body still has its two sphere colliders
    expect(snap.bodies.find((b) => b.def.id === dumbbell.id)!.cols).toHaveLength(2);
    const v0 = w.getPose(pushed.id)!.linvel[0];
    run(w, 0.5);
    expect(w.getPose(pushed.id)!.linvel[0]).toBeGreaterThan(v0); // the force keeps pushing it
  });

  it('components with saveState / loadState get their own state back', async () => {
    registerComponent({
      type: 'testCounter',
      label: 'Counter',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'body',
      fields: [],
    });
    registerRuntime<{ n: number }>({
      type: 'testCounter',
      create: () => ({ n: 0 }),
      prestep: (s) => void s.n++,
      poststep: (s, _dt, ctx) => ctx.state.set([s.n]),
      saveState: (s) => s.n,
      loadState: (s, data) => void (s.n = data as number),
    });
    const c = makeComponent('testCounter');
    const w = await worldOf([withComponents(ball(), c)], NO_G);
    run(w, 0.1); // 12 steps
    const snap = w.snapshot();
    expect(snap.components[c.id]).toBe(12);
    run(w, 0.1);
    w.drainComponentState();
    w.restore(snap);
    w.stepOnce();
    expect(w.drainComponentState().changed[c.id].values![0]).toBe(13); // continues counting from 12, not from 0
  });

  it('soft bodies are part of the engine snapshot: a jelly restores and replays identically', async () => {
    const jelly: SoftEntity = createSoft('jelly', { position: [0, 3, 0] });
    const w = await worldOf([jelly]);
    run(w, 0.5);
    const snap = w.snapshot();
    expect(snap.softs).toHaveLength(1);
    run(w, 1);
    const a = Array.from(w.readSoft().positions);
    w.restore(snap);
    run(w, 1);
    const b = Array.from(w.readSoft().positions);
    expect(b.length).toBe(a.length);
    expect(b).toEqual(a);
  });

  it('refuses a snapshot from a different format version without touching the world', async () => {
    const w = await worldOf([ball()]);
    run(w, 0.1);
    const snap = w.snapshot();
    const before = observe(w);
    expect(() => w.restore({ ...snap, version: 99 as unknown as 1 })).toThrow(/unsupported snapshot version/);
    expect(observe(w)).toEqual(before);
  });

  it('the snapshot ops work through the protocol (reply by id, restore as an op)', async () => {
    const w = await worldOf(scene());
    run(w, 0.5);
    w.applyOp({ op: 'snapshot', id: 3 });
    const [reply] = w.drainReplies().snapshots;
    expect(reply.id).toBe(3);
    const at = observe(w);
    run(w, 1);
    w.applyOp({ op: 'restore', snapshot: reply.snapshot });
    expect(observe(w)).toEqual(at);
    expect(vlen([0, 0, 0] as Vec3)).toBe(0);
    expect(vdist([0, 0, 0], [0, 0, 0])).toBe(0);
  });
});

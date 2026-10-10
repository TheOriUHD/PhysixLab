/**
 * Adversarial regression tests written by the independent verification pass over FB-6 / FB-7 / FB-8. Each one fails
 * on the code as it was before the pass:
 *
 *  - the component host under a long random sequence of live edits (add / remove / edit / rebuild / joints /
 *    snapshot / restore), checked against a model of what should exist after every operation;
 *  - published component state is withdrawn on the page when a restore removes the component;
 *  - component order is the order bodies joined the world, not the order components happened to be added;
 *  - the exit event of a body removed from a sensor survives a frame in which no fixed step ran;
 *  - contact events: identical streams for identical chunking, per-pair rate limit for every chunking, and
 *    step-synchronous component events that do not depend on chunking at all;
 *  - group transforms on random nested hierarchies against p ↦ new + R·(p − old), including velocities, world
 *    anchored joints, and a swinging pendulum that must move exactly like its rotated twin.
 */
import { describe, expect, it } from 'vitest';
import { qconj, qfromAxisAngle, qmul, qrot, vadd, vsub, type Quat, type Vec3 } from '../src/core/math';
import { makeComponent, registerComponent } from '../src/model/componentRegistry';
import { makePart } from '../src/model/compound';
import { createGroup, createJoint, createLight, createPath, defaultSettings } from '../src/model/factory';
import { SceneStore } from '../src/model/store';
import type { BodyEntity, ComponentSpec, JointEntity } from '../src/model/types';
import { BUILTIN_COMPONENTS } from '../src/model/components';
import { registerRuntime, runtimeOf } from '../src/physics/components';
import { hasIcon } from '../src/ui/icons';
import type { ContactEvent, SensorEvent, SimEvent } from '../src/physics/protocol';
import { PhysicsWorld } from '../src/physics/world';
import type { WorldState } from '../src/physics/world/state';
import { createBody, run, worldOf } from './helpers';

const NO_GROUND = { ground: { ...defaultSettings().ground, enabled: false } };
const NO_G = { gravity: [0, 0, 0] as Vec3, ...NO_GROUND };
/** The world's internal state, for leak checks. */
const stateOf = (w: PhysicsWorld): WorldState => (w as unknown as { s: WorldState }).s;
/** Small deterministic generator, so a failing sequence can be replayed. */
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

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

const probe = (type: string, appliesTo: 'body' | 'joint' | 'any' = 'any') =>
  registerComponent({ type, label: type, icon: 'component', category: 'Tests', blurb: '', appliesTo, fields: [] });

// ── events ────────────────────────────────────────────────────────────────────────────────────────

describe('sensor exit events', () => {
  it('the exit of a body removed while inside a sensor survives a frame in which no step ran', async () => {
    const zone = createBody({
      shape: { type: 'box', size: [2, 0.2, 2] },
      bodyType: 'static',
      position: [0, 2, 0],
      parts: [makePart({ id: 'trigger', shape: { type: 'box', size: [2, 2, 2] }, sensor: true })],
    });
    const b = ball({ position: [0, 2, 0] });
    const w = await worldOf([zone, b], NO_G);
    run(w, 0.1);
    w.drainEvents();
    w.removeEntities([b.id]);
    w.drainEvents(); // a tick that took no step: the world is paused, or the frame was shorter than a fixed step
    run(w, 0.05);
    const ev = w.drainEvents().filter((e): e is SensorEvent => e.kind === 'sensor');
    expect(ev.map((e) => `${e.phase}:${e.other}`)).toEqual([`exit:${b.id}`]);
  });
});

describe('contact events', () => {
  const scene = () =>
    Array.from({ length: 8 }, (_, i) =>
      ball({
        name: `b${i}`,
        position: [(i % 4) * 1.1 - 1.6, 1.5 + i * 0.4, Math.floor(i / 4) * 1.1],
        material: { preset: 'custom', density: 300, restitution: 0.6, friction: 0.4 },
      }),
    );
  const contactsOf = (events: SimEvent[]) => events.filter((e): e is ContactEvent => e.kind === 'contact');

  it('two worlds with the same frame chunking produce byte-identical event streams', async () => {
    const entities = scene();
    const streams: string[][] = [];
    for (let k = 0; k < 2; k++) {
      const w = await worldOf(entities);
      w.configureEvents({ contacts: true, pairInterval: 0.1, minImpulse: 0.01 });
      const out: string[] = [];
      for (let i = 0; i < 600; i++) {
        w.stepOnce();
        if ((i + 1) % 3 === 0) out.push(...w.drainEvents().map((e) => JSON.stringify(e)));
      }
      streams.push(out);
    }
    expect(streams[0].length).toBeGreaterThan(5);
    expect(streams[1]).toEqual(streams[0]);
  });

  it('no pair is reported twice within pairInterval, whatever the frame chunking', async () => {
    const entities = scene();
    for (const chunk of [1, 2, 5, 17]) {
      const w = await worldOf(entities);
      const interval = 0.3;
      w.configureEvents({ contacts: true, pairInterval: interval, minImpulse: 0 });
      const events: ContactEvent[] = [];
      for (let i = 0; i < 720; i++) {
        w.stepOnce();
        if ((i + 1) % chunk === 0) events.push(...contactsOf(w.drainEvents()));
      }
      const times = new Map<string, number[]>();
      for (const e of events) {
        const key = [e.a, e.b].sort().join('|');
        times.set(key, [...(times.get(key) ?? []), e.t]);
      }
      expect(events.length, `chunk ${chunk}`).toBeGreaterThan(3);
      // single-collider spheres: the body pair is the collider pair the limiter works on
      for (const [key, ts] of times)
        for (let i = 1; i < ts.length; i++)
          expect(ts[i] - ts[i - 1], `chunk ${chunk}, pair ${key}`).toBeGreaterThanOrEqual(interval - 1e-9);
    }
  });

  it('what watching components receive is step-synchronous: the same for any frame chunking', async () => {
    probe('hardenWatch', 'body');
    const seen: string[] = [];
    registerRuntime<null>({
      type: 'hardenWatch',
      create: (ctx) => {
        ctx.watchContacts();
        return null;
      },
      onEvent: (_s, ev, ctx) => {
        if (ev.kind === 'contact') seen.push(`${ctx.step}:${JSON.stringify(ev)}`);
      },
    });
    const entities = scene().map((b, i) => (i % 2 ? withComponents(b, makeComponent('hardenWatch')) : b));
    const runs: string[][] = [];
    for (const chunk of [1, 7, 60]) {
      seen.length = 0;
      const w = await worldOf(entities);
      for (let i = 0; i < 480; i++) {
        w.stepOnce();
        if ((i + 1) % chunk === 0) w.drainEvents();
      }
      runs.push([...seen]);
    }
    expect(runs[0].length).toBeGreaterThan(3);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});

// ── component runtime lifecycle ───────────────────────────────────────────────────────────────────

describe('component lifecycle', () => {
  const live = new Set<string>();
  let created = 0;
  let disposed = 0;
  registerComponent({
    type: 'hardenLife',
    label: 'Lifecycle probe',
    icon: 'component',
    category: 'Tests',
    blurb: '',
    appliesTo: 'any',
    fields: [{ kind: 'number', key: 'k', label: 'k', default: 1, min: 0, max: 10 }],
  });
  registerRuntime<{ n: number }>({
    type: 'hardenLife',
    create: (ctx) => {
      if (live.has(ctx.componentId)) throw new Error(`created twice: ${ctx.componentId}`);
      live.add(ctx.componentId);
      created++;
      ctx.watchContacts();
      return { n: 0 };
    },
    prestep: (s, _dt, ctx) => {
      s.n++;
      ctx.state.set([ctx.time, s.n]);
    },
    dispose: (_s, ctx) => {
      if (!live.delete(ctx.componentId)) throw new Error(`disposed without being created: ${ctx.componentId}`);
      disposed++;
    },
    saveState: (s) => ({ n: s.n }),
    loadState: (s, data) => {
      s.n = (data as { n: number }).n;
    },
  });

  it('a long random sequence of live edits keeps runtimes, watchers, published state and handles consistent', async () => {
    live.clear();
    created = disposed = 0;
    const rnd = lcg(12345);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const w = await worldOf([], NO_GROUND);
    const st = stateOf(w);
    const bodies = new Map<string, BodyEntity>();
    const joints = new Map<string, JointEntity>();
    const snaps: { snap: ReturnType<PhysicsWorld['snapshot']>; bodies: typeof bodies; joints: typeof joints }[] = [];
    const page = new Set<string>(); // what the page believes is published (removed first, then changed)
    const errors: SimEvent[] = [];
    const counts = new Map<number, number>();
    let named = 0;
    const comp = (type: string): ComponentSpec =>
      makeComponent(type, type === 'constantForce' ? { force: [1, 0, 0] } : {});
    const randomComponents = (): ComponentSpec[] =>
      Array.from({ length: Math.floor(rnd() * 3) }, () => ({
        ...comp(pick(['hardenLife', 'constantForce', 'hardenLife'])),
        enabled: rnd() > 0.2,
      }));

    const verify = (label: string) => {
      const running = new Set<string>();
      const enabled = new Set<string>();
      let total = 0;
      for (const owner of [...bodies.values(), ...joints.values()])
        for (const c of owner.components) {
          total++;
          if (c.enabled) enabled.add(c.id);
          if (c.enabled && c.type === 'hardenLife') running.add(c.id);
        }
      expect([...live].sort(), `${label}: running runtimes`).toEqual([...running].sort());
      expect(created - disposed, `${label}: created − disposed`).toBe(live.size);
      expect(st.contactWatchers, `${label}: contact watchers`).toBe(running.size);
      let hosted = 0;
      for (const id of [...bodies.keys(), ...joints.keys()]) hosted += w.componentsOf(id).length;
      expect(hosted, `${label}: components in the host`).toBe(total);
      expect(w.hostedComponents, `${label}: components held by the host`).toBe(total);
      const diagnostics = w.custom('diagnostics', null)[0].data as Record<string, number>;
      expect(diagnostics.hostedComponents, `${label}: diagnostics`).toBe(diagnostics.components);
      expect([...w.bodyIds].sort(), `${label}: bodies in the world`).toEqual([...bodies.keys()].sort());
      const drained = w.drainComponentState();
      for (const id of drained.removed) page.delete(id);
      for (const id of Object.keys(drained.changed)) page.add(id);
      for (const id of page) expect(enabled.has(id), `${label}: the page shows state of ${id}`).toBe(true);
      for (const id of st.componentState.keys()) expect(enabled.has(id), `${label}: world state of ${id}`).toBe(true);
      errors.push(...w.drainEvents().filter((e) => e.kind === 'component' && e.name === 'error'));
    };

    for (let step = 0; step < 400; step++) {
      const op = bodies.size === 0 ? 0 : Math.floor(rnd() * 11);
      counts.set(op, (counts.get(op) ?? 0) + 1);
      if (op <= 1) {
        const b = withComponents(
          ball({ position: [rnd() * 6 - 3, 1 + rnd() * 3, rnd() * 6 - 3], name: `b${named++}` }),
          ...randomComponents(),
        );
        bodies.set(b.id, b);
        w.addBody(b, false);
      } else if (op === 2) {
        const b = pick([...bodies.values()]);
        bodies.delete(b.id);
        for (const j of [...joints.values()]) if (j.bodyA === b.id || j.bodyB === b.id) joints.delete(j.id);
        w.removeEntities([b.id]);
      } else if (op === 3 || op === 4) {
        const b = pick([...bodies.values()]);
        let comps = b.components.map((c) => ({ ...c }));
        const r = rnd();
        if (r < 0.25 && comps.length) {
          const c = pick(comps);
          c.enabled = !c.enabled;
        } else if (r < 0.5 && comps.length) {
          const c = pick(comps);
          c.params = { ...c.params, k: Math.floor(rnd() * 10) };
        } else if (r < 0.7) comps = [...comps, comp(pick(['hardenLife', 'constantForce']))];
        else if (r < 0.85 && comps.length) comps.splice(Math.floor(rnd() * comps.length), 1);
        else comps = [...comps].reverse();
        const next = { ...b, components: comps };
        bodies.set(b.id, next);
        w.updateBody(next);
      } else if (op === 5) {
        // a structural edit: the body is rebuilt and its components re-attached
        const b = pick([...bodies.values()]);
        const next = { ...b, material: { ...b.material, density: 100 + Math.floor(rnd() * 900) } };
        bodies.set(b.id, next);
        w.updateBody(next);
      } else if (op === 6 && bodies.size >= 2) {
        const [a, b] = [pick([...bodies.values()]), pick([...bodies.values()])];
        if (a.id !== b.id) {
          const j: JointEntity = {
            ...createJoint({ type: 'ball', bodyA: a.id, bodyB: b.id, anchorA: [0, 0, 0] }),
            components: randomComponents(),
          };
          joints.set(j.id, j);
          w.addJoint(j);
        }
      } else if (op === 7 && joints.size) {
        const j = pick([...joints.values()]);
        const next = { ...j, components: randomComponents() };
        joints.set(j.id, next);
        w.updateJoint(next);
      } else if (op === 8) {
        snaps.push({ snap: w.snapshot(), bodies: new Map(bodies), joints: new Map(joints) });
        if (snaps.length > 4) snaps.shift();
      } else if (op === 9 && snaps.length) {
        const s = pick(snaps);
        w.restore(s.snap);
        bodies.clear();
        for (const [k, v] of s.bodies) bodies.set(k, v);
        joints.clear();
        for (const [k, v] of s.joints) joints.set(k, v);
      } else run(w, 0.05);
      verify(`op #${step} (${op})`);
    }
    expect(errors).toEqual([]);
    // the sequence really exercised everything it claims to
    for (const op of [0, 2, 3, 5, 6, 7, 8, 9, 10]) expect(counts.get(op) ?? 0, `op ${op} ran`).toBeGreaterThan(5);
    expect(created).toBeGreaterThan(40);

    // tear everything down: nothing may be left behind in the host or the world
    w.removeEntities([...joints.keys(), ...bodies.keys()]);
    bodies.clear();
    joints.clear();
    verify('after removing everything');
    run(w, 0.02);
    const host = st.host as unknown as {
      byOwner: Map<string, unknown>;
      bodyHandles: Map<string, unknown>;
      jointHandles: Map<string, unknown>;
      ordered: unknown[];
    };
    expect(host.byOwner.size).toBe(0);
    expect(host.bodyHandles.size).toBe(0);
    expect(host.jointHandles.size).toBe(0);
    expect(host.ordered.length).toBe(0);
    expect(st.componentState.size).toBe(0);
    expect(st.contactWatchers).toBe(0);
    expect(st.owners.size).toBe(0);
    expect(live.size).toBe(0);
  });

  it('a restore tells the page to forget the state of components that no longer exist', async () => {
    live.clear();
    const keep = withComponents(ball({ position: [0, 5, 0] }), makeComponent('hardenLife'));
    const w = await worldOf([keep], NO_G);
    run(w, 0.05);
    const first = w.drainComponentState();
    expect(Object.keys(first.changed)).toEqual([keep.components[0].id]);
    const snap = w.snapshot();
    const extra = makeComponent('hardenLife'); // added after the snapshot
    w.updateBody({ ...keep, components: [...keep.components, extra] });
    run(w, 0.05);
    const mid = w.drainComponentState();
    expect(Object.keys(mid.changed)).toContain(extra.id);
    w.restore(snap);
    run(w, 0.02);
    const after = w.drainComponentState();
    const page = new Set([...Object.keys(first.changed), ...Object.keys(mid.changed)]);
    for (const id of after.removed) page.delete(id);
    for (const id of Object.keys(after.changed)) page.add(id);
    expect([...page]).toEqual([keep.components[0].id]);
  });

  it('components run in the order their bodies joined the world, also when one was added later or after a restore', async () => {
    probe('hardenOrder');
    const trace: string[] = [];
    registerRuntime<null>({
      type: 'hardenOrder',
      create: () => null,
      prestep: (_s, _dt, ctx) => void trace.push(ctx.ownerId),
    });
    const a = createBody({ id: 'A', shape: { type: 'box', size: [1, 1, 1] } });
    const b = withComponents(
      createBody({ id: 'B', shape: { type: 'box', size: [1, 1, 1] }, position: [3, 0, 0] }),
      makeComponent('hardenOrder'),
    );
    const w = await worldOf([a, b], NO_G);
    w.updateBody(withComponents(a, makeComponent('hardenOrder'))); // A joined first but got its component last
    trace.length = 0;
    w.stepOnce();
    expect(trace).toEqual(['A', 'B']);
    w.restore(w.snapshot());
    trace.length = 0;
    w.stepOnce();
    expect(trace).toEqual(['A', 'B']);
  });
});

// ── group transforms ──────────────────────────────────────────────────────────────────────────────

describe('group transforms', () => {
  const randQuat = (r: () => number): Quat => qfromAxisAngle([r() - 0.5, r() - 0.5, r() - 0.5], r() * 6);
  const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 1e-9) => {
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
  };
  const sameRotation = (a: Quat, b: Quat, tol = 1e-9) =>
    expect(1 - Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])).toBeLessThan(tol);

  it('a random nested hierarchy follows p ↦ new + R·(p − old) and q ↦ R·q; outsiders stay; undo restores', () => {
    const r = lcg(99);
    const root = createGroup({ name: 'root', position: [1, 2, 3], rotation: randQuat(r) });
    const mid = createGroup({ name: 'mid', position: [4, 0, -2], rotation: randQuat(r), parent: root.id });
    const deep = createGroup({ name: 'deep', position: [-3, 1, 5], rotation: randQuat(r), parent: mid.id });
    const member = (parent: string | undefined, i: number): BodyEntity =>
      createBody({
        name: `m${i}`,
        position: [r() * 10 - 5, r() * 4, r() * 10 - 5],
        rotation: randQuat(r),
        ...(parent ? { parent } : {}),
      });
    const members = [member(root.id, 0), member(mid.id, 1), member(deep.id, 2), member(deep.id, 3)];
    const light = createLight('spot', { position: [2, 5, 1], rotation: randQuat(r), parent: mid.id });
    const path = createPath({ position: [0, 1, 0], rotation: randQuat(r), parent: deep.id });
    const outsider = member(undefined, 9);
    const pin = createJoint({ type: 'hinge', bodyA: null, bodyB: members[2].id, anchorA: [1, 2, 3], axis: [0, 1, 0] });
    const s = new SceneStore();
    s.add([root, mid, deep, ...members, light, path, outsider, pin]);
    const before = new Map(s.all().map((e) => [e.id, e]));

    const to = { position: [7, -1, 2] as Vec3, rotation: randQuat(r) };
    s.transformGroup(root.id, to);
    const R = qmul(to.rotation, qconj(root.rotation));
    const f = (p: Vec3): Vec3 => vadd(to.position, qrot(R, vsub(p, root.position)));
    for (const e of [mid, deep, ...members, light, path]) {
      const now = s.get(e.id) as BodyEntity;
      near(now.position, f(e.position));
      sameRotation(now.rotation, qmul(R, e.rotation));
    }
    expect((s.get(outsider.id) as BodyEntity).position).toEqual(outsider.position);
    const pinNow = s.joint(pin.id)!;
    near(pinNow.anchorA, f(pin.anchorA)); // the world anchor and its world-space axis follow the group
    near(pinNow.axis, qrot(R, pin.axis));

    s.undo();
    for (const [id, e] of before) expect(s.get(id)).toBe(e);
    // there and back again restores the originals numerically
    s.transformGroup(root.id, to);
    s.transformGroup(root.id, { position: root.position, rotation: root.rotation });
    for (const e of [mid, deep, ...members, light, path]) near((s.get(e.id) as BodyEntity).position, e.position, 1e-8);
  });

  it('initial velocities and constant kinematic velocities turn with the group (translation leaves them alone)', () => {
    const g = createGroup({ position: [0, 0, 0] });
    const shooter = createBody({ position: [1, 0, 0], velocity: [5, 0, 0], angularVelocity: [0, 2, 0], parent: g.id });
    const belt = createBody({ position: [0, 0, 1], bodyType: 'kinematic', velocity: [0, 0, 1], parent: g.id });
    const s = new SceneStore();
    s.add([g, shooter, belt]);
    s.transformGroup(g.id, { rotation: qfromAxisAngle([0, 1, 0], Math.PI / 2) });
    near(s.body(shooter.id)!.velocity, [0, 0, -5]);
    near(s.body(shooter.id)!.angularVelocity, [0, 2, 0]); // along the rotation axis: unchanged
    near(s.body(belt.id)!.velocity, [1, 0, 0]);
    s.transformGroup(g.id, { position: [3, 0, 0] });
    near(s.body(shooter.id)!.velocity, [0, 0, -5]);
    near(s.body(belt.id)!.velocity, [1, 0, 0]);
  });

  it('a pendulum pinned to the world swings exactly like its rotated twin after its group was rotated and moved', async () => {
    const make = () => {
      const g = createGroup({ position: [0, 5, 0] });
      const bob = createBody({
        name: 'bob',
        shape: { type: 'sphere', size: [0.4, 0.4, 0.4] },
        position: [2, 5, 0],
        velocity: [0, 0, 1],
        linearDamping: 0,
        angularDamping: 0,
        canSleep: false,
        parent: g.id,
      });
      // pinned at (0, 5, 0) with a world-space axis; swings in the XY plane (plus a little z drift from its velocity)
      const pin = createJoint({
        type: 'hinge',
        bodyA: null,
        bodyB: bob.id,
        anchorA: [0, 5, 0],
        anchorB: [-2, 0, 0],
        axis: [0, 0, 1],
      });
      // a second assembly: two bodies hinged together on a local axis, hanging from a world pin
      const arm = createBody({
        name: 'arm',
        shape: { type: 'box', size: [1.5, 0.2, 0.2] },
        position: [0, 8, 0],
        canSleep: false,
        parent: g.id,
      });
      const tip = createBody({
        name: 'tip',
        shape: { type: 'box', size: [1, 0.2, 0.2] },
        position: [1.25, 8, 0],
        canSleep: false,
        parent: g.id,
      });
      const armPin = createJoint({
        type: 'hinge',
        bodyA: null,
        bodyB: arm.id,
        anchorA: [-0.75, 8, 0],
        anchorB: [-0.75, 0, 0],
        axis: [0, 0, 1],
      });
      const elbow = createJoint({
        type: 'hinge',
        bodyA: arm.id,
        bodyB: tip.id,
        anchorA: [0.75, 0, 0],
        anchorB: [-0.5, 0, 0],
        axis: [0, 0, 1],
      });
      // and a projectile: its initial velocity belongs to the assembly and must turn with it
      const shot = createBody({
        name: 'shot',
        shape: { type: 'sphere', size: [0.3, 0.3, 0.3] },
        position: [-1, 6, 2],
        velocity: [3, 4, 0],
        linearDamping: 0,
        angularDamping: 0,
        canSleep: false,
        parent: g.id,
      });
      const s = new SceneStore();
      s.add([g, bob, pin, arm, tip, armPin, elbow, shot]);
      return { s, g, bob, arm, tip, shot };
    };
    const base = make();
    // rotating about the vertical keeps gravity along the pendulum's plane, so the twin must move identically
    const q = qfromAxisAngle([0, 1, 0], 1.1);
    const move = make();
    const offset: Vec3 = [3, 0, -2];
    move.s.transformGroup(move.g.id, { position: vadd(move.g.position, offset), rotation: q });
    const worlds = await Promise.all([base.s, move.s].map((s) => PhysicsWorld.create(s.toDocument())));
    for (const w of worlds) run(w, 2);
    for (const part of ['bob', 'arm', 'tip', 'shot'] as const) {
      const a = worlds[0].getPose(base[part].id)!;
      const b = worlds[1].getPose(move[part].id)!;
      // the moved world's pose is the base world's, turned about the pivot (0, 5, 0) and shifted by the offset
      const pivot: Vec3 = [0, 5, 0];
      near(b.position, vadd(vadd(pivot, offset), qrot(q, vsub(a.position, pivot))), 2e-3);
      near(b.linvel, qrot(q, a.linvel), 2e-3);
      sameRotation(b.rotation, qmul(q, a.rotation), 1e-6); // single-precision engine
    }
    // sanity: it really swung (an unpinned or mis-anchored joint would leave the bob falling or frozen)
    const swung = worlds[0].getPose(base.bob.id)!;
    expect(Math.abs(swung.position[0])).toBeLessThan(2);
    expect(swung.position[1]).toBeGreaterThan(2);
    expect(Math.hypot(swung.position[0] - 2, swung.position[1] - 5)).toBeGreaterThan(0.5);
  });
});

// ── snapshots with a kinematic mover ──────────────────────────────────────────────────────────────

describe('snapshot / restore with a sine mover', () => {
  it('a platform carrying a box replays bit-identically after a restore (the mover resumes on its curve)', async () => {
    const platform = withComponents(
      createBody({
        shape: { type: 'box', size: [4, 0.4, 4] },
        bodyType: 'kinematic',
        position: [0, 1, 0],
        material: { preset: 'rubber' },
      }),
      makeComponent('sineMover', { amplitude: 1.5, frequency: 0.4, phase: 30 }),
    );
    const rider = createBody({
      shape: { type: 'box', size: [0.8, 0.8, 0.8] },
      position: [0, 1.7, 0],
      material: { preset: 'rubber' },
    });
    const w = await worldOf([platform, rider]);
    run(w, 1.3);
    const snap = w.snapshot();
    const poseOf = () => [platform.id, rider.id].map((id) => w.getPose(id));
    run(w, 1);
    const first = poseOf();
    w.restore(snap);
    run(w, 1);
    expect(poseOf()).toEqual(first);
  });
});

// ── registries are wired end to end ───────────────────────────────────────────────────────────────

describe('built-in components are wired through every registry', () => {
  it('each definition has an icon, a runtime in the worker, and gauges that match what the runtime publishes', async () => {
    expect(BUILTIN_COMPONENTS.length).toBeGreaterThanOrEqual(2);
    for (const def of BUILTIN_COMPONENTS) {
      expect(hasIcon(def.icon), `${def.type}: icon "${def.icon}" exists in the icon set`).toBe(true);
      expect(runtimeOf(def.type), `${def.type}: a runtime is registered`).toBeDefined();
      for (const f of def.fields) expect(f.label, `${def.type}.${f.key} has a label`).toBeTruthy();
      // run it for real and count the numbers it publishes
      const kinematic = def.type === 'sineMover';
      const b = withComponents(
        createBody({
          shape: { type: 'box', size: [1, 1, 1] },
          position: [0, 5, 0],
          ...(kinematic ? { bodyType: 'kinematic' as const } : {}),
        }),
        makeComponent(def.type),
      );
      const w = await worldOf([b], NO_G);
      run(w, 0.05);
      expect(w.missingRuntimes()).toEqual([]);
      const published = w.drainComponentState().changed[b.components[0].id];
      expect(published?.values?.length, `${def.type}: published values`).toBe(def.state?.length ?? 0);
    }
  });
});

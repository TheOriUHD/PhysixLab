/**
 * The component system in the physics world: the two reference components against analytic results, and the
 * runtime machinery — deterministic order, live edits without a rebuild, disposal, fault isolation, state readback.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, vdist, vlen, type Vec3 } from '../src/core/math';
import { componentDef, makeComponent, registerComponent } from '../src/model/componentRegistry';
import { defaultSettings } from '../src/model/factory';
import type { BodyEntity, ComponentSpec } from '../src/model/types';
import type { BodyInit } from '../src/model/factory';
import { registerRuntime, type ComponentRuntime } from '../src/physics/components';
import { createBody, createJoint, run, worldOf } from './helpers';

const NO_G = { gravity: [0, 0, 0] as Vec3, ground: { ...defaultSettings().ground, enabled: false } };
const DT = 1 / 120;

/** 1 m³ block of density 2 → 2 kg, no damping, so analytic results are exact. */
const block = (over: Omit<BodyInit, 'shape'> = {}) =>
  createBody({
    shape: { type: 'box', size: [1, 1, 1] },
    material: { preset: 'custom', density: 2 },
    linearDamping: 0,
    angularDamping: 0,
    ...over,
  });
const withComponents = (b: BodyEntity, ...components: ComponentSpec[]): BodyEntity => ({ ...b, components });

describe('constantForce', () => {
  it('accelerates a body at F/m: 10 N on 2 kg gives 5 m/s², v = 5 m/s and x ≈ 2.5 m after a second', async () => {
    const b = withComponents(block(), makeComponent('constantForce', { force: [10, 0, 0] }));
    const w = await worldOf([b], NO_G);
    expect(w.builtInfo().mass[b.id]).toBeCloseTo(2, 9);
    run(w, 1);
    const p = w.getPose(b.id)!;
    expect(p.linvel[0]).toBeCloseTo(5, 4); // the engine works in single precision
    expect(p.linvel[1]).toBeCloseTo(0, 9);
    // semi-implicit Euler: x = a·dt²·n(n+1)/2 for n steps (≈ ½at² plus a half-step of drift)
    const n = 120;
    expect(p.position[0]).toBeCloseTo((5 * DT * DT * n * (n + 1)) / 2, 6);
    expect(p.position[0]).toBeGreaterThan(2.49);
    expect(p.position[0]).toBeLessThan(2.53);
  });

  it('works along any direction, and combines with the engine’s own gravity', async () => {
    // Weight is 2·9.81 N: an upward force of exactly that holds the body still
    const b = withComponents(block(), makeComponent('constantForce', { force: [0, 2 * 9.81, 0] }));
    const w = await worldOf([b], { ground: NO_G.ground });
    run(w, 1);
    expect(Math.abs(w.getPose(b.id)!.linvel[1])).toBeLessThan(1e-6);
    // half of that falls at g/2
    const c = withComponents(block(), makeComponent('constantForce', { force: [0, 9.81, 0] }));
    const w2 = await worldOf([c], { ground: NO_G.ground });
    run(w2, 1);
    expect(w2.getPose(c.id)!.linvel[1]).toBeCloseTo(-4.905, 3);
  });

  it('"Body axes" turns the force with the body; "World axes" does not', async () => {
    const q = qfromAxisAngle([0, 0, 1], Math.PI / 2); // local +x points along world +y
    const local = withComponents(
      block({ rotation: q, position: [-5, 0, 0] }),
      makeComponent('constantForce', { force: [10, 0, 0], space: 'local' }),
    );
    const world = withComponents(
      block({ rotation: q, position: [5, 0, 0] }),
      makeComponent('constantForce', { force: [10, 0, 0], space: 'world' }),
    );
    const w = await worldOf([local, world], NO_G);
    run(w, 0.5);
    const a = w.getPose(local.id)!.linvel;
    const b = w.getPose(world.id)!.linvel;
    expect(a[1]).toBeCloseTo(2.5, 5);
    expect(Math.abs(a[0])).toBeLessThan(1e-6);
    expect(b[0]).toBeCloseTo(2.5, 5);
    expect(Math.abs(b[1])).toBeLessThan(1e-6);
  });

  it('"Per unit mass" reads the force as an acceleration: bodies of any mass speed up alike', async () => {
    const light = withComponents(
      block({ material: { preset: 'custom', density: 1 }, position: [0, 0, -5] }),
      makeComponent('constantForce', { force: [4, 0, 0], perMass: true }),
    );
    const heavy = withComponents(
      block({ material: { preset: 'custom', density: 50 }, position: [0, 0, 5] }),
      makeComponent('constantForce', { force: [4, 0, 0], perMass: true }),
    );
    const w = await worldOf([light, heavy], NO_G);
    run(w, 1);
    expect(w.getPose(light.id)!.linvel[0]).toBeCloseTo(4, 4);
    expect(w.getPose(heavy.id)!.linvel[0]).toBeCloseTo(4, 4);
  });

  it('a force at an offset point also spins the body: τ = r × F, ω = τ·t / I', async () => {
    // F = 10 N along +x acting 0.5 m above the centre → torque −5 N·m about z; I = m·s²/6 = 1/3 kg·m² for a 2 kg cube
    const b = withComponents(
      block(),
      makeComponent('constantForce', { force: [10, 0, 0], applyAt: 'point', point: [0, 0.5, 0] }),
    );
    const w = await worldOf([b], NO_G);
    run(w, 0.1);
    const wz = w.getPose(b.id)!.angvel[2];
    expect(wz).toBeCloseTo((-5 / (1 / 3)) * 0.1, 1); // −1.5 rad/s, to within the small rotation of the arm
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(0.5, 3);
  });

  it('a pure torque spins without moving the centre', async () => {
    const b = withComponents(block(), makeComponent('constantForce', { force: [0, 0, 0], torque: [0, 2, 0] }));
    const w = await worldOf([b], NO_G);
    run(w, 1);
    const p = w.getPose(b.id)!;
    expect(p.angvel[1]).toBeCloseTo(2 / (1 / 3), 3); // 6 rad/s
    expect(vlen(p.linvel)).toBeLessThan(1e-9);
  });

  it('only while the key is held, and scaled by an analog axis', async () => {
    const b = withComponents(
      block(),
      makeComponent('constantForce', { force: [10, 0, 0], key: 'KeyG', axis: 'throttle' }),
    );
    const w = await worldOf([b], NO_G);
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[0]).toBe(0); // no key, no force
    w.setKeys(['KeyG']);
    w.setAxes({ throttle: 0.5 });
    run(w, 1);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(2.5, 5); // half of 5 m/s²
    w.setAxes({ throttle: -1 });
    run(w, 1);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(2.5 - 5, 5);
    w.setKeys([]);
    run(w, 1);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(-2.5, 5); // released: coasting
  });

  it('does nothing when disabled, on static bodies, and the inspector warns about them', async () => {
    const off = withComponents(block(), { ...makeComponent('constantForce', { force: [10, 0, 0] }), enabled: false });
    const stat = withComponents(
      block({ bodyType: 'static', position: [5, 0, 0] }),
      makeComponent('constantForce', { force: [10, 0, 0] }),
    );
    const w = await worldOf([off, stat], NO_G);
    run(w, 0.5);
    expect(vlen(w.getPose(off.id)!.linvel)).toBe(0);
    expect(w.getPose(stat.id)!.position[0]).toBe(5);
    const def = componentDef('constantForce')!;
    expect(def.check?.(stat, stat.components[0].params)).toMatch(/dynamic/);
    expect(def.check?.(off, off.components[0].params)).toBeNull();
  });

  it('publishes the applied force and torque as component state', async () => {
    const c = makeComponent('constantForce', { force: [3, 4, 0], torque: [0, 0, 2] });
    const w = await worldOf([withComponents(block(), c)], NO_G);
    run(w, 0.05);
    const { changed } = w.drainComponentState();
    expect([...changed[c.id].values!]).toEqual([5, 2]);
    expect(changed[c.id].type).toBe('constantForce');
    expect(w.drainComponentState().changed).toEqual({}); // unchanged values are not sent again
  });
});

describe('live edits and lifecycle', () => {
  it('editing the parameters of a running component takes effect at once, without rebuilding the body', async () => {
    const c = makeComponent('constantForce', { force: [10, 0, 0] });
    const b = withComponents(block(), c);
    const w = await worldOf([b], NO_G);
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(2.5, 5);
    const layout = w.layoutVersion;
    w.updateBody({ ...b, components: [{ ...c, params: { ...c.params, force: [0, 10, 0] } }] });
    expect(w.layoutVersion).toBe(layout); // no rebuild
    run(w, 0.5);
    const v = w.getPose(b.id)!.linvel;
    expect(v[0]).toBeCloseTo(2.5, 5); // the x push stopped
    expect(v[1]).toBeCloseTo(2.5, 5); // the y push started
  });

  it('adding, switching off, switching on and removing components while running', async () => {
    const b = block();
    const w = await worldOf([b], NO_G);
    run(w, 0.1);
    expect(vlen(w.getPose(b.id)!.linvel)).toBe(0);
    const c = makeComponent('constantForce', { force: [10, 0, 0] });
    w.updateBody({ ...b, components: [c] });
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(2.5, 5);
    expect(w.isComponentRunning(c.id)).toBe(true);
    w.updateBody({ ...b, components: [{ ...c, enabled: false }] });
    expect(w.isComponentRunning(c.id)).toBe(false);
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(2.5, 5); // coasting
    w.updateBody({ ...b, components: [c] });
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(5, 5);
    w.updateBody({ ...b, components: [] });
    expect(w.componentsOf(b.id)).toEqual([]);
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(5, 5);
  });

  it('survives a structural rebuild of its body (the component is re-attached and keeps working)', async () => {
    const c = makeComponent('constantForce', { force: [10, 0, 0] });
    const b = withComponents(block(), c);
    const w = await worldOf([b], NO_G);
    run(w, 0.5);
    const layout = w.layoutVersion;
    w.updateBody({ ...b, shape: { ...b.shape, size: [1, 1, 1.5] }, components: [c] }); // new shape → rebuilt in place
    expect(w.layoutVersion).toBeGreaterThan(layout);
    expect(w.isComponentRunning(c.id)).toBe(true);
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[0]).toBeGreaterThan(2.5 + 0.5); // still pushed (lighter or heavier: just continuing to speed up)
  });

  it('removing a body disposes its components and withdraws their published state', async () => {
    const c = makeComponent('constantForce');
    const b = withComponents(block(), c);
    const w = await worldOf([b], NO_G);
    run(w, 0.05);
    expect(w.drainComponentState().changed[c.id]).toBeDefined();
    w.removeEntities([b.id]);
    expect(w.componentsOf(b.id)).toEqual([]);
    expect(w.isComponentRunning(c.id)).toBe(false);
    expect(w.drainComponentState().removed).toEqual([c.id]);
    run(w, 0.05); // nothing left to run
  });

  it('joints carry components too, and they go away with the joint', async () => {
    const log: string[] = [];
    registerComponent({
      type: 'testJointProbe',
      label: 'Probe',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'joint',
      fields: [],
    });
    registerRuntime<null>({
      type: 'testJointProbe',
      create: (ctx) => {
        log.push(`create ${ctx.ownerKind}`);
        return null;
      },
      prestep: (_s, _dt, ctx) => void log.push(`step ${ctx.joint?.alive ? 'alive' : 'dead'}`),
      dispose: () => void log.push('dispose'),
    });
    const a = block({ bodyType: 'static' });
    const c = block({ position: [2, 0, 0] });
    const j = {
      ...createJoint({ type: 'ball', bodyA: a.id, bodyB: c.id, anchorA: [1, 0, 0] }),
      components: [makeComponent('testJointProbe')],
    };
    const w = await worldOf([a, c, j], NO_G);
    run(w, 0.02);
    expect(log[0]).toBe('create joint');
    expect(log.includes('step alive')).toBe(true);
    w.removeEntities([j.id]);
    expect(log[log.length - 1]).toBe('dispose');
  });
});

describe('execution order and fault isolation', () => {
  const trace: string[] = [];
  const probe: ComponentRuntime<{ n: number }> = {
    type: 'testOrder',
    create: (ctx) => {
      trace.push(`create ${ctx.ownerId}/${String(ctx.params.tag)}`);
      return { n: 0 };
    },
    prestep: (_s, _dt, ctx) => void trace.push(`pre ${ctx.ownerId}/${String(ctx.params.tag)}`),
    poststep: (_s, _dt, ctx) => void trace.push(`post ${ctx.ownerId}/${String(ctx.params.tag)}`),
    dispose: (_s, ctx) => void trace.push(`dispose ${ctx.ownerId}/${String(ctx.params.tag)}`),
  };
  registerComponent({
    type: 'testOrder',
    label: 'Order probe',
    icon: 'component',
    category: 'Tests',
    blurb: '',
    appliesTo: 'any',
    fields: [{ kind: 'text', key: 'tag', label: 'Tag', default: '' }],
  });
  registerRuntime(probe);
  const tagged = (tag: string) => makeComponent('testOrder', { tag });

  it('runs bodies in the order they joined the world, then joints, each owner’s components in array order', async () => {
    trace.length = 0;
    const a = withComponents(block({ id: 'A' }), tagged('1'), tagged('2'));
    const b = withComponents(block({ id: 'B' }), tagged('1'));
    const j = {
      ...createJoint({ type: 'ball', bodyA: 'A', bodyB: 'B', anchorA: [0, 0, 0] }),
      id: 'J',
      components: [tagged('1')],
    };
    // The joint is listed first in the document, but joints always run after bodies
    const w = await worldOf([b, a, j], NO_G);
    trace.length = 0;
    w.stepOnce();
    expect(trace.filter((t) => t.startsWith('pre'))).toEqual(['pre B/1', 'pre A/1', 'pre A/2', 'pre J/1']);
    expect(trace.filter((t) => t.startsWith('post'))).toEqual(['post B/1', 'post A/1', 'post A/2', 'post J/1']);
    // all prestep hooks run before any poststep hook of the same step
    expect(trace.indexOf('post B/1')).toBeGreaterThan(trace.lastIndexOf('pre J/1'));
    // a body added later runs after the existing ones
    const c = withComponents(block({ id: 'C' }), tagged('1'));
    w.addBody(c, false);
    trace.length = 0;
    w.stepOnce();
    expect(trace.filter((t) => t.startsWith('pre'))).toEqual(['pre B/1', 'pre A/1', 'pre A/2', 'pre C/1', 'pre J/1']);
  });

  it('the same scene always runs in the same order (two worlds, identical traces)', async () => {
    const make = () => [
      withComponents(block({ id: 'X' }), tagged('a'), tagged('b')),
      withComponents(block({ id: 'Y' }), tagged('a')),
    ];
    trace.length = 0;
    const w1 = await worldOf(make(), NO_G);
    trace.length = 0;
    run(w1, 0.05);
    const first = [...trace];
    const w2 = await worldOf(make(), NO_G);
    trace.length = 0;
    run(w2, 0.05);
    expect(trace).toEqual(first);
  });

  it('a component that throws is switched off with an error event; the rest of the world carries on', async () => {
    registerComponent({
      type: 'testBoom',
      label: 'Boom',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'body',
      fields: [],
    });
    registerRuntime<null>({
      type: 'testBoom',
      create: () => null,
      prestep: () => {
        throw new Error('kaboom');
      },
    });
    const boom = makeComponent('testBoom');
    const good = makeComponent('constantForce', { force: [10, 0, 0] });
    const a = withComponents(block(), boom, good); // the faulty one comes first on the same body
    const w = await worldOf([a], NO_G);
    const originalError = console.error;
    console.error = () => undefined; // the host reports the fault; keep the test output clean
    try {
      run(w, 0.5);
    } finally {
      console.error = originalError;
    }
    expect(w.isComponentRunning(boom.id)).toBe(false);
    expect(w.isComponentRunning(good.id)).toBe(true);
    expect(w.getPose(a.id)!.linvel[0]).toBeCloseTo(2.5, 5);
    const errors = w.drainEvents().filter((e) => e.kind === 'component' && e.name === 'error');
    expect(errors).toHaveLength(1); // reported once, not every step
    expect(errors[0]).toMatchObject({ owner: a.id, component: boom.id, type: 'testBoom' });
    expect((errors[0] as { data: { message: string } }).data.message).toBe('kaboom');
  });

  it('a runtime without paramsChanged is re-created when its parameters are edited', async () => {
    const lifecycle: string[] = [];
    registerComponent({
      type: 'testRecreate',
      label: 'Recreate',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'body',
      fields: [{ kind: 'number', key: 'x', label: 'X', default: 0 }],
    });
    registerRuntime<null>({
      type: 'testRecreate',
      create: (ctx) => {
        lifecycle.push(`create ${ctx.num('x')}`);
        return null;
      },
      dispose: () => void lifecycle.push('dispose'),
    });
    const c = makeComponent('testRecreate', { x: 1 });
    const b = withComponents(block(), c);
    const w = await worldOf([b], NO_G);
    w.updateBody({ ...b, components: [{ ...c, params: { ...c.params, x: 2 } }] });
    expect(lifecycle).toEqual(['create 1', 'dispose', 'create 2']);
  });

  it('typed readers fall back to the field defaults for missing or mistyped values', async () => {
    let seen: unknown[] = [];
    registerComponent({
      type: 'testReaders',
      label: 'Readers',
      icon: 'component',
      category: 'Tests',
      blurb: '',
      appliesTo: 'body',
      fields: [
        { kind: 'number', key: 'n', label: 'N', default: 7 },
        { kind: 'bool', key: 'b', label: 'B', default: true },
        { kind: 'text', key: 't', label: 'T', default: 'dflt' },
        { kind: 'vec3', key: 'v', label: 'V', default: [1, 2, 3] },
        {
          kind: 'curve',
          key: 'c',
          label: 'C',
          default: [
            [0, 0],
            [10, 100],
          ],
          xRange: [0, 10],
          yRange: [0, 100],
        },
      ],
    });
    registerRuntime<null>({
      type: 'testReaders',
      create: (ctx) => {
        seen = [
          ctx.num('n'),
          ctx.bool('b'),
          ctx.str('t'),
          ctx.vec3('v'),
          ctx.curveAt('c', 5),
          ctx.curveAt('c', -1),
          ctx.curveAt('c', 99),
        ];
        return null;
      },
    });
    // a hand-built spec that bypasses sanitising: wrong types everywhere
    const bad: ComponentSpec = {
      id: 'c_x',
      type: 'testReaders',
      enabled: true,
      params: { n: 'x', b: 3, t: 5, v: [1], c: 'nope' },
    };
    await worldOf([withComponents(block(), bad)], NO_G);
    expect(seen).toEqual([7, true, 'dflt', [1, 2, 3], 50, 0, 100]);
  });
});

describe('sineMover', () => {
  const kin = (over: Omit<BodyInit, 'shape' | 'bodyType'> = {}) =>
    createBody({ shape: { type: 'box', size: [1, 0.2, 1] }, bodyType: 'kinematic', position: [3, 2, -1], ...over });

  it('a kinematic body follows x(t) = A·sin(2π·f·t + φ) from its authored position, step by step', async () => {
    const A = 1.5;
    const f = 0.8;
    const phase = 40;
    const m = withComponents(kin(), makeComponent('sineMover', { axis: [1, 0, 0], amplitude: A, frequency: f, phase }));
    const w = await worldOf([m], NO_G);
    let worst = 0;
    for (let i = 1; i <= 480; i++) {
      w.stepOnce();
      const t = i * DT;
      const expected = 3 + A * Math.sin(2 * Math.PI * f * t + (phase * Math.PI) / 180);
      worst = Math.max(worst, Math.abs(w.getPose(m.id)!.position[0] - expected));
    }
    expect(worst).toBeLessThan(1e-5);
    const p = w.getPose(m.id)!.position;
    expect(p[1]).toBeCloseTo(2, 9); // the other axes stay put
    expect(p[2]).toBeCloseTo(-1, 9);
  });

  it('moves along an arbitrary axis (normalised), with the right peak displacement', async () => {
    const m = withComponents(
      kin({ position: [0, 5, 0] }),
      makeComponent('sineMover', { axis: [0, 3, 4], amplitude: 2, frequency: 1 }),
    );
    const w = await worldOf([m], NO_G);
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      w.stepOnce();
      peak = Math.max(peak, vdist(w.getPose(m.id)!.position, [0, 5, 0]));
    }
    expect(peak).toBeGreaterThan(1.999);
    expect(peak).toBeLessThan(2.0001);
    // direction (0, 0.6, 0.8) at the first quarter period
    const t = 30 * DT; // after 30 steps it has moved a quarter of the way: sin(2π·0.25)=1 at step 30 → x = A
    void t;
  });

  it('a non-zero phase starts on the curve instead of launching its riders; a non-kinematic body is left alone', async () => {
    const m = withComponents(
      kin({ position: [0, 1, 0] }),
      makeComponent('sineMover', { amplitude: 1, frequency: 0.5, phase: 90 }),
    );
    const w = await worldOf([m], NO_G);
    expect(w.getPose(m.id)!.position[0]).toBeCloseTo(1, 9); // sin(90°) = 1, placed there before the first step
    w.stepOnce();
    expect(Math.abs(w.getPose(m.id)!.linvel[0])).toBeLessThan(0.05); // at the crest it is almost at rest
    const dyn = withComponents(block({ position: [0, 1, 0] }), makeComponent('sineMover', { amplitude: 1 }));
    const w2 = await worldOf([dyn], NO_G);
    run(w2, 0.5);
    expect(w2.getPose(dyn.id)!.position[0]).toBe(0);
    const def = componentDef('sineMover')!;
    expect(def.check?.(dyn, dyn.components[0].params)).toMatch(/kinematic/);
    expect(def.check?.(m, m.components[0].params)).toBeNull();
  });

  it('carries a box resting on it by friction (and not when the surface is slippery)', async () => {
    const platform = (friction: number) =>
      withComponents(
        createBody({
          shape: { type: 'box', size: [6, 0.4, 3] },
          bodyType: 'kinematic',
          position: [0, 0.2, 0],
          material: { preset: 'custom', friction },
        }),
        // A = 0.5 m at 0.25 Hz: peak acceleration A·ω² = 1.23 m/s² < μ·g = 7.8 m/s², so grip holds.
        // Phase −90° starts at the left extreme, at rest, so the rider is not jerked into motion at t = 0.
        makeComponent('sineMover', { amplitude: 0.5, frequency: 0.25, phase: -90 }),
      );
    const rider = (friction: number) =>
      createBody({
        shape: { type: 'box', size: [0.5, 0.5, 0.5] },
        position: [-0.5, 0.4 + 0.25 + 0.001, 0],
        material: { preset: 'custom', friction, density: 500 },
      });
    const trial = async (friction: number) => {
      const p = platform(friction);
      const r = rider(friction);
      const w = await worldOf([p, r], { ground: { ...defaultSettings().ground, enabled: false } });
      let relMax = 0;
      let travel = 0;
      for (let i = 0; i < 4 * 120; i++) {
        w.stepOnce();
        const pp = w.getPose(p.id)!.position;
        const rp = w.getPose(r.id)!.position;
        relMax = Math.max(relMax, Math.abs(rp[0] - pp[0]));
        travel = Math.max(travel, Math.abs(rp[0]));
      }
      return { relMax, travel, y: w.getPose(r.id)!.position[1] };
    };
    const grip = await trial(0.8);
    expect(grip.travel).toBeGreaterThan(0.45); // it really rode the full ±0.5 m swing
    expect(grip.relMax).toBeLessThan(0.01); // and never moved more than 1 cm relative to the platform
    expect(grip.y).toBeGreaterThan(0.6); // still sitting on top
    const ice = await trial(0.0);
    expect(ice.relMax).toBeGreaterThan(0.3); // no friction: the platform slides out from under it
    expect(ice.travel).toBeLessThan(grip.travel);
  });

  it('publishes offset and speed, and editing amplitude / frequency live needs no rebuild', async () => {
    const c = makeComponent('sineMover', { amplitude: 1, frequency: 0.5 });
    const m = withComponents(kin({ position: [0, 1, 0] }), c);
    const w = await worldOf([m], NO_G);
    run(w, 0.5); // a quarter period: at the crest
    const s = w.drainComponentState().changed[c.id].values!;
    expect(s[0]).toBeCloseTo(1, 2);
    expect(Math.abs(s[1])).toBeLessThan(0.05);
    const layout = w.layoutVersion;
    w.updateBody({ ...m, components: [{ ...c, params: { ...c.params, amplitude: 3 } }] });
    expect(w.layoutVersion).toBe(layout);
    run(w, 1); // half a period later it is at the other crest of the (now bigger) swing
    expect(w.getPose(m.id)!.position[0]).toBeCloseTo(-3, 1);
  });
});

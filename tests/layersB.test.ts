/**
 * JT-B: collision layers with a scene matrix and trigger layers (JT-30), one-way platforms through the contact hook
 * (JT-31), wind-relative drag and the √(2mg/ρCdA) terminal speed (JT-32), a pendulum with a moved centre of mass
 * (JT-33) and waking sleeping bodies (JT-34).
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { effectiveMask, layersCollide, layersField, setLayerPair, defaultLayers } from '../src/model/collisionLayers';
import { quadraticDragCoefficient, terminalSpeed } from '../src/model/drag';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import type { BodyEntity } from '../src/model/types';
import { createBody, createJoint, docOf, run, worldOf } from './helpers';

const free = { linearDamping: 0, angularDamping: 0, canSleep: false };
const G = 9.81;
const noGround = { ground: { enabled: false, friction: 0.5, restitution: 0, halfSize: 50, color: '#000' } };
const ball = (over: Partial<BodyEntity> & Record<string, unknown> = {}) =>
  createBody({
    shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
    position: [0, 5, 0],
    material: { preset: 'custom', density: 1000 },
    ...free,
    ...over,
  });
const slab = (over: Partial<BodyEntity> & Record<string, unknown> = {}) =>
  createBody({ shape: { type: 'box', size: [6, 0.4, 6] }, position: [0, 2, 0], bodyType: 'static', ...over });

describe('collision layers (JT-30)', () => {
  it('the matrix decides which layers collide, and can be edited on a live world', async () => {
    const plat = slab({ collision: { group: 2, mask: 0xffff } });
    const b = ball({ position: [0, 4, 0], collision: { group: 1, mask: 0xffff } });
    const off = setLayerPair(defaultLayers(), 1, 2, false);
    const w = await worldOf([plat, b], { layers: off });
    run(w, 3);
    expect(w.getPose(b.id)!.position[1]).toBeLessThan(0.6); // passed through the slab, resting on the ground
    const on = await worldOf([plat, b], { layers: defaultLayers() });
    run(on, 3);
    expect(on.getPose(b.id)!.position[1]).toBeGreaterThan(2.3); // rests on the slab
    // live: switch the pair off while the ball rests
    on.applySettings({ ...on.settings, layers: off });
    run(on, 3);
    expect(on.getPose(b.id)!.position[1]).toBeLessThan(0.6);
    // and back on: a ball dropped again now stays on the slab
    on.applySettings({ ...on.settings, layers: defaultLayers() });
    on.teleport(b.id, [0, 5, 0], [0, 0, 0, 1]);
    run(on, 3);
    expect(on.getPose(b.id)!.position[1]).toBeGreaterThan(2.3);
  });

  it('the matrix limits the ground as well (layer 0)', async () => {
    const b = ball({ position: [0, 2, 0], collision: { group: 3, mask: 0xffff } });
    const w = await worldOf([b], { layers: setLayerPair(defaultLayers(), 0, 3, false) });
    run(w, 2);
    expect(w.getPose(b.id)!.position[1]).toBeLessThan(-5);
  });

  it('a trigger layer is pass-through but reports overlaps as sensor events', async () => {
    const zone = slab({ collision: { group: 4, mask: 0xffff } });
    const b = ball({ position: [0, 4, 0] });
    const layers = { ...defaultLayers(), trigger: 1 << 4 };
    const w = await worldOf([zone, b], { layers, ...noGround });
    run(w, 1.5);
    expect(w.getPose(b.id)!.position[1]).toBeLessThan(-3); // fell straight through
    const ev = w.drainEvents().filter((e) => e.kind === 'sensor');
    const kinds = ev.map((e) => (e as { type?: string; phase?: string }).type ?? (e as { phase?: string }).phase);
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(kinds.join()).toMatch(/enter/);
    expect(kinds.join()).toMatch(/exit/);
    // without the trigger flag the same layer is a solid
    const solid = await worldOf([zone, b], { layers: defaultLayers(), ...noGround });
    run(solid, 1.5);
    expect(solid.getPose(b.id)!.position[1]).toBeGreaterThan(2.3);
  });

  it('effective masks combine the body mask and the matrix; the sanitiser keeps the matrix symmetric', () => {
    const l = setLayerPair(defaultLayers(), 1, 2, false);
    expect(layersCollide(l, 1, 2)).toBe(false);
    expect(layersCollide(l, 2, 1)).toBe(false);
    expect(effectiveMask({ group: 1, mask: 0xffff }, l) & (1 << 2)).toBe(0);
    expect(effectiveMask({ group: 1, mask: 0b1 }, l)).toBe(0b1);
    const dirty = layersField({
      names: ['A', 5, ' '],
      matrix: [0xffff & ~(1 << 7), ...new Array<number>(15).fill(0xffff)],
      trigger: 1.2e9,
    });
    expect(dirty.layers!.names[0]).toBe('A');
    expect(dirty.layers!.names[1]).toBe('Layer 1');
    expect(layersCollide(dirty.layers, 7, 0)).toBe(false); // one-sided input becomes symmetric
    expect(layersField({ names: [], matrix: [] })).toEqual({}); // the defaults are not stored
    expect(layersField('x')).toEqual({});
  });

  it('layers and wind round-trip through the document', () => {
    const doc = docOf([slab({ oneWay: [0, 1, 0] })], {
      layers: {
        ...setLayerPair(defaultLayers(), 1, 2, false),
        names: ['World', ...defaultLayers().names.slice(1)],
        trigger: 4,
      },
      wind: [3, 0, -1],
    });
    const back = parseDocument(serializeDocument(doc));
    expect(back.settings.layers!.names[0]).toBe('World');
    expect(layersCollide(back.settings.layers, 1, 2)).toBe(false);
    expect(back.settings.layers!.trigger).toBe(4);
    expect(back.settings.wind).toEqual([3, 0, -1]);
    const b = back.entities[0] as BodyEntity;
    expect(b.oneWay).toEqual([0, 1, 0]);
    const dirty = sanitizeDocument({ ...doc, settings: { ...doc.settings, wind: [1, 'x', 0], layers: 7 } });
    expect(dirty.settings.wind).toBeUndefined();
    expect(dirty.settings.layers).toBeUndefined();
  });
});

describe('one-way platforms (JT-31)', () => {
  const rest = async (platform: BodyEntity, b: BodyEntity, seconds = 4) => {
    const w = await worldOf([platform, b], noGround);
    run(w, seconds);
    return w.getPose(b.id)!;
  };

  it('a body thrown up from below passes through and lands on top; a normal slab stops it', async () => {
    const b = ball({ position: [0, 0, 0], velocity: [0, 9, 0] }); // peak ≈ 4.1 m above, slab at y = 2
    const oneWay = await rest(slab({ oneWay: [0, 1, 0] }), b);
    expect(oneWay.position[1]).toBeGreaterThan(2.3); // landed on top of the platform
    expect(Math.abs(oneWay.linvel[1])).toBeLessThan(0.3);
    const solid = await rest(slab(), b);
    expect(solid.position[1]).toBeLessThan(1.5); // stopped under the solid slab and fell back
  });

  it('a body dropped from above lands on it and stays', async () => {
    const p = await rest(slab({ oneWay: [0, 1, 0] }), ball({ position: [0, 5, 0] }));
    expect(p.position[1]).toBeGreaterThan(2.3);
    expect(p.position[1]).toBeLessThan(3.0);
  });

  it('the direction is the solid side: a downward platform lets bodies fall through from above', async () => {
    const p = await rest(slab({ oneWay: [0, -1, 0] }), ball({ position: [0, 5, 0] }), 2);
    expect(p.position[1]).toBeLessThan(-3);
    // and stops a body rising from below
    const up = await rest(slab({ oneWay: [0, -1, 0] }), ball({ position: [0, 0, 0], velocity: [0, 9, 0] }), 0.8);
    expect(up.position[1]).toBeLessThan(1.5);
  });

  it('follows the platform when it is rotated (local direction)', async () => {
    // a slab rotated 180° about X: its local +Y points down, so it is solid from below only
    const flipped = slab({ oneWay: [0, 1, 0], rotation: [1, 0, 0, 0] });
    const p = await rest(flipped, ball({ position: [0, 5, 0] }), 2);
    expect(p.position[1]).toBeLessThan(-3);
  });

  it('can be switched on and off on a live world', async () => {
    const plat = slab();
    const b = ball({ position: [0, 0, 0], velocity: [0, 9, 0] });
    const w = await worldOf([plat, b], noGround);
    w.updateBody({ ...plat, oneWay: [0, 1, 0] });
    run(w, 4);
    expect(w.getPose(b.id)!.position[1]).toBeGreaterThan(2.3);
    w.updateBody(plat); // back to solid: nothing changes for a body resting on it
    run(w, 1);
    expect(w.getPose(b.id)!.position[1]).toBeGreaterThan(2.3);
  });
});

describe('drag and wind (JT-32)', () => {
  it('terminal speed of a falling sphere equals √(2mg / (ρ·Cd·A))', async () => {
    const r = 0.1;
    const rho = 1.2,
      cd = 0.47,
      area = Math.PI * r * r;
    const b = ball({
      shape: { type: 'sphere', size: [2 * r, 2 * r, 2 * r] },
      position: [0, 400, 0],
      material: { preset: 'custom', density: 100 } as BodyEntity['material'],
      drag: { linear2: quadraticDragCoefficient(rho, cd, area), angular2: 0 },
    });
    const w = await worldOf([b], noGround);
    const m = w.builtInfo().mass[b.id];
    run(w, 10);
    const v = -w.getPose(b.id)!.linvel[1];
    const expected = Math.sqrt((2 * m * G) / (rho * cd * area));
    expect(terminalSpeed(m, G, quadraticDragCoefficient(rho, cd, area))).toBeCloseTo(expected, 6);
    expect(Math.abs(v - expected) / expected).toBeLessThan(0.02);
  });

  it('drag acts on the velocity relative to the wind', async () => {
    const b = ball({
      position: [0, 10, 0],
      material: { preset: 'custom', density: 10 } as BodyEntity['material'],
      drag: { linear2: 2, angular2: 0 },
    });
    const w = await worldOf([b], { ...noGround, gravity: [0, 0, 0] as Vec3, wind: [6, 0, -2] as Vec3 });
    run(w, 6);
    const v = w.getPose(b.id)!.linvel;
    expect(v[0]).toBeCloseTo(6, 0);
    expect(v[2]).toBeCloseTo(-2, 0);
    // without wind the same body stays at rest
    const calm = await worldOf([b], { ...noGround, gravity: [0, 0, 0] as Vec3 });
    run(calm, 2);
    expect(Math.hypot(...calm.getPose(b.id)!.linvel)).toBeLessThan(1e-6);
  });

  it('wind shifts the terminal velocity of a falling body sideways', async () => {
    const b = ball({ position: [0, 800, 0], drag: { linear2: 0.5, angular2: 0 } });
    const w = await worldOf([b], { ...noGround, wind: [4, 0, 0] as Vec3 });
    run(w, 12);
    const v = w.getPose(b.id)!.linvel;
    expect(v[0]).toBeGreaterThan(3.5);
    expect(v[1]).toBeLessThan(-5);
  });
});

describe('mass, COM and sleep controls (JT-33 / JT-34)', () => {
  /** Period of a hinged box pendulum from successive zero crossings of its swing angle. */
  async function period(com: Vec3 | undefined): Promise<{ T: number; m: number; Icm: number; d: number }> {
    const pivot = createBody({
      bodyType: 'static',
      shape: { type: 'box', size: [0.2, 0.2, 0.2] },
      position: [0, 10, 0],
    });
    const rod = createBody({
      shape: { type: 'box', size: [0.2, 1, 0.2] },
      position: [0.5 * Math.sin(0.08), 10 - 0.5 * Math.cos(0.08), 0], // hangs 0.08 rad from the vertical below the pivot
      material: { preset: 'custom', density: 1000 },
      rotation: [0, 0, Math.sin(0.04), Math.cos(0.04)],
      comOverride: com,
      ...free,
    });
    const hinge = createJoint({ type: 'hinge', bodyA: pivot.id, bodyB: rod.id, anchorA: [0, 0, 0], axis: [0, 0, 1] });
    const w = await worldOf([pivot, rod, hinge], { ...noGround, physicsHz: 480 });
    const info = w.builtInfo();
    const rb = w.state.bodies.get(rod.id)!.rb;
    const I = rb.principalInertia();
    const c = rb.localCom();
    const d = 0.5 - c.y; // pivot is the rod's top end (local +0.5)
    const times: number[] = [];
    const prev = w.getPose(rod.id)!;
    const ang = (q: number[]) => 2 * Math.atan2(q[2], q[3]);
    let prevA = ang(prev.rotation);
    for (let i = 0; i < 480 * 8; i++) {
      w.stepOnce();
      const a = ang(w.getPose(rod.id)!.rotation);
      if (prevA > 0 && a <= 0) times.push(w.simTime);
      prevA = a;
    }
    expect(times.length).toBeGreaterThan(3);
    return { T: (times[times.length - 1] - times[0]) / (times.length - 1), m: info.mass[rod.id], Icm: I.z, d };
  }

  it('moving the centre of mass changes the pendulum period as T = 2π√((I_cm + m d²)/(m g d))', async () => {
    for (const com of [undefined, [0, -0.3, 0] as Vec3, [0, 0.2, 0] as Vec3]) {
      const r = await period(com);
      const expected = 2 * Math.PI * Math.sqrt((r.Icm + r.m * r.d * r.d) / (r.m * G * r.d));
      expect(Math.abs(r.T - expected) / expected).toBeLessThan(0.03);
    }
    const plain = await period(undefined);
    const low = await period([0, -0.3, 0] as Vec3);
    expect(Math.abs(low.T - plain.T) / plain.T).toBeGreaterThan(0.05);
  });

  it('a mass override changes the response to the same impulse', async () => {
    const mk = (override?: number) => ball({ position: [0, 5, 0], massOverride: override, ...free });
    const light = await worldOf([mk(2)], { ...noGround, gravity: [0, 0, 0] as Vec3 });
    const heavy = await worldOf([mk(20)], { ...noGround, gravity: [0, 0, 0] as Vec3 });
    for (const w of [light, heavy])
      w.applyOp({ op: 'impulse', id: w.bodyIds[0], impulse: [10, 0, 0], point: [0, 5, 0] });
    run(light, 0.1);
    run(heavy, 0.1);
    expect(light.getPose(light.bodyIds[0])!.linvel[0]).toBeCloseTo(5, 2);
    expect(heavy.getPose(heavy.bodyIds[0])!.linvel[0]).toBeCloseTo(0.5, 2);
  });

  it('"wake all" wakes sleeping bodies', async () => {
    const plat = slab();
    const b = ball({ position: [0, 2.7, 0], canSleep: true });
    const w = await worldOf([plat, b]);
    run(w, 4);
    const rb = w.state.bodies.get(b.id)!.rb;
    expect(rb.isSleeping()).toBe(true);
    w.applyOp({ op: 'wakeAll' });
    expect(rb.isSleeping()).toBe(false);
  });
});

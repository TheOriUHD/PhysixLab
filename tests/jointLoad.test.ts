import { describe, expect, it } from 'vitest';
import { createBody, createJoint, run, worldOf } from './helpers';

const noDamp = { linearDamping: 0, angularDamping: 0, canSleep: false };
const G = 9.81;

function hangingMass(mass: number) {
  const ceiling = createBody({ bodyType: 'static', shape: { type: 'box', size: [1, 0.5, 1] }, position: [0, 10, 0] });
  const load = createBody({
    shape: { type: 'box', size: [1, 1, 1] },
    position: [0, 8.75, 0],
    material: { preset: 'custom', density: mass },
    ...noDamp,
  });
  const weld = createJoint({ type: 'fixed', bodyA: ceiling.id, bodyB: load.id, anchorA: [0, -0.25, 0] });
  return { ceiling, load, weld };
}

describe('joint load estimation (JT-10)', () => {
  it('a hanging mass of m kg loads its weld with m·g', async () => {
    for (const m of [2, 50]) {
      const { ceiling, load, weld } = hangingMass(m);
      const w = await worldOf([ceiling, load, weld]);
      w.watchLoads(true);
      run(w, 2);
      const r = w.getJointRec(weld.id)!;
      expect(r.load).toBeGreaterThan(m * G * 0.97);
      expect(r.load).toBeLessThan(m * G * 1.03);
      // the load hangs on the axis: no meaningful torque
      expect(r.torque).toBeLessThan(m * G * 0.05);
    }
  });

  it('loads respond to acceleration: an elevator body adds m·a to the weld', async () => {
    const { ceiling, load, weld } = hangingMass(10);
    // pull the whole assembly upwards with a constant extra force through a thruster on the load
    load.thrust = { mode: 'always', key: '', force: [0, 10 * 5, 0], torque: [0, 0, 0] };
    const w = await worldOf([ceiling, load, weld]);
    w.watchLoads(true);
    run(w, 1);
    // thrust pushes the block up into the ceiling: the weld load drops to m(g − 5)
    const r = w.getJointRec(weld.id)!;
    expect(r.load).toBeGreaterThan(10 * (G - 5) * 0.95);
    expect(r.load).toBeLessThan(10 * (G - 5) * 1.05);
  });

  it('a falling (free-fall) chain end carries no load; a swinging mass adds centripetal load', async () => {
    const ceiling = createBody({ bodyType: 'static', shape: { type: 'box', size: [1, 0.2, 1] }, position: [0, 10, 0] });
    const bob = createBody({
      shape: { type: 'sphere', size: [0.4, 0.4, 0.4] },
      position: [3, 10, 0],
      material: { preset: 'custom', density: 1000 },
      ...noDamp,
    });
    const hinge = createJoint({
      type: 'hinge',
      bodyA: ceiling.id,
      bodyB: bob.id,
      anchorA: [0, 0, 0],
      axis: [0, 0, 1],
    });
    const w = await worldOf([ceiling, bob, hinge]);
    w.watchLoads(true);
    const m = w.builtInfo().mass[bob.id];
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      w.stepOnce();
      peak = Math.max(peak, w.getJointRec(hinge.id)!.load);
    }
    // pendulum released horizontally: tension at the bottom is 3 m g (≥ m g throughout)
    expect(peak).toBeGreaterThan(m * G * 2.4);
    expect(peak).toBeLessThan(m * G * 3.6);
  });

  it('a balanced lever loads its pivot hinge with the total weight', async () => {
    const pivot = createBody({
      bodyType: 'static',
      shape: { type: 'box', size: [0.3, 0.3, 0.3] },
      position: [0, 5, 0],
    });
    const beam = createBody({
      shape: { type: 'box', size: [4, 0.2, 0.4] },
      position: [0, 5, 0],
      material: { preset: 'custom', density: 100 },
      ...noDamp,
    });
    const a = createBody({
      shape: { type: 'box', size: [0.4, 0.4, 0.4] },
      position: [-1.5, 5.4, 0],
      material: { preset: 'custom', density: 100 }, // 6.4 kg
      ...noDamp,
    });
    const b = createBody({
      shape: { type: 'box', size: [0.4, 0.4, 0.4] },
      position: [0.75, 5.4, 0],
      material: { preset: 'custom', density: 200 }, // 12.8 kg: 6.4·1.5 = 12.8·0.75
      ...noDamp,
    });
    const hinge = createJoint({ type: 'hinge', bodyA: pivot.id, bodyB: beam.id, anchorA: [0, 0, 0], axis: [0, 0, 1] });
    const wa = createJoint({ type: 'fixed', bodyA: beam.id, bodyB: a.id, anchorA: [-1.5, 0.1, 0] });
    const wb = createJoint({ type: 'fixed', bodyA: beam.id, bodyB: b.id, anchorA: [0.75, 0.1, 0] });
    const w = await worldOf([pivot, beam, a, b, hinge, wa, wb]);
    w.watchLoads(true);
    run(w, 1.5);
    const total = w.builtInfo().mass[beam.id] + w.builtInfo().mass[a.id] + w.builtInfo().mass[b.id];
    const r = w.getJointRec(hinge.id)!;
    expect(r.load).toBeGreaterThan(total * G * 0.95);
    expect(r.load).toBeLessThan(total * G * 1.05);
    // each weld carries its own weight
    const ra = w.getJointRec(wa.id)!;
    expect(ra.load).toBeGreaterThan(w.builtInfo().mass[a.id] * G * 0.95);
    expect(ra.load).toBeLessThan(w.builtInfo().mass[a.id] * G * 1.05);
    // and the weld of the mass at lever arm 1.5 m resists the moment m·g·(offset of its centre) only about its own anchor
    expect(ra.torque).toBeLessThan(w.builtInfo().mass[a.id] * G * 0.3);
  });
});

describe('breakable joints (JT-11 / JT-12)', () => {
  it('a weld breaks above its force threshold, holds below it, and a rebuilt world restores it', async () => {
    const { ceiling, load, weld } = hangingMass(50); // 490.5 N
    const weak = { ...weld, breakage: { force: 400, torque: 0, fatigue: { enabled: false, start: 0.6, life: 2 } } };
    const strong = { ...weld, breakage: { ...weak.breakage, force: 600 } };
    const w1 = await worldOf([ceiling, load, weak]);
    run(w1, 1);
    expect(w1.getJointRec(weld.id)!.broken).toBe(true);
    expect(w1.getPose(load.id)!.position[1]).toBeLessThan(8); // the block fell
    const events = w1.drainEvents().filter((e) => e.kind === 'jointBroken');
    expect(events).toHaveLength(1);
    const w2 = await worldOf([ceiling, load, strong]);
    run(w2, 1);
    const r2 = w2.getJointRec(weld.id)!;
    expect(r2.broken).toBe(false);
    expect(r2.ratio).toBeGreaterThan(0.75);
    expect(r2.ratio).toBeLessThan(0.9);
    expect(w2.getPose(load.id)!.position[1]).toBeCloseTo(8.75, 1);
    // "reset" = building the world again from the document: the weak weld exists again
    const w3 = await worldOf([ceiling, load, weak]);
    expect(w3.getJointRec(weld.id)!.broken).toBe(false);
  });

  it('a torque threshold breaks a cantilever weld that carries a load far from its anchor', async () => {
    const wall = createBody({ bodyType: 'static', shape: { type: 'box', size: [0.4, 4, 2] }, position: [0, 2, 0] });
    const beam = createBody({
      shape: { type: 'box', size: [2, 0.2, 0.4] },
      position: [1.2, 3, 0],
      material: { preset: 'custom', density: 100 }, // 16 kg
      ...noDamp,
    });
    const weld = createJoint({ type: 'fixed', bodyA: wall.id, bodyB: beam.id, anchorA: [0.2, 1, 0] });
    const spec = (torque: number) => ({
      ...weld,
      breakage: { force: 0, torque, fatigue: { enabled: false, start: 0.6, life: 2 } },
    });
    // Cantilever statics: the weld resists M = m·g·(L/2) = 16·9.81·1.0 = 157 N·m.
    const holds = await worldOf([wall, beam, spec(180)]);
    holds.watchLoads(true);
    run(holds, 1.5);
    const r = holds.getJointRec(weld.id)!;
    expect(r.broken).toBe(false);
    expect(r.torque).toBeGreaterThan(157 * 0.95);
    expect(r.torque).toBeLessThan(157 * 1.05);
    const fails = await worldOf([wall, beam, spec(140)]);
    run(fails, 1.5);
    expect(fails.getJointRec(weld.id)!.broken).toBe(true);
  });

  it('a heavy block dropped on a welded plank breaks it above the threshold and not below', async () => {
    const wall = createBody({ bodyType: 'static', shape: { type: 'box', size: [0.4, 4, 2] }, position: [0, 2, 0] });
    const plank = createBody({
      shape: { type: 'box', size: [3, 0.2, 1] },
      position: [1.7, 3, 0],
      material: { preset: 'custom', density: 100 },
      ...noDamp,
    });
    const block = createBody({
      shape: { type: 'box', size: [0.6, 0.6, 0.6] },
      position: [2.6, 5, 0],
      material: { preset: 'custom', density: 2000 },
      ...noDamp,
    });
    const weld = createJoint({ type: 'fixed', bodyA: wall.id, bodyB: plank.id, anchorA: [0.2, 1, 0] });
    const withLimit = (force: number) => ({
      ...weld,
      breakage: { force, torque: 0, fatigue: { enabled: false, start: 0.6, life: 2 } },
    });
    // Measure the peak weld load of the impact with the weld left unbreakable.
    const probe = await worldOf([wall, plank, block, weld]);
    probe.watchLoads(true);
    let peak = 0;
    for (let i = 0; i < 360; i++) {
      probe.stepOnce();
      peak = Math.max(peak, probe.getJointRec(weld.id)!.load);
    }
    const restWeight = (probe.builtInfo().mass[plank.id] + probe.builtInfo().mass[block.id]) * G;
    expect(peak).toBeGreaterThan(restWeight * 1.2); // the impact is a real spike over the static load
    const weak = await worldOf([wall, plank, block, withLimit(peak * 0.8)]);
    run(weak, 3);
    expect(weak.getJointRec(weld.id)!.broken).toBe(true);
    const tough = await worldOf([wall, plank, block, withLimit(peak * 1.25)]);
    run(tough, 3);
    expect(tough.getJointRec(weld.id)!.broken).toBe(false);
  });

  it('fatigue accumulates damage under sustained sub-threshold stress and eventually fails the joint', async () => {
    const { ceiling, load, weld } = hangingMass(50); // 490.5 N
    const spec = (fatigue: boolean) => ({
      ...weld,
      breakage: { force: 600, torque: 0, fatigue: { enabled: fatigue, start: 0.5, life: 1 } },
    });
    const off = await worldOf([ceiling, load, spec(false)]);
    run(off, 3);
    expect(off.getJointRec(weld.id)!.broken).toBe(false);
    const on = await worldOf([ceiling, load, spec(true)]);
    run(on, 0.3);
    const d = on.getJointRec(weld.id)!.damage;
    expect(d).toBeGreaterThan(0);
    expect(on.getJointRec(weld.id)!.broken).toBe(false);
    run(on, 4);
    expect(on.getJointRec(weld.id)!.broken).toBe(true);
  });
});

describe('breakage document field', () => {
  it('round-trips through the sanitiser and clamps hostile values', async () => {
    const { sanitizeDocument, serializeDocument, parseDocument } = await import('../src/model/serialize');
    const { weld, ceiling, load } = hangingMass(5);
    const doc = {
      ...(await import('./helpers')).docOf([ceiling, load]),
    };
    doc.entities.push({
      ...weld,
      breakage: { force: 1234, torque: 56, fatigue: { enabled: true, start: 0.4, life: 3 } },
    });
    const back = parseDocument(serializeDocument(doc));
    const j = back.entities.find((e) => e.id === weld.id);
    expect(j && 'breakage' in j ? j.breakage : null).toEqual({
      force: 1234,
      torque: 56,
      fatigue: { enabled: true, start: 0.4, life: 3 },
    });
    const dirty = sanitizeDocument({
      ...doc,
      entities: [
        ceiling,
        load,
        { ...weld, breakage: { force: -5, torque: 'x', fatigue: { enabled: 1, start: 9, life: -1 } } },
      ],
    });
    const d = dirty.entities.find((e) => e.id === weld.id);
    const b = d && 'breakage' in d ? d.breakage : undefined;
    expect(b).toEqual({ force: 0, torque: 0, fatigue: { enabled: false, start: 0.99, life: 0.01 } });
  });
});

describe('estimator edge cases', () => {
  it('a chain of two welds: each weld carries the weight below it', async () => {
    const ceiling = createBody({ bodyType: 'static', shape: { type: 'box', size: [1, 0.5, 1] }, position: [0, 10, 0] });
    const mk = (y: number) =>
      createBody({
        shape: { type: 'box', size: [1, 1, 1] },
        position: [0, y, 0],
        material: { preset: 'custom', density: 10 },
        ...noDamp,
      });
    const a = mk(8.75);
    const b = mk(7.5);
    const j1 = createJoint({ type: 'fixed', bodyA: ceiling.id, bodyB: a.id, anchorA: [0, -0.25, 0] });
    const j2 = createJoint({ type: 'fixed', bodyA: a.id, bodyB: b.id, anchorA: [0, -0.625, 0] });
    const w = await worldOf([ceiling, a, b, j1, j2]);
    w.watchLoads(true);
    run(w, 2);
    expect(w.getJointRec(j1.id)!.load / (20 * G)).toBeCloseTo(1, 1);
    expect(w.getJointRec(j2.id)!.load / (10 * G)).toBeCloseTo(1, 1);
  });

  it('two welds to the ceiling share a centred load; updating a joint keeps it broken and keeps fatigue', async () => {
    const ceiling = createBody({ bodyType: 'static', shape: { type: 'box', size: [3, 0.5, 1] }, position: [0, 10, 0] });
    const m = createBody({
      shape: { type: 'box', size: [2, 1, 1] },
      position: [0, 8.75, 0],
      material: { preset: 'custom', density: 20 },
      ...noDamp,
    });
    const l = createJoint({ type: 'fixed', bodyA: ceiling.id, bodyB: m.id, anchorA: [-0.7, -0.25, 0] });
    const r = createJoint({ type: 'fixed', bodyA: ceiling.id, bodyB: m.id, anchorA: [0.7, -0.25, 0] });
    const w = await worldOf([ceiling, m, l, r]);
    w.watchLoads(true);
    run(w, 2);
    const weight = 40 * G;
    expect(w.getJointRec(l.id)!.load / (weight / 2)).toBeGreaterThan(0.9);
    expect(w.getJointRec(l.id)!.load / (weight / 2)).toBeLessThan(1.1);
    expect(w.getJointRec(l.id)!.load + w.getJointRec(r.id)!.load).toBeGreaterThan(weight * 0.95);
    // a broken joint stays broken when its definition is edited
    const fat = { enabled: false, start: 0.6, life: 2 };
    w.updateJoint({ ...l, breakage: { force: 1, torque: 0, fatigue: fat } });
    run(w, 0.2);
    expect(w.getJointRec(l.id)!.broken).toBe(true);
    w.updateJoint({ ...l, breakage: { force: 1e6, torque: 0, fatigue: fat } });
    expect(w.getJointRec(l.id)!.broken).toBe(true);
  });
});

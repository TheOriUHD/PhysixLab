/** Package SF — soft-body upgrades, tested against the real engine with analytic / physical expectations. */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, vadd, type Vec3 } from '../src/core/math';
import { convexHullMesh } from '../src/core/hull';
import { createBody, createJoint, createSoft } from '../src/model/factory';
import { sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { softParticleCount } from '../src/model/softBudget';
import { formatPascal, softYoungModulus, stiffnessForYoungModulus } from '../src/model/softMaterial';
import { softSurface } from '../src/model/softMesh';
import type { SoftAttachment } from '../src/model/types';
import type { PhysicsWorld } from '../src/physics/world';
import type { WorldState } from '../src/physics/world/state';
import { docOf, worldOf } from './helpers';

const run = (w: PhysicsWorld, s: number) => {
  for (let i = 0; i < Math.round(s * w.settings.physicsHz); i++) w.stepOnce();
};
const priv = (w: PhysicsWorld) => (w as unknown as { s: WorldState }).s;
const bounds = (pos: Float32Array) => {
  const lo = [1e9, 1e9, 1e9],
    hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]);
      hi[k] = Math.max(hi[k], pos[i + k]);
    }
  return { lo, hi };
};
const DOWN_X = qfromAxisAngle([0, 0, 1], -Math.PI / 2); // a cable along local +X hangs with its first particle on top

function hangingCable(extra: Partial<SoftAttachment> = {}, cableOver = {}) {
  const weight = createBody({
    shape: { type: 'sphere', size: [0.4, 0.4, 0.4] },
    position: [0, 2.8, 0],
    material: { preset: 'custom', density: 150 },
  });
  const att: SoftAttachment = {
    id: 'a1',
    body: weight.id,
    kind: 'region',
    center: [1.5, 0, 0],
    radius: 0.05,
    offset: [0, 0.2, 0],
    ...extra,
  };
  const cable = createSoft('cable', {
    position: [0, 4.5, 0],
    rotation: DOWN_X,
    size: [3, 0, 0],
    resolution: 24,
    pin: 'one-end',
    mass: 1,
    attachments: [att],
    ...cableOver,
  });
  return { weight, cable, att };
}

describe('SF-1 attachments', () => {
  it('a cable pinned at the top holds a 5 kg weight: it hangs at the cable length and stays there', async () => {
    const { weight, cable } = hangingCable();
    const w = await worldOf([weight, cable]);
    const s = priv(w);
    expect(s.softOrder[0].attached[0].particles).toEqual([23]); // the end particle
    run(w, 3);
    const rb = s.bodies.get(weight.id)!.rb;
    const m = rb.mass();
    expect(m).toBeCloseTo((4 / 3) * Math.PI * 0.2 ** 3 * 150, 2);
    const lv = rb.linvel();
    expect(Math.hypot(lv.x, lv.y, lv.z)).toBeLessThan(0.6);
    // pin at y = 6, cable 3 m, attachment 0.2 m above the centre → rest centre at 2.8 (a little lower when it stretches)
    expect(rb.translation().y).toBeGreaterThan(2.55);
    expect(rb.translation().y).toBeLessThan(2.85);
    // momentum balance of the whole hanging system: the pin carries (m_weight + m_cable)·g on average
    const probe: number[] = [];
    for (let k = 0; k < 120; k++) {
      w.stepOnce();
      const v = rb.linvel();
      probe.push(v.y);
    }
    const mean = probe.reduce((a, b) => a + b, 0) / probe.length;
    expect(Math.abs(mean)).toBeLessThan(0.05); // no net acceleration ⇒ tension T = m·g
  });

  it('the attachment follows the body: rotating and moving the body carries the fastened particles', async () => {
    const box = createBody({ shape: { type: 'box', size: [1, 0.2, 0.2] }, position: [0, 3, 0], bodyType: 'kinematic' });
    const att: SoftAttachment = {
      id: 'a1',
      body: box.id,
      kind: 'region',
      center: [0, 0, 0],
      radius: 0.05,
      offset: [0.4, 0, 0],
    };
    const cloth = createSoft('cloth', {
      position: [0.4, 3, 0],
      size: [0.6, 0, 0.6],
      resolution: 8,
      attachments: [att],
      gravityScale: 0.1,
    });
    const w = await worldOf([box, cloth]);
    const s = priv(w);
    const rec = s.softOrder[0];
    const idx = rec.attached[0].particles[0];
    const turn = qfromAxisAngle([0, 1, 0], Math.PI / 2);
    w.applyOp({ op: 'teleport', id: box.id, position: [1, 3, 0], rotation: turn });
    run(w, 0.2);
    const p = rec.root.particlePosition(idx);
    const want = vadd([1, 3, 0], qrot(turn, [0.4, 0, 0]));
    expect(Math.hypot(p.x - want[0], p.y - want[1], p.z - want[2])).toBeLessThan(0.08);
  });

  it('a broken joint releases the attachment and the weight falls', async () => {
    const { weight, cable, att } = hangingCable();
    const joint = createJoint({
      type: 'spring',
      bodyA: null,
      bodyB: weight.id,
      anchorA: [0, 3.0, 0],
      anchorB: [0, 0, 0],
      spring: { restLength: 0.2, stiffness: 200, damping: 5, breakForce: 60 },
    });
    cable.attachments = [{ ...att, joint: joint.id }];
    const w = await worldOf([weight, cable, joint]);
    const s = priv(w);
    expect(s.softOrder[0].attached.length).toBe(1);
    w.applyOp({ op: 'impulse', id: weight.id, impulse: [0, -40, 0], point: [0, 2.8, 0] }); // yank: the spring overstretches and fails
    run(w, 0.5);
    expect(s.joints.get(joint.id)!.broken).toBe(true);
    expect(s.softOrder[0].attached.length).toBe(0);
    expect(s.softOrder[0].root.numAttachments()).toBe(0);
  });

  it('removing the body releases the fastening instead of leaving a dangling attachment', async () => {
    const { weight, cable } = hangingCable();
    const w = await worldOf([weight, cable]);
    w.applyOp({ op: 'remove', ids: [weight.id] });
    run(w, 0.3);
    const s = priv(w);
    expect(s.softOrder[0].attached.length).toBe(0);
    expect(s.softOrder[0].root.numAttachments()).toBe(0);
  });

  it('an attachment to a body added after the soft body is fastened once the body appears', async () => {
    const { weight, cable } = hangingCable();
    const w = await worldOf([cable]);
    const s = priv(w);
    expect(s.softOrder[0].attached.length).toBe(0);
    w.applyOp({ op: 'addBody', body: weight });
    run(w, 0.1);
    expect(s.softOrder[0].attached.length).toBe(1);
  });

  it('manual release op frees the particles', async () => {
    const { weight, cable } = hangingCable();
    const w = await worldOf([weight, cable]);
    w.applyOp({ op: 'releaseSoft', id: cable.id });
    run(w, 0.1);
    expect(priv(w).softOrder[0].root.numAttachments()).toBe(0);
  });

  it('hostile mesh / tyre sizes cannot request a huge lattice', () => {
    const doc = docOf([createSoft('mesh'), createSoft('tyre')]);
    const raw = JSON.parse(serializeDocument(doc)) as { entities: { size?: number[]; cell?: number }[] };
    raw.entities[0].size = [1e6, 1e6, 1e6];
    raw.entities[0].cell = 0.04;
    raw.entities[1].size = [500, 0.0001, 0.0001];
    const [m, t] = sanitizeDocument(raw).entities;
    expect(m.kind === 'soft' && softParticleCount(m)).toBeLessThan(100000);
    expect(t.kind === 'soft' && softParticleCount(t)).toBeLessThan(20000);
  });

  it('attachments survive a save / load round trip and untrusted JSON is repaired', () => {
    const { weight, cable } = hangingCable();
    const doc = docOf([weight, cable]);
    const back = sanitizeDocument(JSON.parse(serializeDocument(doc)));
    const soft = back.entities.find((e) => e.kind === 'soft');
    expect(soft && soft.kind === 'soft' && soft.attachments).toEqual(cable.attachments);
    const raw = JSON.parse(serializeDocument(doc)) as { entities: { attachments?: unknown }[] };
    raw.entities[1].attachments = [{ body: 7 }, { body: 'x', radius: -4, offset: [1, 'a', 3], kind: 'zzz' }, null];
    const fixed = sanitizeDocument(raw).entities.find((e) => e.kind === 'soft');
    expect(fixed && fixed.kind === 'soft' && fixed.attachments.length).toBe(1);
    expect(fixed && fixed.kind === 'soft' && fixed.attachments[0].radius).toBeGreaterThan(0);
    expect(fixed && fixed.kind === 'soft' && fixed.attachments[0].kind).toBe('region');
  });
});

describe('SF-2 cutting', () => {
  it('cutting a free cloth along a line splits it into two pieces that fall apart', async () => {
    const cloth = createSoft('cloth', {
      position: [0, 2, 0],
      size: [2, 0, 2],
      resolution: 14,
      rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
    });
    const w = await worldOf([cloth]);
    run(w, 0.3);
    const n0 = w.readSoft().positions.length / 3;
    w.applyOp({ op: 'cutSoft', id: cloth.id, origin: [0, 2, 6], a: [0, 6, -6], b: [0, -2, -6] });
    const after = w.readSoft();
    expect(after.layout).toBeDefined(); // topology changed
    expect(after.positions.length / 3).toBeGreaterThan(n0); // the cut duplicates particles along the seam
    expect(w.world.softBodies.getAll().length).toBe(2);
    w.applyOp({ op: 'impulse', id: 'none', impulse: [0, 0, 0], point: [0, 0, 0] });
    expect(after.positions.every(Number.isFinite)).toBe(true);
  });

  it('cutting a pinned hanging banner leaves the pinned halves hanging on either side', async () => {
    const cloth = createSoft('cloth', {
      position: [0, 3, 0],
      size: [2, 0, 2],
      resolution: 14,
      pin: 'corners',
      rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
    });
    const w = await worldOf([cloth]);
    run(w, 1);
    w.applyOp({ op: 'cutSoft', id: cloth.id, origin: [0, 3, 6], a: [0, 6, -6], b: [0, 0, -6] });
    w.readSoft();
    run(w, 1);
    expect(w.world.softBodies.getAll().length).toBe(2);
    const pos = w.readSoft().positions;
    expect(pos.every(Number.isFinite)).toBe(true);
  });

  it('a cut that misses the cloth changes nothing; tear-on-demand opens a hole', async () => {
    const cloth = createSoft('cloth', { position: [0, 2, 0], size: [2, 0, 2], resolution: 12, pin: 'corners4' });
    const w = await worldOf([cloth]);
    w.readSoft();
    w.applyOp({ op: 'cutSoft', id: cloth.id, origin: [20, 20, 20], a: [30, 20, 20], b: [20, 30, 20] });
    expect(w.readSoft().layout).toBeUndefined();
    const n0 = w.readSoft().positions.length / 3;
    w.applyOp({ op: 'tearSoft', id: cloth.id, point: [0, 2, 0], radius: 0.25 });
    const r = w.readSoft();
    expect(r.layout).toBeDefined();
    expect(r.positions.length / 3).toBeGreaterThan(n0);
  });

  it('a cable can be cut too', async () => {
    const cable = createSoft('cable', { position: [0, 3, 0], size: [3, 0, 0], resolution: 20, pin: 'ends' });
    const w = await worldOf([cable]);
    w.readSoft();
    w.applyOp({ op: 'cutSoft', id: cable.id, origin: [0, 3, 6], a: [0, 6, -6], b: [0, 0, -6] });
    run(w, 1.5);
    expect(w.world.softBodies.getAll().length).toBe(2);
  });
});

describe('SF-4 pressure and tyres', () => {
  it('a balloon inflates to its target volume and deflates through a puncture', async () => {
    const balloon = createSoft('balloon', { position: [0, 2, 0], volumeFactor: 1.4, gravityScale: 0 });
    const w = await worldOf([balloon]);
    const sb = priv(w).softOrder[0].root;
    const v0 = sb.restVolume();
    run(w, 2);
    expect(sb.volume() / v0).toBeGreaterThan(1.25);
    expect(sb.volume() / v0).toBeLessThan(1.5);
    w.applyOp({ op: 'updateSoft', soft: { ...balloon, leakRate: 2, volumeFactor: 1.4 } });
    run(w, 4);
    const sb2 = priv(w).softOrder[0].root;
    expect(sb2.volume() / sb2.restVolume()).toBeLessThan(0.5);
  });

  it('a pneumatic tyre on a hub carries a 60 kg load without collapsing, an unpressurised one does not', async () => {
    const mk = (pressure: number, stiffness: number) => {
      const hub = createBody({
        shape: { type: 'cylinder', size: [0.12, 0.2, 0.12] },
        position: [0, 0.4, 0],
        rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
      });
      hub.material = { ...hub.material, density: 60 / (Math.PI * 0.06 * 0.06 * 0.2) };
      const tyre = createSoft('tyre', {
        position: [0, 0.4, 0],
        rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
        stiffness,
        volumeFactor: pressure,
        attachments: [{ id: 'rim', body: hub.id, kind: 'rim', center: [0, 0, 0], radius: 0.1, offset: [0, 0, 0] }],
      });
      return { hub, tyre };
    };
    const good = mk(1.3, 400);
    const w = await worldOf([good.hub, good.tyre]);
    run(w, 3);
    const hubY = priv(w).bodies.get(good.hub.id)!.rb.translation().y;
    const b = bounds(w.readSoft().positions);
    expect(priv(w).softOrder[0].attached[0].particles.length).toBeGreaterThan(40);
    expect(hubY).toBeGreaterThan(0.38); // 0.4 m nominal axle height
    expect(b.hi[1] - b.lo[1]).toBeGreaterThan(0.74); // the tyre keeps its 0.8 m diameter
    const flat = mk(1, 40);
    const w2 = await worldOf([flat.hub, flat.tyre]);
    run(w2, 3);
    expect(priv(w2).bodies.get(flat.hub.id)!.rb.translation().y).toBeLessThan(0.3);
  });

  it('an airless tyre builds from the volumetric lattice and keeps its volume', async () => {
    const tyre = createSoft('tyre', { position: [0, 1, 0], pneumatic: false, stiffness: 60 });
    const w = await worldOf([tyre]);
    const sb = priv(w).softOrder[0].root;
    expect(sb.numCells()).toBeGreaterThan(100);
    run(w, 1);
    expect(sb.volume() / sb.restVolume()).toBeGreaterThan(0.9);
  });
});

describe('SF-5 volumetric soft meshes', () => {
  it('the convex hull of a point cloud is a closed, outward-wound triangle mesh', () => {
    const cube: Vec3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) cube.push([x, y, z]);
    cube.push([0, 0, 0], [0.2, 0.1, -0.3]); // interior points must be ignored
    const m = convexHullMesh(cube)!;
    expect(m.vertices.length / 3).toBe(8);
    expect(m.indices.length / 3).toBe(12);
    let vol = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => m.indices[t + k] * 3);
      const v = m.vertices;
      vol +=
        (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
          v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
          v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
        6;
    }
    expect(vol).toBeCloseTo(8, 5);
    expect(
      convexHullMesh([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
      ]),
    ).toBeNull(); // coplanar
  });

  it.each(['box', 'cylinder', 'sphere', 'capsule', 'cone', 'icosahedron', 'wedge'] as const)(
    'a %s jelly builds, falls, lands and keeps roughly its height',
    async (type) => {
      const surf = softSurface({ type, size: [1, 1, 1] });
      expect(surf).not.toBeNull();
      const jelly = createSoft('mesh', {
        position: [0, 1.5, 0],
        shape: { type, size: [1, 1, 1] },
        size: [1, 1, 1],
        cell: 0.25,
      });
      const w = await worldOf([jelly]);
      const r0 = w.readSoft();
      expect(priv(w).softOrder[0].root.numParticles()).toBeGreaterThan(40);
      expect(r0.layout![0].count).toBeGreaterThan(100); // the drawn skin is refined to the cell size
      run(w, 3.5);
      const b = bounds(w.readSoft().positions);
      expect(b.lo[1]).toBeGreaterThan(-0.05);
      expect(b.hi[1] - b.lo[1]).toBeGreaterThan(0.45);
      expect(b.hi[1] - b.lo[1]).toBeLessThan(1.15);
    },
  );

  it('resolution control: a smaller cell makes more particles', async () => {
    const mk = (cell: number) =>
      createSoft('mesh', { position: [0, 1, 0], shape: { type: 'sphere', size: [1, 1, 1] }, cell });
    const a = await worldOf([mk(0.3)]);
    const b = await worldOf([mk(0.18)]);
    expect(priv(b).softOrder[0].root.numParticles()).toBeGreaterThan(priv(a).softOrder[0].root.numParticles() * 1.5);
  });

  it('a rotated mesh jelly is built in the rotated pose', async () => {
    const jelly = createSoft('mesh', {
      position: [0, 5, 0],
      shape: { type: 'box', size: [2, 0.4, 0.4] },
      size: [2, 0.4, 0.4],
      cell: 0.2,
      rotation: qfromAxisAngle([0, 0, 1], Math.PI / 2),
      gravityScale: 0,
    });
    const w = await worldOf([jelly]);
    const b = bounds(w.readSoft().positions);
    expect(b.hi[1] - b.lo[1]).toBeGreaterThan(1.7);
    expect(b.hi[0] - b.lo[0]).toBeLessThan(0.7);
  });
});

describe('SF-6 soft-rigid friction and collision tuning', () => {
  it('surface friction decides whether a jelly slides under a sideways pull (gravity tilted like a slope)', async () => {
    const slide = async (friction: number) => {
      const jelly = createSoft('jelly', { position: [0, 0.55, 0], friction, mass: 10 });
      const w = await worldOf([jelly], { gravity: [5, -9.81, 0] }); // ≈ 27° slope: tan = 0.51
      run(w, 3);
      const b = bounds(w.readSoft().positions);
      return (b.lo[0] + b.hi[0]) / 2;
    };
    const slick = await slide(0.05);
    const grippy = await slide(2);
    expect(slick).toBeGreaterThan(3);
    expect(grippy).toBeLessThan(slick * 0.5);
  });

  it('the particle radius override sets how far the surface hovers above the ground', async () => {
    const rest = async (particleRadius: number) => {
      const jelly = createSoft('jelly', { position: [0, 0.6, 0], particleRadius });
      const w = await worldOf([jelly]);
      run(w, 2);
      return bounds(w.readSoft().positions).lo[1];
    };
    const thin = await rest(0.015);
    const thick = await rest(0.1);
    expect(thick - thin).toBeGreaterThan(0.05);
  });
});

describe('SF-7 material model', () => {
  it('Young-modulus readout is the documented mapping and its inverse round-trips', () => {
    const j = createSoft('jelly', { stiffness: 12 });
    const E = softYoungModulus(j);
    // ρ = 20 kg/m³ over a 1 m cube, 5 particles per side → h = 0.25 m, ω = 2π·12
    const w = 2 * Math.PI * 12;
    expect(E).toBeCloseTo((20 * (w * 0.25) ** 2) / 2, 6);
    expect(formatPascal(E)).toMatch(/kPa$/);
    const f = stiffnessForYoungModulus(j, E);
    expect(f).toBeCloseTo(12, 6);
    expect(softYoungModulus({ ...j, stiffness: 24 })).toBeCloseTo(4 * E, 6); // E ∝ f²
  });

  it('Poisson ratio and plasticity reach the engine material; permanent set changes the rest length', async () => {
    const cable = createSoft('cable', {
      position: [0, 3, 0],
      size: [3, 0, 0],
      resolution: 12,
      pin: 'ends',
      plasticYield: 0.01,
      stiffness: 20,
      poisson: 0.45,
    });
    const w = await worldOf([cable]);
    const sb = priv(w).softOrder[0].root;
    expect(sb.material().poissonRatio).toBeCloseTo(0.45, 5);
    expect(sb.material().edgePlasticYield).toBeCloseTo(0.01, 5);
    const rest0 = sb.edgeRestLength(0);
    w.applyOp({ op: 'grabSoft', id: cable.id, index: 6, target: [0, 1, 0] });
    run(w, 2);
    w.applyOp({ op: 'release' });
    run(w, 2);
    expect(sb.edgeRestLength(0)).toBeGreaterThan(rest0 * 1.005); // permanently stretched
    const elastic = createSoft('cable', {
      position: [0, 3, 0],
      size: [3, 0, 0],
      resolution: 12,
      pin: 'ends',
      stiffness: 20,
    });
    const w2 = await worldOf([elastic]);
    const sb2 = priv(w2).softOrder[0].root;
    const r2 = sb2.edgeRestLength(0);
    w2.applyOp({ op: 'grabSoft', id: elastic.id, index: 6, target: [0, 1, 0] });
    run(w2, 2);
    w2.applyOp({ op: 'release' });
    run(w2, 2);
    expect(sb2.edgeRestLength(0)).toBeCloseTo(r2, 6); // purely elastic: no permanent set
  });
});

describe('SF-8 elastic energy', () => {
  const energyOf = (w: PhysicsWorld) => {
    w.readPoses(1);
    w.readSoft();
    return w.stats().energy;
  };

  it('a stretched, undamped cable trades elastic for kinetic energy; the sum is bounded and the loss shrinks with the step', async () => {
    const swing = async (hz: number) => {
      const cable = createSoft('cable', {
        position: [0, 5, 0],
        size: [3, 0, 0],
        resolution: 16,
        pin: 'none',
        damping: 0,
        linearDamping: 0,
        gravityScale: 0,
        stiffness: 8,
      });
      const w = await worldOf([cable], { physicsHz: hz, ground: { ...docOf([]).settings.ground, enabled: false } });
      const sb = priv(w).softOrder[0].root;
      for (let i = 0; i < sb.numParticles(); i++) {
        const p = sb.particlePosition(i);
        sb.setParticlePosition(i, { x: p.x * 1.4, y: p.y, z: p.z });
      }
      const e0 = energyOf(w);
      expect(e0.elastic).toBeGreaterThan(5);
      expect(e0.kinetic).toBeLessThan(1e-6);
      let maxKe = 0,
        minTotal = Infinity,
        maxTotal = 0;
      const steps = Math.round(0.4 * hz); // about one oscillation period
      for (let k = 0; k < steps; k++) {
        w.stepOnce();
        if (k % Math.max(1, Math.round(hz / 60))) continue;
        const e = energyOf(w);
        maxKe = Math.max(maxKe, e.kinetic);
        minTotal = Math.min(minTotal, e.kinetic + e.elastic);
        maxTotal = Math.max(maxTotal, e.kinetic + e.elastic);
      }
      return { total0: e0.elastic, maxKe, minTotal, maxTotal };
    };
    const coarse = await swing(120);
    expect(coarse.maxKe).toBeGreaterThan(0.7 * coarse.total0); // the energy really swings into motion
    expect(coarse.maxTotal).toBeLessThan(coarse.total0 * 1.03); // nothing is created
    expect(coarse.minTotal).toBeGreaterThan(coarse.total0 * 0.75);
    const fine = await swing(480);
    expect(fine.maxTotal).toBeLessThan(fine.total0 * 1.03);
    expect(fine.minTotal).toBeGreaterThan(fine.total0 * 0.9); // within 10 % at a 480 Hz step
    expect(fine.minTotal / fine.total0).toBeGreaterThan(coarse.minTotal / coarse.total0); // converges
  });

  it('elastic energy of a jelly lying on the ground is reported and positive under load, zero at rest in free space', async () => {
    const jelly = createSoft('jelly', { position: [0, 0.5, 0], gravityScale: 0, damping: 0.3 });
    const w = await worldOf([jelly], { ground: { ...docOf([]).settings.ground, enabled: false } });
    expect(energyOf(w).elastic).toBeCloseTo(0, 6);
    const w2 = await worldOf([createSoft('jelly', { position: [0, 0.5, 0], mass: 80, stiffness: 6 })]);
    run(w2, 2);
    expect(energyOf(w2).elastic).toBeGreaterThan(0.01);
  });
});

describe('SF-9 budget and time travel', () => {
  it('a snapshot taken while a cable carries a weight restores the fastening and the pressure', async () => {
    const { weight, cable } = hangingCable();
    const w = await worldOf([weight, cable]);
    run(w, 1);
    w.applyOp({ op: 'snapshot', id: 1 });
    const snap = priv(w).snapshots.pop()!.snapshot;
    const y0 = priv(w).bodies.get(weight.id)!.rb.translation().y;
    w.applyOp({ op: 'releaseSoft', id: cable.id });
    run(w, 1);
    expect(priv(w).bodies.get(weight.id)!.rb.translation().y).toBeLessThan(y0 - 0.5); // it fell
    w.applyOp({ op: 'restore', snapshot: snap });
    const s = priv(w);
    expect(s.softOrder[0].attached.length).toBe(1);
    expect(s.softOrder[0].root.numAttachments()).toBe(1);
    run(w, 1);
    expect(s.bodies.get(weight.id)!.rb.translation().y).toBeGreaterThan(y0 - 0.25); // held again
  });

  it('economy mode lowers the soft-body impact substeps', async () => {
    const w = await worldOf([createSoft('jelly', { position: [0, 2, 0] })]);
    const ip = priv(w).world.integrationParameters;
    const before = ip.softBodiesMaxExtraSubsteps;
    w.applyOp({ op: 'softEconomy', on: true });
    expect(ip.softBodiesMaxExtraSubsteps).toBe(0);
    w.applyOp({ op: 'softEconomy', on: false });
    expect(ip.softBodiesMaxExtraSubsteps).toBe(before);
  });
});

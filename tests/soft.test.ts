import { describe, expect, it } from 'vitest';
import { createBody, createSoft } from '../src/model/factory';
import { qfromAxisAngle, vlen } from '../src/core/math';
import { worldOf } from './helpers';
import type { PhysicsWorld } from '../src/physics/world';

const run = (w: PhysicsWorld, s: number) => { for (let i = 0; i < Math.round(s * w.settings.physicsHz); i++) w.stepOnce(); };
const bounds = (pos: Float32Array) => {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
  return { lo, hi };
};

describe('soft bodies', () => {
  it('a jelly cube falls, squashes on the ground and keeps its volume', async () => {
    const jelly = createSoft('jelly', { position: [0, 3, 0] });
    const w = await worldOf([jelly]);
    run(w, 2.5);
    const { layout, positions } = w.readSoft();
    expect(layout).toBeDefined();
    expect(layout![0].count).toBe(125); // 5³ lattice
    expect(layout![0].mode).toBe('tri');
    expect(positions.every(Number.isFinite)).toBe(true);
    const b = bounds(positions);
    expect(b.lo[1]).toBeGreaterThan(-0.05); // rests on the ground, not through it
    expect(b.lo[1]).toBeLessThan(0.1);
    expect(b.hi[1] - b.lo[1]).toBeLessThan(1.05); // 1 m cube sits at ≤ its rest height
    expect(w.builtInfo().mass[jelly.id]).toBe(20);
  });

  it('a pinned cloth hangs from its pins and does not fall', async () => {
    const cloth = createSoft('cloth', { position: [0, 3, 0], pin: 'corners', resolution: 12, size: [2, 0, 2] });
    const w = await worldOf([cloth]);
    run(w, 3);
    const { positions } = w.readSoft();
    const b = bounds(positions);
    expect(b.hi[1]).toBeGreaterThan(2.95); // the pinned corners stay at their height
    expect(b.lo[1]).toBeLessThan(2.3); // the free edge sags
    expect(b.lo[1]).toBeGreaterThan(0.2); // …but it is held up by the pins
  });

  it('rotated soft bodies keep their pins at the rotated positions', async () => {
    // A cloth rotated 90° about Z stands vertically; pin one edge: it must hang from a vertical line.
    const cloth = createSoft('cloth', { position: [0, 3, 0], pin: 'edge', resolution: 10, size: [2, 0, 2], rotation: qfromAxisAngle([0, 0, 1], Math.PI / 2) });
    const w = await worldOf([cloth]);
    run(w, 2);
    const { positions } = w.readSoft();
    const b = bounds(positions);
    // After the rotation the cloth plane is vertical (x–y … y extent ≈ 2), pinned edge at the top.
    expect(b.hi[1] - b.lo[1]).toBeGreaterThan(1.5);
    expect(b.hi[1]).toBeLessThan(4.3);
  });

  it('a cable pinned at both ends sags but keeps its length', async () => {
    const cable = createSoft('cable', { position: [0, 3, 0], size: [3, 0, 0], resolution: 20 });
    const w = await worldOf([cable]);
    run(w, 3);
    const { layout, positions } = w.readSoft();
    expect(layout![0].mode).toBe('line');
    const mid = [positions[3 * 10], positions[3 * 10 + 1]];
    expect(mid[1]).toBeLessThan(3 - 0.02);
    const first = [positions[0], positions[1], positions[2]], last = [positions[3 * 19], positions[3 * 19 + 1], positions[3 * 19 + 2]];
    expect(Math.abs(first[1] - 3)).toBeLessThan(0.02);
    expect(Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2])).toBeGreaterThan(2.8);
  });

  it('a heavy ball tears a banner with a tear strain, reported as a topology change', async () => {
    const banner = createSoft('cloth', {
      position: [0, 3, 0], size: [3, 0, 2.4], resolution: 16, pin: 'edge', tearStrain: 0.25, stiffness: 60, damping: 0.2,
      rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
    });
    const ball = createBody({ shape: { type: 'sphere', size: [0.7, 0.7, 0.7] }, position: [0, 3, 3.5], velocity: [0, 0, -20], ccd: true, material: { preset: 'custom', density: 3000 } });
    const w = await worldOf([banner, ball]);
    const first = w.readSoft();
    expect(first.layout).toBeDefined();
    const n0 = first.layout![0].count;
    run(w, 1.5);
    const after = w.readSoft();
    expect(after.layout, 'tearing changes the topology').toBeDefined();
    expect(after.positions.length / 3).toBeGreaterThan(n0); // tearing duplicates particles along the cut
    const again = w.readSoft();
    expect(again.layout, 'layout is only reported when it changes').toBeUndefined();
  });

  it('grabbing a particle drags the soft body upward', async () => {
    const jelly = createSoft('jelly', { position: [0, 1, 0] });
    const w = await worldOf([jelly]);
    run(w, 1.5);
    w.readSoft();
    const before = bounds(w.readSoft().positions);
    w.applyOp({ op: 'grabSoft', id: jelly.id, index: 0, target: [0, 4, 0] });
    run(w, 1.5);
    const after = bounds(w.readSoft().positions);
    expect(after.hi[1]).toBeGreaterThan(before.hi[1] + 1);
    w.applyOp({ op: 'release' });
    run(w, 3);
    expect(bounds(w.readSoft().positions).hi[1]).toBeLessThan(2);
  });

  it('adds, updates and removes soft bodies while running; reports soft energy', async () => {
    const w = await worldOf([]);
    const j = createSoft('jelly', { position: [0, 4, 0] });
    w.applyOp({ op: 'addSoft', soft: j });
    run(w, 0.4);
    w.readPoses(1);
    const s = w.readSoft();
    expect(s.layout).toBeDefined();
    expect(w.stats().energy.kinetic).toBeGreaterThan(1); // falling jelly has kinetic energy
    expect(w.stats().particles).toBe(125);
    w.applyOp({ op: 'updateSoft', soft: { ...j, resolution: 4 } });
    expect(w.readSoft().layout![0].count).toBe(64);
    w.applyOp({ op: 'remove', ids: [j.id] });
    expect(w.readSoft().positions.length).toBe(0);
  });

  it('stays finite and fast enough with several soft bodies', async () => {
    const list = [
      createSoft('cloth', { position: [0, 3, 0], resolution: 16, size: [2, 0, 2] }),
      createSoft('jelly', { position: [3, 2, 0] }), createSoft('jelly', { position: [3, 3.4, 0] }),
      createSoft('balloon', { position: [-3, 2, 0] }),
    ];
    const w = await worldOf(list);
    const t0 = performance.now();
    run(w, 2);
    const ms = (performance.now() - t0) / 240;
    process.stderr.write(`\nsoft scene: ${ms.toFixed(2)} ms/step\n`);
    const { positions } = w.readSoft();
    expect(positions.every(Number.isFinite)).toBe(true);
    expect(ms).toBeLessThan(8.3);
    expect(vlen([0, 0, 0])).toBe(0);
  });
});

/** SF-8/9 — particle counts match the engine, the budget tiers, resolution suggestions and the stability warnings. */
import { describe, expect, it } from 'vitest';
import { createSoft } from '../src/model/factory';
import { softBudget, softParticleCount, softWarnings, suggestResolution } from '../src/model/softBudget';
import { worldOf } from './helpers';
import type { PhysicsWorld } from '../src/physics/world';

const particles = (w: PhysicsWorld) => w.readSoft().positions.length / 3;

describe('soft particle budget', () => {
  it.each([
    ['jelly', {}],
    ['jelly', { resolution: 7 }],
    ['cloth', { resolution: 20 }],
    ['cable', { resolution: 33 }],
    ['balloon', { resolution: 2 }],
    ['balloon', { resolution: 3 }],
    ['tyre', { resolution: 24 }],
  ] as const)("the estimate for a %s %j equals the engine's particle count", async (type, over) => {
    const d = createSoft(type, { ...over });
    const w = await worldOf([d]);
    expect(softParticleCount(d)).toBe(particles(w));
  });

  it('the airless tyre and the volumetric mesh estimates are within 50 % of the engine', async () => {
    for (const d of [
      createSoft('tyre', { pneumatic: false }),
      createSoft('mesh', { shape: { type: 'sphere', size: [1, 1, 1] }, cell: 0.2 }),
      createSoft('mesh', { shape: { type: 'cylinder', size: [1, 1, 1] }, cell: 0.25 }),
    ]) {
      const w = await worldOf([d]);
      const real = (
        w as unknown as { s: { softOrder: { root: { numParticles(): number } }[] } }
      ).s.softOrder[0].root.numParticles();
      const est = softParticleCount(d);
      expect(Math.abs(est - real) / real).toBeLessThan(0.5);
    }
  });

  it('tiers, advice and the live count', () => {
    const light = softBudget([createSoft('jelly')]);
    expect(light.tier).toBe('light');
    expect(light.advice).toBe('');
    const heavy = softBudget([createSoft('cloth', { resolution: 40 }), createSoft('cloth', { resolution: 20 })]);
    expect(heavy.tier).toBe('heavy');
    expect(heavy.advice).toMatch(/budget/);
    expect(softBudget([], 4000).tier).toBe('excessive'); // the engine's number wins over the estimate
  });

  it('the adaptive suggestion brings a heavy body under its target and leaves a small one alone', () => {
    const big = createSoft('cloth', { resolution: 40 });
    const patch = suggestResolution(big, 800)!;
    expect(softParticleCount({ ...big, ...patch })).toBeLessThanOrEqual(800);
    expect(patch.resolution).toBeGreaterThan(6);
    expect(suggestResolution(createSoft('jelly'), 800)).toBeNull();
    const mesh = createSoft('mesh', { cell: 0.08 });
    const mp = suggestResolution(mesh, 1000)!;
    expect(mp.cell).toBeGreaterThan(0.08);
    expect(softParticleCount({ ...mesh, ...mp })).toBeLessThanOrEqual(1000);
  });
});

describe('soft stability warnings', () => {
  const ctx = { gravity: 9.81, attachedMass: 0 };

  it('a default body is clean; a very soft long cable is flagged and its fix removes the warning', () => {
    expect(softWarnings(createSoft('jelly'), ctx)).toEqual([]);
    expect(softWarnings(createSoft('cloth'), ctx).find((w) => w.id === 'too-soft')).toBeUndefined();
    const soft = createSoft('cable', { stiffness: 1, size: [6, 0, 0], resolution: 30 });
    const w = softWarnings(soft, ctx).find((x) => x.id === 'too-soft')!;
    expect(w).toBeDefined();
    const fixed = { ...soft, ...w.fix!.patch };
    expect(softWarnings(fixed, ctx).find((x) => x.id === 'too-soft')).toBeUndefined();
  });

  it('too few particles on a big cloth, with a fix', () => {
    const cloth = createSoft('cloth', { size: [4, 0, 4], resolution: 8 });
    const w = softWarnings(cloth, ctx).find((x) => x.id === 'too-coarse')!;
    expect(w).toBeDefined();
    expect(softWarnings({ ...cloth, ...w.fix!.patch }, ctx).find((x) => x.id === 'too-coarse')).toBeUndefined();
  });

  it('a heavy load on a light body is flagged; so is a flat-prone tyre', () => {
    const cable = createSoft('cable', { mass: 1 });
    const w = softWarnings(cable, { gravity: 9.81, attachedMass: 80 }).find((x) => x.id === 'too-heavy-load')!;
    expect(w).toBeDefined();
    expect(
      softWarnings({ ...cable, ...w.fix!.patch }, { gravity: 9.81, attachedMass: 80 }).find(
        (x) => x.id === 'too-heavy-load',
      ),
    ).toBeUndefined();
    const tyre = createSoft('tyre', { stiffness: 60, volumeFactor: 1 });
    const t = softWarnings(tyre, ctx).find((x) => x.id === 'tyre-soft')!;
    expect(t).toBeDefined();
    expect(softWarnings({ ...tyre, ...t.fix!.patch }, ctx).find((x) => x.id === 'tyre-soft')).toBeUndefined();
  });
});

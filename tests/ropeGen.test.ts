/** SF-3 — rope / chain generator: sagging, carrying a heavy body, the mass-ratio guard. */
import { describe, expect, it } from 'vitest';
import { qrot, vdist } from '../src/core/math';
import { createBody } from '../src/model/factory';
import { generateChain, MAX_MASS_RATIO, massGuard } from '../src/model/ropeGen';
import { worldOf } from './helpers';
import type { PhysicsWorld } from '../src/physics/world';
import type { WorldState } from '../src/physics/world/state';

const run = (w: PhysicsWorld, s: number) => {
  for (let i = 0; i < Math.round(s * w.settings.physicsHz); i++) w.stepOnce();
};
const priv = (w: PhysicsWorld) => (w as unknown as { s: WorldState }).s;

describe('SF-3 rope and chain generator', () => {
  it('produces N links joined by N−1 joints plus the end fastening', () => {
    const r = generateChain({ kind: 'rope', start: [0, 5, 0], end: [4, 5, 0], links: 12 });
    expect(r.bodies.length).toBe(12);
    expect(r.joints.length).toBe(12); // 11 between links + start pin
    expect(r.joints.every((j) => j.type === 'ball')).toBe(true);
    const c = generateChain({
      kind: 'chain',
      start: [0, 5, 0],
      end: [0, 3, 0],
      links: 8,
      startBody: 'a',
      endBody: 'b',
    });
    expect(c.joints.filter((j) => j.type === 'conetwist').length).toBe(7);
    expect(c.joints.length).toBe(9);
  });

  it('a rope pinned at both ends sags below the chord and keeps its length', async () => {
    const r = generateChain({
      kind: 'rope',
      start: [-2, 4, 0],
      end: [2, 4, 0],
      links: 16,
      sag: 0.4,
      mass: 4,
      endBody: null,
    });
    const w = await worldOf([...r.bodies, ...r.joints], {});
    run(w, 3);
    const s = priv(w);
    const ys = r.bodies.map((b) => s.bodies.get(b.id)!.rb.translation().y);
    expect(Math.min(...ys)).toBeLessThan(3.9); // sags
    expect(Math.min(...ys)).toBeGreaterThan(2.5); // …but is held up
    const ends = [r.bodies[0], r.bodies[r.bodies.length - 1]].map((b) => s.bodies.get(b.id)!.rb.translation());
    expect(vdist([ends[0].x, ends[0].y, ends[0].z], [ends[1].x, ends[1].y, ends[1].z])).toBeLessThan(4.3);
  });

  it.each(['rope', 'chain'] as const)(
    'a %s from a static hook carries a 40 kg weight without stretching or jitter',
    async (kind) => {
      const hook = createBody({
        shape: { type: 'box', size: [0.3, 0.3, 0.3] },
        position: [0, 6, 0],
        bodyType: 'static',
      });
      const weight = createBody({
        shape: { type: 'box', size: [0.6, 0.6, 0.6] },
        position: [0, 3.0, 0],
        material: { preset: 'custom', density: 40 / 0.216 },
      });
      const r = generateChain({
        kind,
        start: [0, 5.85, 0],
        end: [0, 3.3, 0],
        links: 12,
        startBody: hook.id,
        startAnchor: [0, -0.15, 0],
        endBody: weight.id,
        endAnchor: [0, 0.3, 0],
        load: 40,
        mass: 1,
      });
      expect(r.guarded).toBe(true); // 40 kg on 12 × 0.083 kg links is far past the ratio limit
      expect(massGuard(r.linkMass, 40)).toBeLessThanOrEqual(MAX_MASS_RATIO + 1e-9);
      const w = await worldOf([hook, weight, ...r.bodies, ...r.joints], {});
      run(w, 4);
      const s = priv(w);
      const wb = s.bodies.get(weight.id)!.rb;
      const lv = wb.linvel();
      expect(Math.hypot(lv.x, lv.y, lv.z)).toBeLessThan(0.4);
      // 2.55 m of line below the hook's underside (5.85) + half the weight (0.3) ⇒ centre near 3.0; stretch ≤ 15 %
      expect(wb.translation().y).toBeGreaterThan(5.85 - 2.55 * 1.15 - 0.3);
      expect(wb.translation().y).toBeLessThan(3.3);
    },
  );

  it('end joints coincide with the requested points at build time (no initial snap)', () => {
    const r = generateChain({ kind: 'rope', start: [0, 5, 0], end: [3, 5, 0], links: 6, endBody: null });
    const world = (link: (typeof r.bodies)[number], local: [number, number, number]) => {
      const q = qrot(link.rotation, local);
      return [link.position[0] + q[0], link.position[1] + q[1], link.position[2] + q[2]];
    };
    const start = r.joints[r.joints.length - 2];
    const end = r.joints[r.joints.length - 1];
    const a = world(r.bodies[0], start.anchorB);
    const b = world(r.bodies[5], end.anchorB);
    expect(vdist(a as [number, number, number], [0, 5, 0])).toBeLessThan(1e-6);
    expect(vdist(b as [number, number, number], [3, 5, 0])).toBeLessThan(1e-6);
  });

  it('the mass guard leaves a light load alone', () => {
    const r = generateChain({ kind: 'rope', start: [0, 3, 0], end: [0, 1, 0], links: 10, load: 0.5, mass: 2 });
    expect(r.guarded).toBe(false);
    expect(r.linkMass).toBeCloseTo(0.2, 6);
  });
});

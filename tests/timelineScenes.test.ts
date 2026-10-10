/**
 * Time travel must be exact for every bundled example scene: whatever state a package added (component state,
 * soft-body attachments, joint fatigue, race clocks …) has to be in the snapshot, or a rewind / scrub / replay of that
 * scene would not reproduce the run. A scene that fails here names the package that forgot its `saveState`.
 */
import { describe, expect, it } from 'vitest';
import { listTemplates } from '../src/model/content';
import { PhysicsWorld } from '../src/physics/world';
import { stateHash } from '../src/physics/world/hash';
import { seekTo } from '../src/physics/world/travel';

/**
 * Soft bodies come back from a snapshot a hair off (the engine's soft-body contact and attachment caches are not part
 * of its serialisation): these scenes must stay within a few millimetres of the original run instead of being
 * bit-identical. Listed in docs/LIMITATIONS.md; a scene that needs this exception for any other reason is a bug.
 */
const APPROXIMATE = new Set(['Jelly playground', 'Cloth drape & hammock', 'Net between posts']);

describe('every example scene rewinds exactly', () => {
  for (const t of listTemplates()) {
    it(`${t.name}: seeking back and forward reproduces the state hash`, async () => {
      const w = await PhysicsWorld.create(t.build());
      w.recorder.adaptive = false;
      w.recorder.interval = 13;
      const steps = 160;
      const at: string[] = [];
      const pos: { rigid: number[]; soft: number[] }[] = [];
      const parts = () => ({
        rigid: w.state.order.flatMap((r) => {
          const p = r.rb.translation();
          return [p.x, p.y, p.z];
        }),
        soft: w.state.world.softBodies.getAll().flatMap((sb) => Array.from(sb.particlePositions())),
      });
      for (let i = 0; i < steps; i++) {
        w.stepOnce();
        at[w.stepCount] = stateHash(w.state);
        pos[w.stepCount] = parts();
      }
      for (const target of [140, 97, 41, 150]) {
        seekTo(w.state, target);
        expect(w.stepCount).toBe(target);
        if (!APPROXIMATE.has(t.name)) expect(stateHash(w.state), `${t.name} at step ${target}`).toBe(at[target]);
        else {
          const now = parts();
          const worst = (a: number[], b: number[]) => Math.max(0, ...a.map((v, i) => Math.abs(v - b[i])));
          expect(worst(now.rigid, pos[target].rigid), `${t.name} rigid at ${target}`).toBeLessThan(1e-3);
          expect(worst(now.soft, pos[target].soft), `${t.name} soft at ${target}`).toBeLessThan(0.05);
        }
      }
      w.dispose();
    });
  }
});

describe('every example scene is deterministic (two fresh runs, hashes compared every 20 steps)', () => {
  for (const t of listTemplates()) {
    it(`${t.name}`, async () => {
      const doc = t.build();
      const hashes = async () => {
        const w = await PhysicsWorld.create(doc);
        w.recorder.enabled = false;
        const out: string[] = [];
        for (let i = 1; i <= 200; i++) {
          w.stepOnce();
          if (i % 20 === 0) out.push(stateHash(w.state));
        }
        w.dispose();
        return out;
      };
      const a = await hashes();
      const b = await hashes();
      const first = a.findIndex((h, i) => h !== b[i]);
      expect(first, `first divergence at step ${(first + 1) * 20}`).toBe(-1);
    });
  }
});

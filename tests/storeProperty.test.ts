/**
 * A property test for the scene store with every entity kind: random sequences of add / remove / group / transform /
 * duplicate / joint / component edits. After every step the hierarchy must be valid (parents exist and never loop,
 * joints only name bodies); afterwards undo must walk back through exactly the recorded states and redo forward again.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, type Quat, type Vec3 } from '../src/core/math';
import { makeComponent } from '../src/model/componentRegistry';
import { createBody, createGroup, createJoint, createLight, createPath } from '../src/model/factory';
import { SceneStore } from '../src/model/store';
import type { Entity } from '../src/model/types';

const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

describe('scene store under random operations', () => {
  it('keeps a valid hierarchy, and undo / redo retrace exactly the states that were recorded', () => {
    let totalSteps = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = lcg(seed);
      const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(r() * xs.length)];
      const s = new SceneStore();
      const depth = () => (s as unknown as { past: unknown[] }).past.length;
      const snapshot = () => JSON.stringify(s.all());
      const states: string[] = [snapshot()];

      const parentOf = (id: string): string | undefined => {
        const e = s.get(id);
        return e && e.kind !== 'joint' ? e.parent : undefined;
      };
      const check = (label: string) => {
        for (const e of s.all()) {
          if (e.kind === 'joint') {
            for (const b of [e.bodyA, e.bodyB]) if (b !== null) expect(s.body(b), `${label}: joint body`).toBeDefined();
            continue;
          }
          if (e.parent === undefined) continue;
          expect(s.has(e.parent), `${label}: parent of ${e.name} exists (seed ${seed})`).toBe(true);
          const seen = new Set([e.id]);
          for (let c: string | undefined = e.parent; c !== undefined; c = parentOf(c)) {
            expect(seen.has(c), `${label}: no loop (seed ${seed})`).toBe(false);
            seen.add(c);
          }
        }
      };

      for (let i = 0; i < 60; i++) {
        const all = s.all();
        const objects = all.filter((x) => x.kind !== 'joint');
        const op = Math.floor(r() * 10);
        const before = depth();
        if (op <= 2) {
          const kind = pick(['body', 'body', 'group', 'light', 'path'] as const);
          const e: Entity =
            kind === 'group'
              ? createGroup({ position: [r() * 10, 0, r() * 10] })
              : kind === 'light'
                ? createLight('point')
                : kind === 'path'
                  ? createPath()
                  : createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [r() * 10, 1, r() * 10] });
          s.add([e]);
        } else if (op === 3) {
          const e = pick(objects);
          if (e) s.remove([e.id]);
        } else if (op === 4) {
          const g = pick(s.groups());
          const q: Quat = qfromAxisAngle([r() - 0.5, r() - 0.5, r() - 0.5], r() * 6);
          if (g) s.transformGroup(g.id, { position: [r() * 8, r() * 3, r() * 8] as Vec3, rotation: q });
        } else if (op === 5) {
          // what Editor.setParent does: only groups, never into the entity's own subtree
          const g = pick(s.groups());
          const m = pick(objects);
          if (g && m && m.id !== g.id && !s.descendants(m.id).some((d) => d.id === g.id))
            s.update(m.id, { parent: g.id });
        } else if (op === 6) {
          const ids = objects.slice(0, 1 + Math.floor(r() * 4)).map((x) => x.id);
          if (ids.length) s.duplicate(ids);
        } else if (op === 7) {
          const a = pick(s.bodies());
          const b = pick(s.bodies());
          if (a && b && a.id !== b.id)
            s.add([createJoint({ type: 'ball', bodyA: a.id, bodyB: b.id, anchorA: [0, 0, 0] })]);
        } else if (op === 8) {
          const b = pick(s.bodies());
          if (b) s.update(b.id, { components: [...b.components, makeComponent('constantForce')] });
        } else {
          const e = pick(objects);
          if (e) s.update(e.id, { name: `n${i}` });
        }
        check(`op ${op}`);
        if (depth() !== before) states.push(snapshot());
      }
      totalSteps += states.length - 1;

      for (let k = states.length - 1; k > 0; k--) {
        expect(snapshot(), `seed ${seed}: state before undo ${k}`).toBe(states[k]);
        expect(s.undo()).not.toBeNull();
        check('undo');
      }
      expect(snapshot(), `seed ${seed}: back at the start`).toBe(states[0]);
      for (let k = 1; k < states.length; k++) {
        expect(s.redo()).not.toBeNull();
        expect(snapshot(), `seed ${seed}: redo ${k}`).toBe(states[k]);
        check('redo');
      }
    }
    expect(totalSteps).toBeGreaterThan(800);
  });
});

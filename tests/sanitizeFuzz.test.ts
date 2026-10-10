/**
 * Fuzzing the scene sanitiser (the single entry for files, autosave and share links): thousands of randomly damaged
 * versions of a document holding every entity kind and component type must load without throwing (a format error is
 * the one allowed refusal), re-sanitise to themselves, and satisfy the structural invariants the rest of the app relies
 * on — unique entity and component ids, parent links that exist and never loop, joints that only name bodies.
 */
import { describe, expect, it } from 'vitest';
import { makeComponent } from '../src/model/componentRegistry';
import {
  createBody,
  createGroup,
  createJoint,
  createLight,
  createPath,
  createSoft,
  newDocument,
} from '../src/model/factory';
import { sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { SceneFormatError } from '../src/model/errors';

const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

function richDoc() {
  const d = newDocument('fuzz');
  const g = createGroup({ name: 'G' });
  const g2 = createGroup({ name: 'G2', parent: g.id });
  const a = {
    ...createBody({ shape: { type: 'box', size: [1, 1, 1] }, parent: g2.id }),
    components: [makeComponent('constantForce', { force: [1, 2, 3] })],
  };
  const b = {
    ...createBody({ shape: { type: 'sphere', size: [1, 1, 1] }, bodyType: 'kinematic', position: [3, 0, 0] }),
    components: [makeComponent('sineMover')],
  };
  const j = {
    ...createJoint({ type: 'hinge', bodyA: a.id, bodyB: b.id, anchorA: [0, 0, 0] }),
    components: [makeComponent('constantForce')],
  };
  d.entities = [
    g,
    g2,
    a,
    b,
    j,
    createLight('spot', { parent: g.id }),
    createLight('area'),
    createPath({ parent: g.id }),
    createSoft('jelly'),
  ];
  return JSON.parse(serializeDocument(d)) as Record<string, unknown>;
}

const JUNK: unknown[] = [
  null,
  undefined,
  NaN,
  Infinity,
  -Infinity,
  1e308,
  -1e308,
  0,
  -1,
  1.5,
  '',
  'x',
  '#zzz',
  'constantForce',
  true,
  false,
  [],
  [1],
  [1, 2, 3],
  {},
  { a: 1 },
  'a'.repeat(5000),
  [[1, 2], [3]],
  '__proto__',
  'g_1',
];

function mutate(node: unknown, r: () => number, depth = 0): unknown {
  if (Array.isArray(node)) {
    const out = node.map((x) => (r() < 0.12 ? JUNK[Math.floor(r() * JUNK.length)] : mutate(x, r, depth + 1)));
    if (r() < 0.05) out.push(JUNK[Math.floor(r() * JUNK.length)]);
    if (r() < 0.03) out.splice(Math.floor(r() * (out.length + 1)), 1);
    return out;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const x = r();
      if (x < 0.04) continue; // drop the key
      out[k] = x < 0.14 ? JUNK[Math.floor(r() * JUNK.length)] : mutate(v, r, depth + 1);
    }
    if (r() < 0.05) out['__proto__'] = { polluted: true };
    if (r() < 0.05) out['parent'] = JUNK[Math.floor(r() * JUNK.length)];
    return out;
  }
  return node;
}

describe('sanitiser fuzz', () => {
  it('mutated documents load, re-sanitise to themselves and keep the structural invariants', () => {
    const base = richDoc();
    let ok = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const r = lcg(seed);
      const m = mutate(base, r) as Record<string, unknown>;
      let doc;
      try {
        doc = sanitizeDocument(structuredClone(m));
      } catch (e) {
        expect(e, `seed ${seed}`).toBeInstanceOf(SceneFormatError);
        continue;
      }
      ok++;
      const text = serializeDocument(doc);
      const again = sanitizeDocument(JSON.parse(text));
      const round = (d: unknown) =>
        JSON.stringify(d, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v));
      expect(round(again), `idempotent, seed ${seed}`).toBe(round(doc));
      // invariants
      const ids = new Set<string>();
      const comps = new Set<string>();
      for (const e of doc.entities) {
        expect(ids.has(e.id), `unique id, seed ${seed}`).toBe(false);
        ids.add(e.id);
        if (e.kind === 'body' || e.kind === 'joint')
          for (const c of e.components) {
            expect(comps.has(c.id), `unique component id, seed ${seed}`).toBe(false);
            comps.add(c.id);
          }
      }
      for (const e of doc.entities) {
        if (e.kind !== 'joint' && e.parent !== undefined) {
          expect(ids.has(e.parent), `parent exists, seed ${seed}`).toBe(true);
          let cur: string | undefined = e.parent;
          const seen = new Set<string>([e.id]);
          while (cur !== undefined) {
            expect(seen.has(cur), `no loop, seed ${seed}`).toBe(false);
            seen.add(cur);
            const up = doc.entities.find((x) => x.id === cur);
            cur = up && up.kind !== 'joint' ? up.parent : undefined;
          }
        }
        if (e.kind === 'joint') {
          for (const b of [e.bodyA, e.bodyB])
            if (b !== null)
              expect(
                doc.entities.some((x) => x.id === b && x.kind === 'body'),
                `joint body exists, seed ${seed}`,
              ).toBe(true);
        }
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
    expect(ok).toBeGreaterThan(1500);
  });
});

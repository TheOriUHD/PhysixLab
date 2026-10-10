/**
 * ED-A review fixes: scaled joints, array scale overflow, weld at scale, entity budget, prefab placement velocity,
 * clipboard live poses, locked members in group scale, nesting DAG cost, regex guard, compound adapter safety.
 */
import { describe, expect, it, vi } from 'vitest';
import { qfromAxisAngle, qrot, vadd, type Vec3 } from '../src/core/math';
import { copyToClipboard, resetClipboardMemory } from '../src/app/edit/clipboard';
import { mergeCommand, mergeGroupIntoCompound } from '../src/app/edit/compoundAdapter';
import { Symmetry } from '../src/app/edit/symmetry';
import { registerCommand, unregisterCommand } from '../src/app/registry';
import type { App } from '../src/app/app';
import { arrayProblem, linearPlacements } from '../src/model/edit/arrays';
import { MAX_ARRAY_SCALE, sanitizeArraySpec, type LinearSpec } from '../src/model/edit/arraySpec';
import { budgetMessage, fitsEntityBudget } from '../src/model/edit/entityBudget';
import { scaleGroupPatches } from '../src/model/edit/groupScale';
import { scaleAboutIsApproximate, scaleAboutPatches } from '../src/model/edit/pivot';
import { filterEntities, filterIsValid, MAX_FILTER_PATTERN } from '../src/model/edit/selection';
import { nestingProblem, placeEntities, type StoredPrefab } from '../src/model/edit/userPrefab';
import { weldEdges } from '../src/model/edit/weld';
import { createBody, createGroup, createJoint } from '../src/model/factory';
import { LIMITS } from '../src/model/limits';
import { SceneStore } from '../src/model/store';
import type { BodyEntity, Entity, JointEntity } from '../src/model/types';

const box = (name: string, position: Vec3, over: Partial<BodyEntity> = {}) =>
  createBody({ name, shape: { type: 'box', size: [1, 1, 1] }, position, ...over });

function applied(entities: Entity[], patches: [string, Partial<Entity>][]): Map<string, Entity> {
  const m = new Map(entities.map((e) => [e.id, e]));
  for (const [id, p] of patches) m.set(id, { ...m.get(id)!, ...p } as Entity);
  return m;
}

const worldAnchor = (b: BodyEntity, a: Vec3): Vec3 => vadd(b.position, qrot(b.rotation, a));

describe('1: scaling bodies about a pivot keeps body-body joints satisfied', () => {
  it('a hinge between two boxes 2 m apart, scaled x2 about their centre, keeps coincident world anchors', () => {
    const a = box('A', [-1, 0.5, 0], { massOverride: 3, comOverride: [0.1, 0, 0] });
    const b = box('B', [1, 0.5, 0]);
    const j = createJoint({
      type: 'hinge',
      bodyA: a.id,
      bodyB: b.id,
      anchorA: [1, 0, 0],
      anchorB: [-1, 0, 0],
      axis: [0, 1, 0],
    });
    const all: Entity[] = [a, b, j];
    expect(worldAnchor(a, [1, 0, 0])).toEqual(worldAnchor(b, [-1, 0, 0]));
    const patches = scaleAboutPatches(all, [a.id, b.id], {
      factor: [2, 2, 2],
      pivot: { mode: 'centre', cursor: [0, 0, 0] },
    });
    const out = applied(all, patches);
    const A = out.get(a.id) as BodyEntity;
    const B = out.get(b.id) as BodyEntity;
    const J = out.get(j.id) as JointEntity;
    expect(A.shape.size).toEqual([2, 2, 2]);
    const wa = worldAnchor(A, J.anchorA);
    const wb = worldAnchor(B, J.anchorB);
    for (let i = 0; i < 3; i++) expect(wa[i]).toBeCloseTo(wb[i], 9);
    expect(J.anchorA).toEqual([2, 0, 0]);
    // mass override follows the volume (x8), the centre-of-mass override follows the size
    expect(A.massOverride).toBeCloseTo(24, 9);
    expect(A.comOverride).toEqual([0.2, 0, 0]);
  });

  it('a non-uniform world factor on a body turned 90 degrees stretches the matching own axis; off-axis turns are approximate', () => {
    const q = qfromAxisAngle([0, 1, 0], Math.PI / 2);
    const a = box('A', [0, 0.5, 0], { rotation: q });
    const patches = scaleAboutPatches([a], [a.id], {
      factor: [3, 1, 1],
      pivot: { mode: 'origins', cursor: [0, 0, 0] },
    });
    const A = applied([a], patches).get(a.id) as BodyEntity;
    // world x is the body's own z axis after the turn
    expect(A.shape.size[0]).toBeCloseTo(1, 9);
    expect(A.shape.size[2]).toBeCloseTo(3, 9);
    expect(scaleAboutIsApproximate([a], [a.id], [3, 1, 1])).toBe(false);
    const tilted = box('T', [0, 0.5, 0], { rotation: qfromAxisAngle([0, 0, 1], 0.6) });
    expect(scaleAboutIsApproximate([tilted], [tilted.id], [3, 1, 1])).toBe(true);
    expect(scaleAboutIsApproximate([tilted], [tilted.id], [2, 2, 2])).toBe(false);
  });
});

describe('2: arrays cannot overflow into non-finite poses', () => {
  it('stepScale 20 x count 2000 and stepScale 2 x count 1100 are rejected with a message', () => {
    const src = box('S', [0, 0.5, 0]);
    for (const [stepScale, count] of [
      [20, 2000],
      [2, 1100],
    ]) {
      const spec: LinearSpec = { kind: 'linear', count, offset: [1, 0, 0], stepRotation: [0, 0, 0], stepScale };
      expect(arrayProblem([src], [src.id], spec)).toMatch(/times the original size/);
    }
    // raw (unsanitised) placements really would overflow
    const raw = linearPlacements(
      { kind: 'linear', count: 2000, offset: [1, 0, 0], stepRotation: [0, 0, 0], stepScale: 20 },
      [0, 0, 0],
    );
    expect(Number.isFinite(raw[raw.length - 1].scale)).toBe(false);
  });

  it('the sanitiser clamps a stored spec so the last copy stays within the allowed growth', () => {
    for (const [stepScale, count] of [
      [20, 2000],
      [2, 1100],
      [0.05, 2000],
    ]) {
      const s = sanitizeArraySpec({ kind: 'linear', count, offset: [1, 0, 0], stepScale }) as LinearSpec;
      const last = Math.pow(s.stepScale, s.count - 1);
      expect(Number.isFinite(last)).toBe(true);
      expect(last).toBeLessThanOrEqual(MAX_ARRAY_SCALE * (1 + 1e-9));
      expect(last).toBeGreaterThanOrEqual((1 / MAX_ARRAY_SCALE) * (1 - 1e-9));
      const src = box('S', [0, 0.5, 0]);
      expect(arrayProblem([src], [src.id], s)).toBeNull();
      for (const p of linearPlacements(s, [0, 0, 0])) expect(Number.isFinite(p.scale)).toBe(true);
    }
    // a sane spec is untouched
    expect((sanitizeArraySpec({ kind: 'linear', count: 5, stepScale: 1.1 }) as LinearSpec).stepScale).toBe(1.1);
  });
});

describe('3: weld spanning tree scales', () => {
  const isSpanning = (n: number, edges: [number, number][]): boolean => {
    const p = Array.from({ length: n }, (_, i) => i);
    const f = (i: number): number => (p[i] === i ? i : (p[i] = f(p[i])));
    for (const [a, b] of edges) p[f(a)] = f(b);
    return new Set(p.map((_, i) => f(i))).size === 1;
  };

  it('3000 bodies in a lattice give n-1 edges, connected, in well under a second', () => {
    const bodies = Array.from({ length: 3000 }, (_, i) => ({
      id: `b${i}`,
      position: [(i % 15) * 1.1, Math.floor(i / 225) * 1.1, (Math.floor(i / 15) % 15) * 1.1] as Vec3,
      bodyType: 'dynamic' as const,
    }));
    const t = performance.now();
    const edges = weldEdges(bodies);
    const ms = performance.now() - t;
    expect(edges.length).toBe(2999);
    expect(isSpanning(3000, edges)).toBe(true);
    expect(ms).toBeLessThan(1000);
  });

  it('far-apart clusters are still joined (closest-pair fallback) and static-static pairs are never linked', () => {
    const dyn = (id: string, x: number) => ({ id, position: [x, 0, 0] as Vec3, bodyType: 'dynamic' as const });
    const bodies = [
      ...Array.from({ length: 40 }, (_, i) => dyn(`a${i}`, i * 0.1)),
      ...Array.from({ length: 40 }, (_, i) => dyn(`c${i}`, 500 + i * 0.1)),
      { id: 's1', position: [250, 0, 0] as Vec3, bodyType: 'static' as const },
      { id: 's2', position: [250.1, 0, 0] as Vec3, bodyType: 'static' as const },
    ];
    const edges = weldEdges(bodies);
    expect(edges.length).toBe(bodies.length - 1);
    expect(isSpanning(bodies.length, edges)).toBe(true);
    for (const [a, b] of edges) expect(bodies[a].bodyType === 'static' && bodies[b].bodyType === 'static').toBe(false);
  });
});

describe('4: scene object budget', () => {
  const fake = (n: number) => ({ all: () => ({ length: n }) as unknown as readonly unknown[] });
  it('refuses what does not fit with a clear message', () => {
    expect(budgetMessage(10, 10)).toBeNull();
    expect(fitsEntityBudget(fake(LIMITS.maxEntities - 5), 5)).toBeNull();
    expect(fitsEntityBudget(fake(LIMITS.maxEntities - 5), 6, 'This array')).toMatch(
      /This array would add 6 objects but the scene can take 5 more/,
    );
    expect(fitsEntityBudget(fake(LIMITS.maxEntities + 10), 1)).toMatch(/can take 0 more/);
  });

  it('symmetry stops mirroring adds when the scene is full', () => {
    const store = new SceneStore();
    store.add(
      Array.from({ length: LIMITS.maxEntities - 1 }, (_, i) => box(`f${i}`, [100 + i, 0.5, 0])),
      'fill',
      false,
    );
    const notify = vi.fn();
    const sym = new Symmetry({ store, simActive: () => false, notify });
    sym.axis = 0;
    sym.enabled = true;
    // the original fits (the scene is now full), its partner does not
    store.add([box('new', [3, 0.5, 0])], 'add', false);
    expect(store.all().length).toBe(LIMITS.maxEntities);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/object limit/);
  });
});

describe('5: prefab placement turns body velocities', () => {
  it('rotating a placement by 90 degrees about Y turns velocity and angular velocity', () => {
    const b = box('B', [1, 0, 0], { velocity: [2, 0, 0], angularVelocity: [0, 0, 3] });
    const q = qfromAxisAngle([0, 1, 0], Math.PI / 2);
    const [placed] = placeEntities([b], [10, 0, 0], q) as BodyEntity[];
    const expectV = qrot(q, [2, 0, 0]);
    const expectW = qrot(q, [0, 0, 3]);
    for (let i = 0; i < 3; i++) {
      expect(placed.velocity[i]).toBeCloseTo(expectV[i], 9);
      expect(placed.angularVelocity[i]).toBeCloseTo(expectW[i], 9);
    }
    expect(placed.velocity[2]).toBeCloseTo(-2, 9);
    const [same] = placeEntities([b], [10, 0, 0], undefined) as BodyEntity[];
    expect(same.velocity).toEqual([2, 0, 0]);
  });
});

describe('6: copying during a simulation uses live poses for connection anchors', () => {
  it('the world anchor of a joint to an uncopied body follows the live pose', () => {
    resetClipboardMemory();
    const store = new SceneStore();
    const a = box('A', [0, 0.5, 0]);
    const b = box('B', [2, 0.5, 0]);
    const j = createJoint({ type: 'fixed', bodyA: a.id, bodyB: b.id, anchorA: [1, 0, 0], anchorB: [-1, 0, 0] });
    store.add([a, b, j], 'setup', false);
    const live = { position: [2, 5.5, 0] as Vec3, rotation: [0, 0, 0, 1] as [number, number, number, number] };
    const res = copyToClipboard({ store, sim: { poseOf: (id) => (id === b.id ? live : null) } }, [a.id]);
    expect(res).not.toBeNull();
    const env = JSON.parse(res!.text) as { entities: Entity[] };
    const joint = env.entities.find((e) => e.kind === 'joint') as JointEntity;
    expect(joint.bodyB).toBeNull();
    expect(joint.anchorB).toEqual([1, 5.5, 0]); // live pose of B + anchorB, not the document pose
    resetClipboardMemory();
  });
});

describe('9: group scale leaves locked members alone', () => {
  it('locked members (and what is inside a locked sub-group) do not move or resize; hidden ones do', () => {
    const g = createGroup({ position: [0, 0, 0] });
    const free = box('free', [2, 0.5, 0], { parent: g.id });
    const locked = box('locked', [0, 0.5, 2], { parent: g.id, locked: true });
    const hidden = box('hidden', [0, 0.5, -2], { parent: g.id, hidden: true });
    const sub = createGroup({ parent: g.id, locked: true });
    const inSub = box('inSub', [4, 0.5, 4], { parent: sub.id });
    const all: Entity[] = [g, free, locked, hidden, sub, inSub];
    const r = scaleGroupPatches(all, g.id, [2, 2, 2]);
    expect(r.skippedLocked).toBe(2);
    const touched = new Set(r.patches.map(([id]) => id));
    expect(touched.has(free.id)).toBe(true);
    expect(touched.has(hidden.id)).toBe(true);
    expect(touched.has(locked.id)).toBe(false);
    expect(touched.has(inSub.id)).toBe(false);
    const out = applied(all, r.patches);
    expect((out.get(free.id) as BodyEntity).shape.size).toEqual([2, 2, 2]);
    expect((out.get(hidden.id) as BodyEntity).shape.size).toEqual([2, 2, 2]);
  });

  it('a joint between a scaled and a locked body does not throw and the locked end keeps its anchor', () => {
    const g = createGroup();
    const a = box('A', [0, 0.5, 0], { parent: g.id });
    const l = box('L', [1, 0.5, 0], { parent: g.id, locked: true });
    const j = createJoint({ type: 'fixed', bodyA: a.id, bodyB: l.id, anchorA: [0.5, 0, 0], anchorB: [-0.5, 0, 0] });
    const r = scaleGroupPatches([g, a, l, j], g.id, [2, 2, 2]);
    const jp = r.patches.find(([id]) => id === j.id)?.[1] as Partial<JointEntity>;
    expect(jp.anchorA).toEqual([1, 0, 0]);
    expect(jp.anchorB).toBeUndefined();
  });
});

describe('11: nestingProblem on a hostile DAG', () => {
  it('walks every prefab once instead of once per path', () => {
    const layers = 5;
    const width = 30;
    const mk = (id: string, next: string[]): StoredPrefab =>
      ({ id, nested: next.map((n) => ({ prefabId: n })) }) as unknown as StoredPrefab;
    const byId = new Map<string, StoredPrefab>();
    for (let l = 0; l < layers; l++)
      for (let i = 0; i < width; i++) {
        const next = l + 1 < layers ? Array.from({ length: width }, (_, k) => `p${l + 1}_${k}`) : [];
        byId.set(`p${l}_${i}`, mk(`p${l}_${i}`, next));
      }
    byId.set('top', mk('top', []));
    let calls = 0;
    const lookup = (id: string) => {
      calls++;
      return byId.get(id);
    };
    expect(nestingProblem(lookup, 'top', 'p0_0')).toBeNull();
    expect(calls).toBeLessThan(layers * width * 3);
    // a real cycle is still found
    byId.set('p4_0', mk('p4_0', ['p0_0']));
    expect(nestingProblem(lookup, 'top', 'p0_0')).toMatch(/contain itself/);
  });
});

describe('12: select-by-name regex guard', () => {
  it('rejects patterns longer than the cap and never matches with them', () => {
    const long = 'a'.repeat(MAX_FILTER_PATTERN + 1);
    expect(filterIsValid({ name: long, regex: true })).toBe(false);
    expect(filterIsValid({ name: 'a'.repeat(MAX_FILTER_PATTERN), regex: true })).toBe(true);
    expect(filterIsValid({ name: long, regex: false })).toBe(true);
    expect(filterEntities([box(long, [0, 0, 0])], { name: long, regex: true })).toEqual([]);
  });
});

describe('15: compound adapter only runs the shapes package command', () => {
  it('ignores a fuzzy-named command; a disabled shapes command leaves the selection alone', () => {
    registerCommand({
      id: 'misc.compoundCleanup',
      label: 'Merge compound leftovers',
      category: 'Edit',
      run: () => undefined,
    });
    try {
      expect(mergeCommand()).toBeUndefined();
    } finally {
      unregisterCommand('misc.compoundCleanup');
    }

    const run = vi.fn();
    registerCommand({
      id: 'shape.mergeIntoCompoundTest',
      label: 'Merge into compound',
      category: 'Edit',
      enabled: () => false,
      run,
    });
    try {
      expect(mergeCommand()?.id).toBe('shape.mergeIntoCompoundTest');
      const store = new SceneStore();
      const g = createGroup();
      const a = box('A', [0, 0.5, 0], { parent: g.id });
      const b = box('B', [1, 0.5, 0], { parent: g.id });
      const other = box('Other', [5, 0.5, 0]);
      store.add([g, a, b, other], 'setup', false);
      store.setSelection([other.id]);
      const ok = mergeGroupIntoCompound({ store } as unknown as App, g.id);
      expect(ok).toBe(false);
      expect(run).not.toHaveBeenCalled();
      expect(store.selection).toEqual([other.id]);
    } finally {
      unregisterCommand('shape.mergeIntoCompoundTest');
    }
  });
});

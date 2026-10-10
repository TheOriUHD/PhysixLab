import { describe, expect, it } from 'vitest';
import { qrot } from '../src/core/math';
import { buildAsset, makeMeshAsset } from '../src/model/assets';
import {
  PACK_FORMAT,
  PREFAB_LIMITS,
  PrefabPackError,
  applyVariables,
  applyVariant,
  capturePrefab,
  exportPack,
  importPack,
  instantiatePrefab,
  nestingProblem,
  rebindVariables,
  reidentifyImported,
  sanitizePrefab,
  yawQuat,
  type StoredPrefab,
} from '../src/model/edit/userPrefab';
import { createBody, createGroup, createJoint } from '../src/model/factory';
import { isBody, isJoint, type BodyEntity, type Entity } from '../src/model/types';

const box = (name: string, pos: [number, number, number], size: [number, number, number] = [1, 1, 1]) =>
  createBody({ name, shape: { type: 'box', size }, position: pos });

const bodiesOf = (list: Entity[]): BodyEntity[] => list.filter(isBody);
const none = () => undefined;

/** Two 1 m boxes at x = 4 and x = 6, floating at y = 3.5 — capture must centre them and drop them to the ground. */
function sample(): { all: Entity[]; ids: string[] } {
  const a = box('A', [4, 3.5, 7]);
  const b = box('B', [6, 3.5, 7]);
  const j = createJoint({ type: 'fixed', bodyA: a.id, bodyB: b.id, anchorA: [0, 0, 0] });
  const other = box('Other', [50, 0.5, 50]);
  return { all: [a, b, j, other], ids: [a.id, b.id] };
}

describe('capturePrefab', () => {
  it('centres the assembly on x/z, puts its lowest point on y = 0 and keeps joints between captured bodies', () => {
    const { all, ids } = sample();
    const p = capturePrefab(all, ids, 'Pair', { tags: ['Test', 'test', ' pair '] })!;
    expect(p.name).toBe('Pair');
    expect(p.tags).toEqual(['Test', 'pair']);
    const bodies = bodiesOf(p.entities);
    expect(bodies).toHaveLength(2);
    // Boxes span x 3.5 .. 6.5 -> centre 5; z centre 7; bottom at 3.
    const xs = bodies.map((b) => b.position[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-1, 9);
    expect(xs[1]).toBeCloseTo(1, 9);
    for (const b of bodies) {
      expect(b.position[1]).toBeCloseTo(0.5, 9);
      expect(b.position[2]).toBeCloseTo(0, 9);
    }
    const joints = p.entities.filter(isJoint);
    expect(joints).toHaveLength(1);
    const ids2 = new Set(bodies.map((b) => b.id));
    expect(ids2.has(joints[0].bodyA!) && ids2.has(joints[0].bodyB!)).toBe(true);
    expect(ids.includes(bodies[0].id)).toBe(false);
  });

  it('returns null for an empty selection and carries group members along', () => {
    const { all } = sample();
    expect(capturePrefab(all, [], 'Nothing')).toBeNull();
    const g = createGroup({ name: 'G', position: [0, 0, 0] });
    const c1 = { ...box('C1', [0, 0.5, 0]), parent: g.id } as BodyEntity;
    const p = capturePrefab([g, c1], [g.id], 'Grouped')!;
    expect(p.entities).toHaveLength(2);
    const grp = p.entities.find((e) => e.kind === 'group')!;
    expect(bodiesOf(p.entities)[0].parent).toBe(grp.id);
  });

  it('copies exactly the assets the captured entities reference', () => {
    const mesh = buildAsset(
      makeMeshAsset('tri', { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }),
      'as_mesh',
    );
    const unused = buildAsset({ kind: 'blob', name: 'x', mime: 'application/octet-stream', data: 'AAAA' }, 'as_unused');
    const a = { ...box('M', [0, 0.5, 0]), meshId: 'as_mesh' } as BodyEntity;
    const p = capturePrefab([a], [a.id], 'WithMesh', { assets: { as_mesh: mesh, as_unused: unused } })!;
    expect(Object.keys(p.assets)).toEqual(['as_mesh']);
    // Two insertions share one asset entry per insertion, and it is re-keyed.
    const r = instantiatePrefab(p, none);
    const ids = Object.keys(r.assets);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe('as_mesh');
    expect(bodiesOf(r.entities)[0].meshId).toBe(ids[0]);
  });
});

describe('instantiatePrefab', () => {
  it('poses at `at` with fresh ids, unique names and a rotation about the anchor', () => {
    const { all, ids } = sample();
    const p = capturePrefab(all, ids, 'Pair')!;
    const r = instantiatePrefab(p, none, { at: [10, 0, 20], takenNames: ['A', 'B'] });
    const bs = bodiesOf(r.entities);
    expect(bs.map((b) => b.name).sort()).toEqual(['A 2', 'B 2']);
    expect(bs.map((b) => b.position[0]).sort((a, b) => a - b)).toEqual([9, 11]);
    expect(bs[0].position[1]).toBeCloseTo(0.5, 9);
    expect(new Set(r.entities.map((e) => e.id)).size).toBe(r.entities.length);
    expect(r.entities.every((e) => !p.entities.some((o) => o.id === e.id))).toBe(true);
    const r2 = instantiatePrefab(p, none, { at: [0, 0, 0] });
    expect(r2.entities.some((e) => r.entities.some((o) => o.id === e.id))).toBe(false);

    // 90 degrees about +Y turns +x into -z.
    const rot = instantiatePrefab(p, none, { at: [0, 0, 0], rotation: yawQuat(90) });
    const zs = bodiesOf(rot.entities).map((b) => b.position[2]);
    expect(Math.min(...zs)).toBeCloseTo(-1, 9);
    expect(Math.max(...zs)).toBeCloseTo(1, 9);
    const fwd = qrot(bodiesOf(rot.entities)[0].rotation, [1, 0, 0]);
    expect(fwd[2]).toBeCloseTo(-1, 9);
  });
});

describe('parametric variables', () => {
  function tower(): StoredPrefab {
    const a = box('Base', [0, 0.5, 0], [2, 1, 2]);
    const b = box('Pillar', [0, 1.5, 0], [1, 1, 1]);
    return capturePrefab([a, b], [a.id, b.id], 'Tower')!;
  }

  it('a number variable bound to size.y gives boxes of exactly that height and keeps their bottoms', () => {
    const p = tower();
    p.variables = [{ name: 'height', kind: 'number', default: 1, min: 0.1, max: 10, bindings: [{ prop: 'size.y' }] }];
    const r = instantiatePrefab(p, none, { variableValues: { height: 3 } });
    for (const b of bodiesOf(r.entities)) expect(b.shape.size[1]).toBe(3);
    const base = bodiesOf(r.entities).find((b) => b.name === 'Base')!;
    const stored = p.entities.find((e) => e.name === 'Base') as BodyEntity;
    expect(base.position[1] - 1.5).toBeCloseTo(stored.position[1] - 0.5, 9); // bottom unchanged
    expect(bodiesOf(p.entities).every((b) => b.shape.size[1] === 1)).toBe(true); // stored prefab untouched
  });

  it('binds to a single body, clamps to min/max and falls back to the default for garbage', () => {
    const p = tower();
    const pillar = p.entities.find((e) => e.name === 'Pillar')!;
    p.variables = [
      { name: 'h', kind: 'number', default: 2, min: 1, max: 4, bindings: [{ prop: 'size.y', entityId: pillar.id }] },
    ];
    const hi = bodiesOf(instantiatePrefab(p, none, { variableValues: { h: 99 } }).entities);
    expect(hi.find((b) => b.name === 'Pillar')!.shape.size[1]).toBe(4);
    expect(hi.find((b) => b.name === 'Base')!.shape.size[1]).toBe(1);
    const bad = bodiesOf(instantiatePrefab(p, none, { variableValues: { h: NaN } }).entities);
    expect(bad.find((b) => b.name === 'Pillar')!.shape.size[1]).toBe(2);
  });

  it('scale scales positions, sizes and joint anchors together', () => {
    const a = box('A', [1, 0.5, 0]);
    const b = box('B', [-1, 0.5, 0]);
    const j = createJoint({ type: 'hinge', bodyA: a.id, bodyB: b.id, anchorA: [0.5, 0, 0] });
    const p = capturePrefab([a, b, j], [a.id, b.id, j.id], 'Hinged')!;
    p.variables = [{ name: 'scale', kind: 'number', default: 1, min: 0.1, max: 10, bindings: [{ prop: 'scale' }] }];
    const r = instantiatePrefab(p, none, { variableValues: { scale: 2 } });
    const bs = bodiesOf(r.entities);
    expect(bs.map((x) => x.shape.size[0])).toEqual([2, 2]);
    expect(Math.max(...bs.map((x) => x.position[0]))).toBeCloseTo(2, 9);
    expect(bs[0].position[1]).toBeCloseTo(1, 9);
    expect(r.entities.find(isJoint)!.anchorA[0]).toBeCloseTo(1, 9);
  });

  it('material and colour variables change every bound body', () => {
    const p = tower();
    p.variables = [
      { name: 'mat', kind: 'material', default: 'steel', bindings: [{ prop: 'material' }] },
      { name: 'tint', kind: 'color', default: '#ff0000', bindings: [{ prop: 'color' }] },
    ];
    const r = instantiatePrefab(p, none, { variableValues: { mat: 'wood', tint: '#00ff00' } });
    for (const b of bodiesOf(r.entities)) {
      expect(b.material.preset).toBe('wood');
      expect(b.material.density).toBeGreaterThan(300);
      expect(b.material.color).toBe('#00ff00');
    }
    const d = bodiesOf(applyVariables(p.entities, p.variables, {}));
    expect(d[0].material.preset).toBe('steel');
    expect(d[0].material.color).toBe('#ff0000');
  });
});

describe('variants', () => {
  it('override material, colour and size', () => {
    const a = box('A', [0, 0.5, 0]);
    const p = capturePrefab([a], [a.id], 'One')!;
    p.variants = [
      { id: 'v1', name: 'Heavy', overrides: { materialPreset: 'steel', sizeScale: 2 } },
      { id: 'v2', name: 'Red', overrides: { color: '#ff0000' } },
    ];
    const heavy = bodiesOf(instantiatePrefab(p, none, { variantId: 'v1' }).entities)[0];
    expect(heavy.material.preset).toBe('steel');
    expect(heavy.shape.size).toEqual([2, 2, 2]);
    expect(heavy.position[1]).toBeCloseTo(1, 9);
    const red = bodiesOf(instantiatePrefab(p, none, { variantId: 'v2' }).entities)[0];
    expect(red.material.color).toBe('#ff0000');
    expect(red.shape.size).toEqual([1, 1, 1]);
    expect(bodiesOf(instantiatePrefab(p, none, { variantId: 'nope' }).entities)[0].shape.size).toEqual([1, 1, 1]);
    expect(applyVariant(p.entities, undefined)).toHaveLength(1);
  });

  it('a variant can preset variable values; explicit values still win', () => {
    const a = box('A', [0, 0.5, 0]);
    const p = capturePrefab([a], [a.id], 'One')!;
    p.variables = [{ name: 'h', kind: 'number', default: 1, min: 0.1, max: 10, bindings: [{ prop: 'size.y' }] }];
    p.variants = [{ id: 'tall', name: 'Tall', overrides: { variableValues: { h: 5 } } }];
    expect(bodiesOf(instantiatePrefab(p, none, { variantId: 'tall' }).entities)[0].shape.size[1]).toBe(5);
    const explicit = instantiatePrefab(p, none, { variantId: 'tall', variableValues: { h: 2 } });
    expect(bodiesOf(explicit.entities)[0].shape.size[1]).toBe(2);
  });
});

describe('nested prefabs', () => {
  const leaf = (): StoredPrefab => {
    const a = box('Leaf', [0, 0.5, 0]);
    return capturePrefab([a], [a.id], 'Leaf', { id: 'leaf' })!;
  };
  const mid = (): StoredPrefab => {
    const a = box('Mid', [0, 0.5, 0]);
    const p = capturePrefab([a], [a.id], 'Mid', { id: 'mid' })!;
    p.nested = [{ id: 'n1', prefabId: 'leaf', position: [3, 0, 0], yaw: 0 }];
    return p;
  };
  const top = (): StoredPrefab => {
    const a = box('Top', [0, 0.5, 0]);
    const p = capturePrefab([a], [a.id], 'Top', { id: 'top' })!;
    p.nested = [{ id: 'n2', prefabId: 'mid', position: [0, 0, 5], yaw: 90 }];
    return p;
  };

  it('expands two levels with composed poses and a variable passed to the child', () => {
    const l = leaf();
    l.variables = [{ name: 'h', kind: 'number', default: 1, min: 0.1, max: 9, bindings: [{ prop: 'size.y' }] }];
    const m = mid();
    m.nested = [{ id: 'n1', prefabId: 'leaf', position: [3, 0, 0], yaw: 0, variableValues: { h: 4 } }];
    const lib = new Map([l, m, top()].map((p) => [p.id, p]));
    const r = instantiatePrefab(lib.get('top')!, (id) => lib.get(id), { at: [100, 0, 0] });
    const bs = bodiesOf(r.entities);
    expect(bs.map((b) => b.name).sort()).toEqual(['Leaf', 'Mid', 'Top']);
    const at = (n: string) => bs.find((b) => b.name === n)!;
    expect(at('Top').position[0]).toBe(100);
    expect(at('Mid').position[2]).toBeCloseTo(5, 9);
    // leaf is 3 m along mid's +x, which yaw 90 turns into -z: z = 5 - 3 = 2.
    expect(at('Leaf').position[0]).toBeCloseTo(100, 9);
    expect(at('Leaf').position[2]).toBeCloseTo(2, 9);
    expect(at('Leaf').shape.size[1]).toBe(4);
  });

  it('rejects cycles when linking and skips them (with a warning) when inserting', () => {
    const l = leaf();
    const t = top();
    const lib = new Map([l, mid(), t].map((p) => [p.id, p]));
    const lookup = (id: string) => lib.get(id);
    expect(nestingProblem(lookup, 'top', 'top')).toMatch(/itself/);
    expect(nestingProblem(lookup, 'leaf', 'top')).toMatch(/itself/); // leaf -> top -> mid -> leaf
    expect(nestingProblem(lookup, 'top', 'leaf')).toBeNull();
    // Corrupt data: leaf points back to top. Insertion terminates and reports it.
    l.nested = [{ id: 'bad', prefabId: 'top', position: [0, 0, 0], yaw: 0 }];
    const r = instantiatePrefab(t, lookup);
    expect(r.warnings.some((w) => /cannot contain themselves/.test(w))).toBe(true);
    expect(
      bodiesOf(r.entities)
        .map((b) => b.name)
        .sort(),
    ).toEqual(['Leaf', 'Mid', 'Top']);
  });

  it('missing nested prefabs warn, and the depth limit holds', () => {
    const r = instantiatePrefab(top(), none);
    expect(r.warnings[0]).toMatch(/no longer exists/);
    expect(bodiesOf(r.entities)).toHaveLength(1);
    const chain: StoredPrefab[] = [];
    const n = PREFAB_LIMITS.maxNestDepth + 3;
    for (let i = 0; i < n; i++) {
      const a = box(`L${i}`, [0, 0.5, 0]);
      const p = capturePrefab([a], [a.id], `L${i}`, { id: `c${i}` })!;
      p.nested = i < n - 1 ? [{ id: 'n', prefabId: `c${i + 1}`, position: [1, 0, 0], yaw: 0 }] : [];
      chain.push(p);
    }
    const lib = new Map(chain.map((p) => [p.id, p]));
    const res = instantiatePrefab(chain[0], (id) => lib.get(id));
    expect(bodiesOf(res.entities)).toHaveLength(PREFAB_LIMITS.maxNestDepth);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('respects the entity budget', () => {
    const lib = new Map([leaf(), mid(), top()].map((p) => [p.id, p]));
    expect(() => instantiatePrefab(lib.get('top')!, (id) => lib.get(id), { maxEntities: 2 })).toThrow(PrefabPackError);
  });
});

describe('rebindVariables', () => {
  it('follows entities by name and kind, drops bindings whose entity is gone', () => {
    const a = box('Seat', [0, 0.5, 0]);
    const b = box('Leg', [1, 0.5, 0]);
    const old = capturePrefab([a, b], [a.id, b.id], 'Chair')!;
    const seatOld = old.entities.find((e) => e.name === 'Seat')!;
    const legOld = old.entities.find((e) => e.name === 'Leg')!;
    const vars = [
      {
        name: 'h',
        kind: 'number' as const,
        default: 1,
        bindings: [
          { prop: 'size.y' as const, entityId: seatOld.id },
          { prop: 'size.y' as const, entityId: legOld.id },
        ],
      },
    ];
    const s2 = box('Seat', [0, 0.5, 0]);
    const t2 = box('Back', [0, 1.5, 0]);
    const next = capturePrefab([s2, t2], [s2.id, t2.id], 'Chair')!;
    const out = rebindVariables(old.entities, next.entities, vars);
    const seatNew = next.entities.find((e) => e.name === 'Seat')!;
    expect(out[0].bindings).toEqual([{ prop: 'size.y', entityId: seatNew.id }]);
    // The rebound variable really drives the new entity.
    const r = instantiatePrefab({ ...next, variables: out }, none, { variableValues: { h: 4 } });
    expect(bodiesOf(r.entities).find((x) => x.name === 'Seat')!.shape.size[1]).toBe(4);
    expect(bodiesOf(r.entities).find((x) => x.name === 'Back')!.shape.size[1]).toBe(1);
  });
});

describe('packs', () => {
  it('round-trips a prefab with variables, variants and nested refs', () => {
    const a = box('A', [0, 0.5, 0]);
    const p = capturePrefab([a], [a.id], 'Round', { tags: ['x'] })!;
    p.variables = [
      {
        name: 'h',
        kind: 'number',
        default: 2,
        min: 1,
        max: 3,
        bindings: [{ prop: 'size.y', entityId: p.entities[0].id }],
      },
    ];
    p.variants = [{ id: 'v', name: 'V', overrides: { materialPreset: 'wood', variableValues: { h: 3 } } }];
    p.nested = [{ id: 'n', prefabId: 'other', position: [1, 0, 2], yaw: 45 }];
    p.thumbnail = 'data:image/png;base64,AAAA';
    const back = importPack(exportPack([p], 2));
    expect(back.warnings).toEqual([]);
    expect(back.prefabs).toHaveLength(1);
    expect(back.prefabs[0]).toEqual(p);
  });

  it('rejects hostile and malformed payloads with clear messages', () => {
    const pack = (o: object) => JSON.stringify({ format: PACK_FORMAT, version: 1, ...o });
    expect(() => importPack('not json')).toThrow(/not valid JSON/);
    expect(() => importPack('[]')).toThrow(/not a PhysicsLab prefab pack/);
    expect(() => importPack(JSON.stringify({ format: 'physicslab-scene' }))).toThrow(/scene file/);
    expect(() => importPack(pack({ version: 99, prefabs: [] }))).toThrow(/newer version/);
    expect(() => importPack(pack({}))).toThrow(/no list of prefabs/);
    expect(() => importPack(pack({ prefabs: new Array(PREFAB_LIMITS.maxPrefabs + 1).fill({}) }))).toThrow(
      /imports up to/,
    );
    expect(() => importPack(pack({ prefabs: [{ name: 'x', entities: [] }] }))).toThrow(/no usable objects/);
    const huge = { name: 'big', entities: new Array(PREFAB_LIMITS.maxEntities + 1).fill({ kind: 'body' }) };
    expect(() => importPack(pack({ prefabs: [huge] }))).toThrow(/up to 5,000/);
  });

  it('skips a bad prefab with a warning and sanitises the good one', () => {
    const good = {
      id: 'g',
      name: 'x'.repeat(500),
      tags: ['a', 7, 'a', { evil: 1 }],
      entities: [
        { kind: 'body', id: 'e1', name: 'E', shape: { type: 'box', size: [1e12, -3, NaN] }, position: [1e12, NaN, 0] },
        { kind: 'banana', id: 'e2' },
      ],
      variables: [
        { name: '__proto__', kind: 'number', bindings: [] },
        {
          name: 'ok',
          kind: 'number',
          default: 5,
          min: 10,
          max: 0,
          bindings: [{ prop: 'size.y', entityId: 'ghost' }, { prop: 'material' }, { prop: 'size.x', entityId: 'e1' }],
        },
      ],
      variants: [
        {
          name: 'v',
          overrides: {
            materialPreset: 'unobtainium',
            color: 'red',
            sizeScale: 1e9,
            variableValues: { ok: 3, junk: 1 },
          },
        },
      ],
      nested: [{ prefabId: '' }, { prefabId: 'p2', position: [1e12, 0, 0], yaw: 1e9 }],
      thumbnail: 'javascript:alert(1)',
    };
    const r = importPack(JSON.stringify({ format: PACK_FORMAT, version: 1, prefabs: [{ name: 'bad' }, good] }));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Skipped: .*bad/);
    const p = r.prefabs[0];
    expect(p.name.length).toBeLessThanOrEqual(120);
    expect(p.tags).toEqual(['a']);
    expect(p.entities).toHaveLength(1);
    const b = p.entities[0] as BodyEntity;
    expect(Math.abs(b.position[0])).toBeLessThanOrEqual(1_000_000);
    expect(b.shape.size.every((v) => Number.isFinite(v) && v > 0 && v <= 100_000)).toBe(true);
    expect(p.variables.map((v) => v.name)).toEqual(['ok']);
    expect(p.variables[0].min).toBe(0);
    expect(p.variables[0].max).toBe(10);
    expect(p.variables[0].bindings).toEqual([{ prop: 'size.x', entityId: 'e1' }]);
    expect(p.variants[0].overrides).toEqual({ sizeScale: 100, variableValues: { ok: 3 } });
    expect(p.nested).toHaveLength(1);
    expect(p.nested[0].yaw).toBe(360);
    expect(Math.abs(p.nested[0].position[0])).toBeLessThanOrEqual(1_000_000);
    expect(p.thumbnail).toBe('');
  });

  it('drops oversize thumbnails and renames clashing ids consistently (nested refs follow)', () => {
    const a = box('A', [0, 0.5, 0]);
    const p = capturePrefab([a], [a.id], 'T', { id: 'same' })!;
    p.thumbnail = 'data:image/png;base64,' + 'A'.repeat(PREFAB_LIMITS.maxThumbnailChars);
    expect(sanitizePrefab(p).thumbnail).toBe('');
    const q = capturePrefab([a], [a.id], 'Q', { id: 'q' })!;
    q.nested = [{ id: 'n', prefabId: 'same', position: [0, 0, 0], yaw: 0 }];
    const out = reidentifyImported([p, q], new Set(['same']));
    expect(out[0].id).not.toBe('same');
    expect(out[1].id).toBe('q');
    expect(out[1].nested[0].prefabId).toBe(out[0].id);
  });
});

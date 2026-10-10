/**
 * UI-A outliner (UI-20/21): the pure tree model (rows, filters, sort, ranges, drop plans, solo, tags), the virtual
 * list window maths, and the document fields it added (colour tag, tags on every kind, solo marks, selection sets).
 */
import { describe, expect, it } from 'vitest';
import { createBody, createGroup, createJoint, createLight, newDocument } from '../src/model/factory';
import { parseDocument, serializeDocument } from '../src/model/serialize';
import { SceneStore } from '../src/model/store';
import type { Entity } from '../src/model/types';
import {
  buildRows,
  dropZone,
  emptyFilter,
  idsWithTag,
  matches,
  parseQuery,
  planDrop,
  rangeIds,
  reorderedOrder,
  soloPatches,
  tagCounts,
  uniqueSetName,
  withTag,
  type EntityRow,
  type Row,
} from '../src/ui/outliner/treeModel';
import { visibleRange } from '../src/ui/outliner/virtualList';

const box = (name: string, over: Partial<Entity> = {}) =>
  ({ ...createBody({ name, shape: { type: 'box' } }), ...over }) as Entity;
const names = (rows: Row[]) =>
  rows.filter((r): r is EntityRow => r.type === 'entity').map((r) => `${r.depth}:${r.entity.name}`);
const opts = { folded: new Set<string>(), filter: emptyFilter(), sort: 'manual' as const };

function scene() {
  const g = createGroup({ name: 'Wheels' });
  const a = box('Alpha', { parent: g.id, tags: ['wheel'], colorTag: 'red' });
  const b = box('Beta', { parent: g.id });
  const c = box('Charlie', { tags: ['body'] });
  const l = createLight('point', { name: 'Lamp' });
  const j = createJoint({ type: 'hinge', name: 'Hinge', bodyA: a.id, bodyB: c.id, anchorA: [0, 0, 0] });
  return { g, a, b, c, l, j, all: [g, a, b, c, l, j] as Entity[] };
}

describe('rows', () => {
  it('nests members under their group and puts joints in their own section', () => {
    const s = scene();
    const rows = buildRows(s.all, opts);
    expect(names(rows)).toEqual(['0:Wheels', '1:Alpha', '1:Beta', '0:Charlie', '0:Lamp', '0:Hinge']);
    expect(rows.some((r) => r.type === 'header' && r.count === 1)).toBe(true);
  });
  it('folded groups hide their members; a filter flattens and finds them anyway', () => {
    const s = scene();
    expect(names(buildRows(s.all, { ...opts, folded: new Set([s.g.id]) }))).toEqual([
      '0:Wheels',
      '0:Charlie',
      '0:Lamp',
      '0:Hinge',
    ]);
    const hit = buildRows(s.all, { ...opts, folded: new Set([s.g.id]), filter: parseQuery('alpha') });
    expect(names(hit)).toEqual(['0:Alpha']);
  });
  it('keeps an object whose parent is not a group at the top, and survives cycles', () => {
    const c = box('C');
    const stray = box('Stray', { parent: c.id });
    expect(names(buildRows([c, stray], opts))).toEqual(['0:C', '0:Stray']);
    const g1 = createGroup({ name: 'G1' });
    const g2 = createGroup({ name: 'G2', parent: g1.id });
    g1.parent = g2.id; // hand-made cycle: nothing is reachable from a root, nothing may loop
    expect(() => buildRows([g1, g2], opts)).not.toThrow();
  });
  it('sorts siblings by name, type, colour tag without breaking the hierarchy', () => {
    const s = scene();
    expect(names(buildRows(s.all, { ...opts, sort: 'nameDesc' })).slice(0, 4)).toEqual([
      '0:Wheels',
      '1:Beta',
      '1:Alpha',
      '0:Lamp',
    ]);
    s.b.colorTag = 'blue';
    const tagged = names(buildRows(s.all, { ...opts, sort: 'tag' }));
    expect(tagged.indexOf('1:Beta')).toBeLessThan(tagged.indexOf('1:Alpha')); // blue < red
  });
  it('builds 20 000 rows quickly', () => {
    const many: Entity[] = [];
    const g = createGroup({ name: 'G' });
    many.push(g);
    for (let i = 0; i < 20000; i++) many.push(box(`B${i}`, i % 2 ? { parent: g.id } : {}));
    const t = performance.now();
    const rows = buildRows(many, { ...opts, sort: 'name' });
    expect(rows.length).toBe(20000 + 1 - 0);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('filters', () => {
  it('parses key:value tokens and keeps the rest as name text', () => {
    const f = parseQuery('wheel type:box tag:Red is:locked has:spring');
    expect(f).toMatchObject({ text: 'wheel', type: 'box', tag: 'red', locked: true, component: 'spring' });
    expect(parseQuery('is:hidden').hidden).toBe(true);
    expect(parseQuery('foo:bar').text).toBe('foo:bar');
  });
  it('matches by type, material, tag, state and component', () => {
    const s = scene();
    expect(s.all.filter((e) => matches(e, parseQuery('type:light')))).toEqual([s.l]);
    expect(s.all.filter((e) => matches(e, parseQuery('type:joint'))).length).toBe(1);
    expect(s.all.filter((e) => matches(e, parseQuery('type:box'))).length).toBe(3);
    expect(s.all.filter((e) => matches(e, parseQuery('tag:wheel')))).toEqual([s.a]);
    expect(s.all.filter((e) => matches(e, parseQuery('tag:red')))).toEqual([s.a]); // colour tag key
    const mat = (s.a as { material: { preset: string } }).material.preset;
    expect(s.all.filter((e) => matches(e, parseQuery(`material:${mat}`))).length).toBe(3);
    const locked = { ...s.c, locked: true } as Entity;
    expect(matches(locked, parseQuery('is:locked'))).toBe(true);
    expect(matches(s.c, parseQuery('is:locked'))).toBe(false);
    expect(matches(s.c, parseQuery('has:component'))).toBe(false);
    const withComp = { ...s.c, components: [{ id: 'x', type: 'spring', enabled: true, params: {} }] } as Entity;
    expect(matches(withComp, parseQuery('has:component'))).toBe(true);
    expect(matches(withComp, parseQuery('has:spring'))).toBe(true);
    expect(matches(withComp, parseQuery('has:motor'))).toBe(false);
  });
});

describe('selection ranges', () => {
  it('returns the visible rows between anchor and target in either direction, skipping headers', () => {
    const s = scene();
    const rows = buildRows(s.all, opts);
    expect(rangeIds(rows, s.a.id, s.c.id)).toEqual([s.a.id, s.b.id, s.c.id]);
    expect(rangeIds(rows, s.c.id, s.a.id)).toEqual([s.a.id, s.b.id, s.c.id]);
    expect(rangeIds(rows, s.l.id, s.j.id)).toEqual([s.l.id, s.j.id]); // the header row between is not an id
    expect(rangeIds(rows, null, s.b.id)).toEqual([s.b.id]);
    expect(rangeIds(rows, 'gone', s.b.id)).toEqual([s.b.id]);
  });
});

describe('drop planning', () => {
  it('maps pointer height to a zone (groups have a middle "inside" band)', () => {
    expect(dropZone(0.1, true)).toBe('before');
    expect(dropZone(0.5, true)).toBe('inside');
    expect(dropZone(0.9, true)).toBe('after');
    expect(dropZone(0.4, false)).toBe('before');
    expect(dropZone(0.6, false)).toBe('after');
  });
  it('reorders keeping relative order and handles before / after', () => {
    expect(reorderedOrder(['a', 'b', 'c', 'd'], ['a', 'b'], 'd', 'after')).toEqual(['c', 'd', 'a', 'b']);
    expect(reorderedOrder(['a', 'b', 'c', 'd'], ['d'], 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderedOrder(['a', 'b'], ['a'], 'zzz', 'before')).toEqual(['a', 'b']);
  });
  it('dropping inside a group reparents; into the group itself or its own subtree is refused', () => {
    const s = scene();
    const rows = buildRows(s.all, opts);
    const plan = planDrop(s.all, rows, [s.c.id], s.g.id, 'inside', true);
    expect(plan).toMatchObject({ ids: [s.c.id], parent: s.g.id, order: null });
    expect(planDrop(s.all, rows, [s.g.id], s.g.id, 'inside', true)).toBeNull();
    const outer = createGroup({ name: 'Outer' });
    const inner = createGroup({ name: 'Inner', parent: outer.id });
    const all = [outer, inner];
    expect(planDrop(all, buildRows(all, opts), [outer.id], inner.id, 'inside', true)).toBeNull(); // cycle
  });
  it("before / after takes the target's parent and reorders when allowed", () => {
    const s = scene();
    const rows = buildRows(s.all, opts);
    const plan = planDrop(s.all, rows, [s.l.id], s.a.id, 'after', true)!;
    expect(plan.parent).toBe(s.g.id);
    expect(plan.order!.indexOf(s.l.id)).toBe(plan.order!.indexOf(s.a.id) + 1);
    // dropping where it already is (just reparenting) leaves the order alone
    expect(planDrop(s.all, rows, [s.c.id], s.b.id, 'after', true)).toMatchObject({ parent: s.g.id, order: null });
    // without reorder rights only the reparent remains
    const flat = planDrop(s.all, rows, [s.c.id], s.b.id, 'after', false)!;
    expect(flat).toMatchObject({ parent: s.g.id, order: null });
    // no-op drop
    expect(planDrop(s.all, rows, [s.a.id], s.b.id, 'before', true)).toBeNull();
  });
  it('"after" an unfolded group means "first member"; joints are never moved or targeted', () => {
    const s = scene();
    const rows = buildRows(s.all, opts);
    const plan = planDrop(s.all, rows, [s.c.id], s.g.id, 'after', true)!;
    expect(plan.parent).toBe(s.g.id);
    expect(plan.order!.indexOf(s.c.id)).toBe(plan.order!.indexOf(s.a.id) - 1);
    expect(planDrop(s.all, rows, [s.j.id], s.c.id, 'before', true)).toBeNull();
    expect(planDrop(s.all, rows, [s.c.id], s.j.id, 'before', true)).toBeNull();
  });
});

describe('solo', () => {
  it('hides what is unrelated to the soloed entity, keeps ancestors / members / joint partners, and restores exactly', () => {
    const s = scene();
    const store = new SceneStore();
    store.add(
      s.all.map((e) => ({ ...e })),
      'x',
    );
    const manual = box('Manual', { hidden: true });
    store.add([manual], 'x');
    store.updateMany(soloPatches(store.all(), [s.a.id]), 'Solo');
    const by = (id: string) => store.get(id)!;
    expect(by(s.a.id).solo).toBe(true);
    expect(by(s.g.id).hidden).toBe(false); // ancestor stays
    expect(by(s.b.id).hidden).toBe(true); // sibling goes
    expect(by(s.c.id).hidden).toBe(true);
    expect(by(s.l.id).hidden).toBe(true);
    expect(by(s.j.id).hidden).toBe(false); // joint touching the soloed body
    expect(by(manual.id).soloHid).toBeUndefined(); // already hidden by the user: not ours
    // soloing a second one keeps both
    store.updateMany(soloPatches(store.all(), [s.c.id]), 'Solo');
    expect(by(s.c.id).hidden).toBe(false);
    expect(by(s.b.id).hidden).toBe(true);
    // clearing both restores exactly what solo hid
    store.updateMany(soloPatches(store.all(), [s.a.id, s.c.id]), 'Unsolo');
    expect(store.all().filter((e) => e.solo)).toHaveLength(0);
    expect(
      store
        .all()
        .filter((e) => e.hidden)
        .map((e) => e.id),
    ).toEqual([manual.id]);
    expect(store.all().some((e) => e.soloHid)).toBe(false);
    store.undo();
    expect(by(s.a.id).solo).toBe(true);
  });
  it('soloing a group keeps its members visible', () => {
    const s = scene();
    const patches = soloPatches(s.all, [s.g.id]);
    const hidden = patches.filter(([, p]) => p.hidden).map(([id]) => id);
    expect(hidden.sort()).toEqual([s.c.id, s.l.id].sort());
  });
});

describe('tags', () => {
  it('counts, selects and edits tags', () => {
    const s = scene();
    expect(tagCounts(s.all)).toEqual([
      ['body', 1],
      ['wheel', 1],
    ]);
    expect(idsWithTag(s.all, 'wheel')).toEqual([s.a.id]);
    expect(idsWithTag(s.all, 'color:red')).toEqual([s.a.id]);
    expect(withTag(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(withTag(['a', 'b'], 'a', true)).toEqual(['b', 'a']);
    expect(withTag(undefined, 'a', false)).toEqual([]);
    expect(uniqueSetName(['Set', 'Set 2'], 'Set')).toBe('Set 3');
    expect(uniqueSetName([], '  ')).toBe('Selection');
  });
});

describe('virtual window', () => {
  it('only asks for the rows in view plus overscan, whatever the count', () => {
    expect(visibleRange(0, 280, 28, 5000, 0)).toEqual([0, 10]);
    expect(visibleRange(2800, 280, 28, 5000, 3)).toEqual([97, 113]);
    expect(visibleRange(0, 280, 28, 4, 6)).toEqual([0, 4]);
    expect(visibleRange(0, 280, 28, 0, 6)).toEqual([0, 0]);
    const [a, b] = visibleRange(28 * 99_000, 300, 28, 100_000, 6);
    expect(b - a).toBeLessThan(30);
  });
});

describe('document fields', () => {
  it('colour tags, tags on every kind, solo marks and selection sets survive a save / load', () => {
    const s = scene();
    s.l.tags = ['key'];
    s.l.colorTag = 'blue';
    s.g.colorTag = 'green';
    s.a.solo = true;
    s.b.soloHid = true;
    const doc = { ...newDocument('t'), entities: s.all };
    doc.settings = { ...doc.settings, selectionSets: [{ name: 'Front', ids: [s.a.id, s.b.id] }] };
    const back = parseDocument(serializeDocument(doc));
    const by = (id: string) => back.entities.find((e) => e.id === id)!;
    expect(by(s.l.id)).toMatchObject({ tags: ['key'], colorTag: 'blue' });
    expect(by(s.g.id).colorTag).toBe('green');
    expect(by(s.a.id)).toMatchObject({ solo: true, tags: ['wheel'], colorTag: 'red' });
    expect(by(s.b.id).soloHid).toBe(true);
    expect(back.settings.selectionSets).toEqual([{ name: 'Front', ids: [s.a.id, s.b.id] }]);
  });
  it('old documents load with defaults, and garbage is sanitised', () => {
    const old = JSON.parse(serializeDocument({ ...newDocument('t'), entities: [box('X')] })) as Record<string, unknown>;
    delete (old.settings as Record<string, unknown>).selectionSets;
    const doc = parseDocument(JSON.stringify(old));
    expect(doc.settings.selectionSets).toEqual([]);
    expect(doc.entities[0].colorTag).toBeUndefined();
    expect(doc.entities[0].solo).toBeUndefined();
    const bad = JSON.parse(
      serializeDocument({ ...newDocument('t'), entities: [box('X'), createGroup({ name: 'G' })] }),
    ) as {
      settings: Record<string, unknown>;
      entities: Record<string, unknown>[];
    };
    bad.entities[0].colorTag = 'ultraviolet';
    bad.entities[0].solo = 'yes';
    bad.entities[1].tags = [1, ' a ', 'a', '', 'b'];
    bad.settings.selectionSets = [
      { name: 'ok', ids: ['a', 'a', 3, ''] },
      { name: 'ok', ids: [] },
      { name: '   ', ids: ['x'] },
      'nope',
      { name: 'noids' },
    ];
    const clean = parseDocument(JSON.stringify(bad));
    expect(clean.entities[0].colorTag).toBeUndefined();
    expect(clean.entities[0].solo).toBeUndefined();
    expect(clean.entities[1].tags).toEqual(['a', 'b']);
    expect(clean.settings.selectionSets).toEqual([
      { name: 'ok', ids: ['a'] },
      { name: 'noids', ids: [] },
    ]);
  });
  it('selection sets are part of the undo history', () => {
    const store = new SceneStore();
    store.updateSettings({ selectionSets: [{ name: 'A', ids: ['x'] }] }, 'Save selection set');
    expect(store.settings.selectionSets).toHaveLength(1);
    store.undo();
    expect(store.settings.selectionSets).toHaveLength(0);
  });
});

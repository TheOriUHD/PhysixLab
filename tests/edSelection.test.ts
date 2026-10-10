import { describe, expect, it } from 'vitest';
import { createBody, createGroup, createJoint, createLight } from '../src/model/factory';
import {
  brushHits,
  combineSelection,
  connectedByJoints,
  filterEntities,
  filterIsValid,
  groupChildren,
  growByJoints,
  invertSelection,
  lassoHits,
  modeFromModifiers,
  pointInPolygon,
  selectSimilar,
  shrinkByJoints,
  type ScreenPt,
} from '../src/model/edit/selection';
import type { BodyEntity, Entity } from '../src/model/types';

const body = (name: string, over: Record<string, unknown> = {}): BodyEntity => createBody({ name, ...over });
const link = (a: BodyEntity | null, b: BodyEntity | null) =>
  createJoint({ type: 'hinge', bodyA: a?.id ?? null, bodyB: b?.id ?? null, anchorA: [0, 0, 0] });

describe('pointInPolygon / lasso / brush', () => {
  const square: ScreenPt[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  it('even-odd containment, concave shapes and degenerate polygons', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(11, 5, square)).toBe(false);
    expect(pointInPolygon(-0.1, 5, square)).toBe(false);
    // L shape: the notch (7,7) is outside, (2,7) inside
    const L: ScreenPt[] = [
      [0, 0],
      [10, 0],
      [10, 5],
      [5, 5],
      [5, 10],
      [0, 10],
    ];
    expect(pointInPolygon(7, 7, L)).toBe(false);
    expect(pointInPolygon(2, 7, L)).toBe(true);
    expect(
      pointInPolygon(2, 2, [
        [0, 0],
        [5, 5],
      ]),
    ).toBe(false);
  });
  it('lassoHits uses any sample point (centre or bbox corner)', () => {
    const targets = [
      { id: 'in', samples: [[5, 5]] as ScreenPt[] },
      {
        id: 'out',
        samples: [
          [50, 50],
          [60, 60],
        ] as ScreenPt[],
      },
      {
        id: 'corner',
        samples: [
          [20, 5],
          [9, 9],
        ] as ScreenPt[],
      }, // centre outside, one corner inside
    ];
    expect(lassoHits(targets, square)).toEqual(['in', 'corner']);
  });
  it('brushHits is a closed disc: boundary hits, beyond misses', () => {
    const targets = [
      { id: 'a', samples: [[3, 4]] as ScreenPt[] }, // distance exactly 5 from the origin
      { id: 'b', samples: [[3, 4.01]] as ScreenPt[] },
    ];
    expect(brushHits(targets, 0, 0, 5)).toEqual(['a']);
    expect(brushHits(targets, 0, 0, 5.02)).toEqual(['a', 'b']);
  });
});

describe('modes', () => {
  it('modifiers and combination', () => {
    expect(modeFromModifiers({})).toBe('replace');
    expect(modeFromModifiers({ shift: true })).toBe('add');
    expect(modeFromModifiers({ ctrl: true })).toBe('subtract');
    expect(modeFromModifiers({ meta: true, shift: true })).toBe('subtract');
    expect(combineSelection(['a', 'b'], ['c', 'c'], 'replace')).toEqual(['c']);
    expect(combineSelection(['a', 'b'], ['b', 'c'], 'add')).toEqual(['a', 'b', 'c']);
    expect(combineSelection(['a', 'b', 'c'], ['b', 'z'], 'subtract')).toEqual(['a', 'c']);
  });
});

describe('selectSimilar', () => {
  const s1 = body('s1', { shape: { type: 'sphere', size: [1, 1, 1] }, material: 'rubber', tags: ['red'] });
  const s2 = body('s2', {
    shape: { type: 'sphere', size: [1.005, 1.005, 1.005] },
    material: 'rubber',
    tags: ['red', 'x'],
  });
  const s3 = body('s3', { shape: { type: 'sphere', size: [2, 2, 2] }, material: 'steel', tags: [] });
  const b1 = body('b1', { shape: { type: 'box', size: [1, 1, 1] }, material: 'rubber', layer: 'L2' });
  const hid = body('hid', { shape: { type: 'sphere', size: [1, 1, 1] }, material: 'rubber', hidden: true });
  const light = createLight('point');
  const all: Entity[] = [s1, s2, s3, b1, hid, light];

  it('by shape', () => {
    expect(selectSimilar(all, [s1.id], { shape: true })).toEqual([s1.id, s2.id, s3.id]);
  });
  it('by material (preset + colour)', () => {
    expect(selectSimilar(all, [s1.id], { material: true })).toEqual([s1.id, s2.id, b1.id]);
  });
  it('by size within 1 %', () => {
    expect(selectSimilar(all, [s1.id], { size: true })).toEqual([s1.id, s2.id, b1.id]);
  });
  it('criteria combine with AND; hidden are skipped', () => {
    expect(selectSimilar(all, [s1.id], { shape: true, size: true })).toEqual([s1.id, s2.id]);
    expect(selectSimilar(all, [s1.id], { shape: true, material: true, size: true })).toEqual([s1.id, s2.id]);
  });
  it('by tag: shared tag; untagged seeds match untagged', () => {
    expect(selectSimilar(all, [s1.id], { tag: true })).toEqual([s1.id, s2.id]);
    expect(selectSimilar(all, [s3.id], { tag: true })).toEqual([s3.id, b1.id]);
  });
  it('by kind and by layer', () => {
    expect(selectSimilar(all, [light.id], { kind: true })).toEqual([light.id]);
    expect(selectSimilar(all, [b1.id], { layer: true })).toEqual([b1.id]);
    expect(selectSimilar(all, [s1.id], { kind: true })).toEqual([s1.id, s2.id, s3.id, b1.id]);
  });
  it('no criterion returns just the seeds; unknown / hidden seeds give nothing', () => {
    expect(selectSimilar(all, [s3.id], {})).toEqual([s3.id]);
    expect(selectSimilar(all, [hid.id], { shape: true })).toEqual([]);
    expect(selectSimilar(all, ['nope'], { shape: true })).toEqual([]);
  });
  it('several seeds are a union', () => {
    expect(selectSimilar(all, [s3.id, b1.id], { shape: true })).toEqual([s1.id, s2.id, s3.id, b1.id]);
  });
});

describe('invert and filter', () => {
  const a = body('Crate A', { tags: ['wood'], bodyType: 'static', layer: 'one' });
  const b = body('Crate B', { tags: ['Metal'], shape: { type: 'sphere', size: [1, 1, 1] } });
  const c = body('ball-07', { tags: ['wood', 'metal'] });
  const h = body('Crate hidden', { hidden: true });
  const g = createGroup({ name: 'Crates group' });
  const all: Entity[] = [a, b, c, h, g];

  it('invert excludes selection and hidden', () => {
    expect(invertSelection(all, [a.id])).toEqual([b.id, c.id, g.id]);
    expect(invertSelection(all, [])).toEqual([a.id, b.id, c.id, g.id]);
    expect(
      invertSelection(
        all,
        all.map((e) => e.id),
      ),
    ).toEqual([]);
  });
  it('name substring is case-insensitive', () => {
    expect(filterEntities(all, { name: 'crate' })).toEqual([a.id, b.id, g.id]);
    expect(filterEntities(all, { name: 'crate', kind: 'body' })).toEqual([a.id, b.id]);
  });
  it('regex', () => {
    expect(filterEntities(all, { name: '^ball-\\d+$', regex: true })).toEqual([c.id]);
    expect(filterIsValid({ name: '(', regex: true })).toBe(false);
    expect(filterEntities(all, { name: '(', regex: true })).toEqual([]);
    expect(filterIsValid({ name: '(' })).toBe(true);
  });
  it('tag is exact and case-insensitive; combined with other fields', () => {
    expect(filterEntities(all, { tag: 'metal' })).toEqual([b.id, c.id]);
    expect(filterEntities(all, { tag: 'wood', shape: 'box' })).toEqual([a.id, c.id]);
    expect(filterEntities(all, { tag: 'wood', bodyType: 'static' })).toEqual([a.id]);
    expect(filterEntities(all, { layer: 'one' })).toEqual([a.id]);
    expect(filterEntities(all, { shape: 'sphere' })).toEqual([b.id]);
  });
  it('an empty filter matches nothing', () => {
    expect(filterEntities(all, {})).toEqual([]);
    expect(filterEntities(all, { name: '', tag: '' })).toEqual([]);
  });
});

describe('group children', () => {
  const g = createGroup({ name: 'G' });
  const sub = createGroup({ name: 'Sub', parent: g.id });
  const x = body('x', { parent: g.id });
  const y = body('y', { parent: sub.id });
  const z = body('z');
  const hid = body('hid', { parent: g.id, hidden: true });
  const all: Entity[] = [g, sub, x, y, z, hid];
  it('direct children, deep descendants, non-groups ignored, hidden skipped', () => {
    expect(groupChildren(all, [g.id])).toEqual([sub.id, x.id]);
    expect(groupChildren(all, [g.id], true)).toEqual([sub.id, x.id, y.id]);
    expect(groupChildren(all, [z.id])).toEqual([]);
    expect(groupChildren(all, [sub.id, z.id])).toEqual([y.id]);
  });
});

describe('joint graph', () => {
  // chain a - b - c - d, a hinge from d to the world, e isolated, f hidden hanging off d, g - h pair
  const [a, b, c, d, e, f, g, h] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) =>
    body(n, n === 'f' ? { hidden: true } : {}),
  );
  const jab = link(a, b),
    jbc = link(b, c),
    jcd = link(c, d),
    jdw = link(d, null),
    jdf = link(d, f),
    jgh = link(h, g); // reversed direction on purpose
  const all: Entity[] = [a, b, c, d, e, f, g, h, jab, jbc, jcd, jdw, jdf, jgh];

  it('connected: flood fill both directions, hidden bodies and the world are not walked', () => {
    expect(connectedByJoints(all, [c.id])).toEqual([a.id, b.id, c.id, d.id]);
    expect(connectedByJoints(all, [g.id])).toEqual([g.id, h.id]);
    expect(connectedByJoints(all, [e.id])).toEqual([e.id]);
    expect(connectedByJoints(all, [jbc.id])).toEqual([a.id, b.id, c.id, d.id]);
  });
  it('connected with joints included lists the joints between reached bodies (and world joints)', () => {
    expect(connectedByJoints(all, [a.id], true)).toEqual([a.id, b.id, c.id, d.id, jab.id, jbc.id, jcd.id, jdw.id]);
  });
  it('grow adds exactly one hop', () => {
    expect(growByJoints(all, [a.id])).toEqual([a.id, b.id]);
    expect(growByJoints(all, [b.id])).toEqual([b.id, a.id, c.id]);
    expect(growByJoints(all, growByJoints(all, [a.id]))).toEqual([a.id, b.id, c.id]);
    expect(growByJoints(all, [e.id])).toEqual([e.id]);
    expect(growByJoints(all, [d.id])).toEqual([d.id, c.id]); // hidden f is not added
  });
  it('shrink removes the boundary: bodies joined to something outside the selection', () => {
    // a b c d selected: the whole component has no outside neighbour except hidden f (never selected, so d is boundary)
    expect(shrinkByJoints(all, [a.id, b.id, c.id])).toEqual([a.id, b.id]);
    expect(shrinkByJoints(all, [a.id, b.id])).toEqual([a.id]);
    expect(shrinkByJoints(all, [e.id])).toEqual([e.id]); // jointless bodies are interior
    expect(shrinkByJoints(all, [g.id, h.id])).toEqual([g.id, h.id]); // closed component
  });
  it('grow then shrink is not an inverse at a chain end: a-b-c grown from b loses c (touches d) but keeps a', () => {
    const grown = growByJoints(all, [b.id]);
    expect(grown).toEqual([b.id, a.id, c.id]);
    expect(shrinkByJoints(all, grown)).toEqual([b.id, a.id]);
  });
  it('shrink drops selected joints of dropped bodies', () => {
    expect(shrinkByJoints(all, [a.id, b.id, c.id, jbc.id, jab.id])).toEqual([a.id, b.id, jab.id]);
  });
});

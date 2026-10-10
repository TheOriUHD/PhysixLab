import { describe, expect, it } from 'vitest';
import { qangle, qfromAxisAngle, qrot, type Quat, type Vec3 } from '../src/core/math';
import { createBody, createGroup, createJoint } from '../src/model/factory';
import { groupTransformPatches } from '../src/model/groups';
import { makeShapeSpec } from '../src/model/shapeRegistry';
import { aabbCentre, entityBounds, selectionBounds } from '../src/model/edit/bounds';
import {
  alignPatches,
  centreOnOriginPatches,
  distributePatches,
  dropOntoSurfacePatches,
  dropToGroundPatches,
  randomisePatches,
  stackPatches,
  DEFAULT_RANDOMISE,
} from '../src/model/edit/arrange';
import { movePatches } from '../src/model/edit/moves';
import {
  groupPivotPatches,
  rotateAboutPatches,
  rotatePointAboutAxis,
  scaleAboutPatches,
  setGroupPivotPatches,
} from '../src/model/edit/pivot';
import type { Entity } from '../src/model/types';

const box = (id: string, position: Vec3, size: Vec3 = [1, 1, 1], over: Partial<Entity> = {}) =>
  createBody({ id, shape: makeShapeSpec('box', size), position, ...over });

/** Apply patches the way SceneStore.updateMany does. */
function apply(entities: Entity[], patches: [string, Partial<Entity>][]): Entity[] {
  const m = new Map(patches.map(([id, p]) => [id, p]));
  return entities.map((e) => (m.has(e.id) ? ({ ...e, ...m.get(e.id) } as Entity) : e));
}
const near = (a: readonly number[], b: readonly number[], digits = 9) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const pos = (es: Entity[], id: string) => (es.find((e) => e.id === id) as { position: Vec3 }).position;

describe('align', () => {
  const scene = () => [box('a', [0, 0, 0], [1, 1, 1]), box('b', [5, 0, 0], [2, 1, 1]), box('c', [-3, 0, 0], [4, 1, 1])];

  it('max-x: right edges coincide at the selection max', () => {
    const es = apply(scene(), alignPatches(scene(), ['a', 'b', 'c'], 'x', 'max'));
    for (const id of ['a', 'b', 'c']) expect(entityBounds(es, id)!.max[0]).toBeCloseTo(6); // b's right edge: 5 + 1
  });

  it('min-x and centre-x', () => {
    const lo = apply(scene(), alignPatches(scene(), ['a', 'b', 'c'], 0, 'min'));
    for (const id of ['a', 'b', 'c']) expect(entityBounds(lo, id)!.min[0]).toBeCloseTo(-5); // c: -3 - 2
    const mid = apply(scene(), alignPatches(scene(), ['a', 'b', 'c'], 0, 'centre'));
    // selection spans -5..6, centre 0.5
    for (const id of ['a', 'b', 'c']) expect(aabbCentre(entityBounds(mid, id)!)[0]).toBeCloseTo(0.5);
  });

  it('to active: the active (last) object stays, the rest line up with it', () => {
    const es = apply(scene(), alignPatches(scene(), ['a', 'b', 'c'], 'x', 'min', 'active'));
    near(pos(es, 'c'), [-3, 0, 0]);
    expect(entityBounds(es, 'a')!.min[0]).toBeCloseTo(-5);
    expect(entityBounds(es, 'b')!.min[0]).toBeCloseTo(-5);
    const named = apply(scene(), alignPatches(scene(), ['a', 'b', 'c'], 'x', 'max', 'active', 'a'));
    expect(entityBounds(named, 'b')!.max[0]).toBeCloseTo(0.5);
    near(pos(named, 'a'), [0, 0, 0]);
  });

  it('skips locked objects and carries group members', () => {
    const g = createGroup({ id: 'g', position: [0, 0, 0] });
    const es: Entity[] = [
      g,
      box('m', [10, 0, 0], [2, 2, 2], { parent: 'g' }),
      box('n', [10, 3, 0], [2, 2, 2], { parent: 'g' }),
      box('lock', [-4, 0, 0], [1, 1, 1], { locked: true }),
      box('x', [0, 0, 0]),
    ];
    const out = apply(es, alignPatches(es, ['g', 'lock', 'x'], 'x', 'min'));
    near(pos(out, 'lock'), [-4, 0, 0]); // untouched
    // selection min x = -4.5 (the locked box counts as reference); group members move together
    expect(selectionBounds(out, ['g'])!.min[0]).toBeCloseTo(-4.5);
    expect(pos(out, 'm')[1]).toBeCloseTo(0);
    expect(pos(out, 'n')[1]).toBeCloseTo(3);
  });
});

describe('distribute', () => {
  it('spacing: equal centre distances, endpoints stay', () => {
    const es = [box('a', [0, 0, 0]), box('b', [1, 0, 0], [3, 1, 1]), box('c', [9, 0, 0]), box('d', [10, 0, 0])];
    const out = apply(es, distributePatches(es, ['a', 'b', 'c', 'd'], 'x', 'spacing'));
    near(pos(out, 'a'), [0, 0, 0]);
    near(pos(out, 'd'), [10, 0, 0]);
    near([pos(out, 'b')[0], pos(out, 'c')[0]], [10 / 3, 20 / 3]);
  });

  it('gaps: equal empty space between neighbouring bounds', () => {
    const es = [box('a', [0, 0, 0], [1, 1, 1]), box('b', [2, 0, 0], [3, 1, 1]), box('c', [10, 0, 0], [2, 1, 1])];
    const out = apply(es, distributePatches(es, ['a', 'b', 'c'], 'x', 'gaps'));
    const a = entityBounds(out, 'a')!,
      b = entityBounds(out, 'b')!,
      c = entityBounds(out, 'c')!;
    // span -0.5..11 = 11.5, widths 1+3+2 = 6, two gaps of 2.75
    expect(b.min[0] - a.max[0]).toBeCloseTo(2.75);
    expect(c.min[0] - b.max[0]).toBeCloseTo(2.75);
    expect(a.min[0]).toBeCloseTo(-0.5);
    expect(c.max[0]).toBeCloseTo(11);
  });

  it('needs three objects', () => {
    const es = [box('a', [0, 0, 0]), box('b', [4, 0, 0])];
    expect(distributePatches(es, ['a', 'b'], 'x', 'gaps')).toEqual([]);
  });
});

describe('drop and stack', () => {
  it('drop to ground puts the lowest point at y = 0, also for a tilted box', () => {
    const tilted = box('t', [0, 7, 0], [2, 2, 2], { rotation: qfromAxisAngle([0, 0, 1], Math.PI / 4) });
    const es = [box('a', [0, 3, 0], [1, 2, 1]), tilted];
    const out = apply(es, dropToGroundPatches(es, ['a', 't']));
    expect(entityBounds(out, 'a')!.min[1]).toBeCloseTo(0);
    expect(entityBounds(out, 't')!.min[1]).toBeCloseTo(0);
    expect(pos(out, 't')[1]).toBeCloseTo(Math.SQRT2); // half diagonal
    expect(dropToGroundPatches(es, ['a'], { ground: false })).toEqual([]);
  });

  it('drop onto surface rests on the highest body below with overlapping footprint', () => {
    const es = [
      box('floor1', [0, 0.5, 0], [4, 1, 4], { bodyType: 'static' }),
      box('shelf', [0, 2.25, 0], [1, 0.5, 1], { bodyType: 'static' }),
      box('far', [20, 0.5, 0], [1, 1, 1]),
      box('over', [0, 6, 0], [1, 1, 1]),
      box('off', [20, 6, 0], [1, 1, 1]),
    ];
    const out = apply(es, dropOntoSurfacePatches(es, ['over', 'off']));
    expect(entityBounds(out, 'over')!.min[1]).toBeCloseTo(2.5); // on the shelf top (2.25 + 0.25)
    expect(entityBounds(out, 'off')!.min[1]).toBeCloseTo(1); // on 'far'
    // no ground, nothing below: unchanged
    const noGround = dropOntoSurfacePatches([box('s', [100, 5, 0])], ['s'], { ground: false });
    expect(noGround).toEqual([]);
  });

  it('a loose heap settles into a stack (placed objects become surfaces)', () => {
    const es = [box('a', [0, 5, 0]), box('b', [0.1, 9, 0]), box('c', [0, 12, 0.2])];
    const out = apply(es, dropOntoSurfacePatches(es, ['a', 'b', 'c']));
    expect(entityBounds(out, 'a')!.min[1]).toBeCloseTo(0);
    expect(entityBounds(out, 'b')!.min[1]).toBeCloseTo(1);
    expect(entityBounds(out, 'c')!.min[1]).toBeCloseTo(2);
  });

  it('stack: heights plus gaps add up, centred over the first', () => {
    const es = [box('a', [0, 0.5, 0], [1, 1, 1]), box('b', [4, 9, 3], [1, 2, 1]), box('c', [-2, -3, 1], [1, 0.5, 1])];
    const out = apply(es, stackPatches(es, ['a', 'b', 'c'], { gap: 0.1 }));
    const bb = entityBounds(out, 'b')!,
      cb = entityBounds(out, 'c')!;
    expect(bb.min[1]).toBeCloseTo(1.1);
    expect(cb.min[1]).toBeCloseTo(1.1 + 2 + 0.1);
    near(
      aabbCentre(bb).filter((_, i) => i !== 1),
      [0, 0],
    );
    near(
      aabbCentre(cb).filter((_, i) => i !== 1),
      [0, 0],
    );
    // total height of the pile = Σ heights + 2 gaps
    expect(selectionBounds(out, ['a', 'b', 'c'])!.max[1]).toBeCloseTo(3.7);
  });

  it('stack by height orders from the lowest', () => {
    const es = [box('hi', [0, 8, 0]), box('lo', [3, 0.5, 0])];
    const out = apply(es, stackPatches(es, ['hi', 'lo'], { order: 'height' }));
    expect(entityBounds(out, 'hi')!.min[1]).toBeCloseTo(1); // lo stays at 0..1, hi goes on top
    near(pos(out, 'lo'), [3, 0.5, 0]);
  });

  it('centre on origin moves the block, keeping its internal layout', () => {
    const es = [box('a', [3, 1, 3]), box('b', [7, 1, 3], [1, 1, 1])];
    const out = apply(es, centreOnOriginPatches(es, ['a', 'b'], [true, false, true]));
    near(pos(out, 'a'), [-2, 1, 0]);
    near(pos(out, 'b'), [2, 1, 0]);
    const all = apply(es, centreOnOriginPatches(es, ['a', 'b']));
    near(aabbCentre(selectionBounds(all, ['a', 'b'])!), [0, 0, 0]);
  });
});

describe('randomise', () => {
  const es = () => [box('a', [0, 1, 0], [1, 1, 1]), box('b', [3, 1, 0], [1, 1, 1]), box('c', [6, 1, 0], [2, 2, 2])];
  const opts = {
    ...DEFAULT_RANDOMISE,
    position: [1, 0, 2] as Vec3,
    rotation: [0, 90, 0] as Vec3,
    scale: { min: [0.5, 0.5, 0.5] as Vec3, max: [2, 2, 2] as Vec3, uniform: true },
    seed: 42,
  };

  it('same seed gives the same result, another seed a different one', () => {
    const a = randomisePatches(es(), ['a', 'b', 'c'], opts);
    expect(randomisePatches(es(), ['c', 'b', 'a'], opts)).toEqual(a); // selection order does not matter
    expect(randomisePatches(es(), ['a', 'b', 'c'], { ...opts, seed: 43 })).not.toEqual(a);
  });

  it('stays inside the ranges and scales uniformly through the shape registry', () => {
    const out = apply(es(), randomisePatches(es(), ['a', 'b', 'c'], opts));
    for (const [id, home] of [
      ['a', 0],
      ['b', 3],
      ['c', 6],
    ] as const) {
      const e = out.find((x) => x.id === id) as ReturnType<typeof box>;
      expect(Math.abs(e.position[0] - home)).toBeLessThanOrEqual(1);
      expect(e.position[1]).toBe(1); // y range 0
      expect(Math.abs(e.position[2])).toBeLessThanOrEqual(2);
      const base = id === 'c' ? 2 : 1;
      const k = e.shape.size[0] / base;
      expect(k).toBeGreaterThanOrEqual(0.5);
      expect(k).toBeLessThanOrEqual(2);
      near(e.shape.size, [base * k, base * k, base * k]);
      expect(qangle(e.rotation, [0, 0, 0, 1] as Quat)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    }
  });

  it('zero ranges change nothing', () => {
    expect(randomisePatches(es(), ['a', 'b'], { ...DEFAULT_RANDOMISE, seed: 5 })).toEqual([]);
  });
});

describe('movePatches', () => {
  it('a moved group carries its members and a world-anchored joint', () => {
    const g = createGroup({ id: 'g', position: [0, 0, 0] });
    const m = box('m', [1, 0, 0], [1, 1, 1], { parent: 'g' });
    const j = createJoint({ id: 'j', type: 'ball', bodyA: null, bodyB: 'm', anchorA: [1, 1, 0] });
    const es: Entity[] = [g, m, j];
    const q = qfromAxisAngle([0, 1, 0], Math.PI / 2);
    const out = apply(es, movePatches(es, [{ id: 'g', position: [10, 0, 0], rotation: q }]));
    near(pos(out, 'm'), [10, 0, -1]);
    near((out.find((e) => e.id === 'j') as typeof j).anchorA, [10, 1, -1]);
    // agrees with the established group helper
    const ref = apply(es, groupTransformPatches(es, 'g', { position: [10, 0, 0], rotation: q }));
    near(pos(ref, 'm'), pos(out, 'm'));
  });

  it('scale resizes bodies through the shape registry', () => {
    const es = [box('a', [0, 0, 0], [1, 2, 3])];
    const out = apply(es, movePatches(es, [{ id: 'a', scale: [2, 1, 0.5] }]));
    near((out[0] as ReturnType<typeof box>).shape.size, [2, 2, 1.5]);
  });
});

describe('pivot', () => {
  it('rotating (1,0,0) 90° about the y axis through the origin gives (0,0,-1)', () => {
    near(rotatePointAboutAxis([1, 0, 0], [0, 0, 0], [0, 1, 0], Math.PI / 2), [0, 0, -1]);
    near(rotatePointAboutAxis([2, 0, 0], [1, 0, 0], [0, 1, 0], Math.PI), [0, 0, 0]);
  });

  const pair = () => [box('a', [0, 0, 0]), box('b', [4, 0, 0])];

  it('about the selection centre the pair swaps sides and each turns by the angle', () => {
    const es = pair();
    const out = apply(
      es,
      rotateAboutPatches(es, ['a', 'b'], {
        axis: [0, 1, 0],
        angle: Math.PI,
        pivot: { mode: 'centre', cursor: [0, 0, 0] },
      }),
    );
    near(pos(out, 'a'), [4, 0, 0]);
    near(pos(out, 'b'), [0, 0, 0]);
    near(qrot((out[0] as ReturnType<typeof box>).rotation, [1, 0, 0]), [-1, 0, 0]);
  });

  it('about the 3D cursor', () => {
    const es = pair();
    const out = apply(
      es,
      rotateAboutPatches(es, ['b'], {
        axis: [0, 1, 0],
        angle: Math.PI / 2,
        pivot: { mode: 'cursor', cursor: [2, 0, 0] },
      }),
    );
    near(pos(out, 'b'), [2, 0, -2]);
  });

  it('individual origins: positions stay, orientations turn', () => {
    const es = pair();
    const out = apply(
      es,
      rotateAboutPatches(es, ['a', 'b'], {
        axis: [0, 0, 1],
        angle: Math.PI / 2,
        pivot: { mode: 'origins', cursor: [0, 0, 0] },
      }),
    );
    near(pos(out, 'a'), [0, 0, 0]);
    near(pos(out, 'b'), [4, 0, 0]);
    near(qrot((out[1] as ReturnType<typeof box>).rotation, [1, 0, 0]), [0, 1, 0]);
  });

  it('arbitrary axis, local space follows the active object frame', () => {
    const tilted = box('t', [0, 0, 0], [1, 1, 1], { rotation: qfromAxisAngle([0, 0, 1], Math.PI / 2) });
    const es = [tilted];
    // local X of the tilted box points along world +Y; rotating 90° about it must keep its own local X in place.
    const out = apply(
      es,
      rotateAboutPatches(es, ['t'], {
        axis: [1, 0, 0],
        angle: Math.PI / 2,
        space: 'local',
        pivot: { mode: 'origins', cursor: [0, 0, 0] },
      }),
    );
    near(qrot((out[0] as ReturnType<typeof box>).rotation, [1, 0, 0]), [0, 1, 0]);
    // diagonal axis (1,1,0) by 180° swaps x and y
    const sw = apply(
      [box('p', [2, 0, 0])],
      rotateAboutPatches([box('p', [2, 0, 0])], ['p'], {
        axis: [1, 1, 0],
        angle: Math.PI,
        pivot: { mode: 'cursor', cursor: [0, 0, 0] },
      }),
    );
    near(pos(sw, 'p'), [0, 2, 0]);
  });

  it('scale about the cursor scales offsets and sizes', () => {
    const es = [box('a', [3, 0, 0], [1, 1, 1])];
    const out = apply(
      es,
      scaleAboutPatches(es, ['a'], { factor: [2, 2, 2], pivot: { mode: 'cursor', cursor: [1, 0, 0] } }),
    );
    near(pos(out, 'a'), [5, 0, 0]);
    near((out[0] as ReturnType<typeof box>).shape.size, [2, 2, 2]);
  });

  it('group pivot: set without moving members, later rotation orbits the new pivot', () => {
    const g = createGroup({ id: 'g', position: [0, 0, 0] });
    const es: Entity[] = [
      g,
      box('m1', [2, 0, 0], [2, 2, 2], { parent: 'g' }),
      box('m2', [4, 0, 0], [2, 2, 2], { parent: 'g' }),
    ];
    const p = groupPivotPatches(es, 'g', 'bottom');
    expect(p).toHaveLength(1);
    const moved = apply(es, p);
    near(pos(moved, 'g'), [3, -1, 0]);
    near(pos(moved, 'm1'), [2, 0, 0]); // members untouched
    const turned = apply(
      moved,
      groupTransformPatches(moved, 'g', { position: [3, -1, 0], rotation: qfromAxisAngle([0, 1, 0], Math.PI) }),
    );
    near(pos(turned, 'm1'), [4, 0, 0]);
    near(pos(turned, 'm2'), [2, 0, 0]);
    near(pos(apply(es, groupPivotPatches(es, 'g', 'centre')), 'g'), [3, 0, 0]);
    near(pos(apply(es, groupPivotPatches(es, 'g', 'cursor', [9, 8, 7])), 'g'), [9, 8, 7]);
    expect(setGroupPivotPatches(es, 'm1', { position: [0, 0, 0] })).toEqual([]);
  });
});

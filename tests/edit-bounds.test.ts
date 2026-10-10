import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, type Vec3 } from '../src/core/math';
import { createBody, createGroup, createLight, createPath, createSoft } from '../src/model/factory';
import { makeShapeSpec } from '../src/model/shapeRegistry';
import { makePart } from '../src/model/compound';
import { aabbCentre, aabbSize, entityBounds, selectionBounds, selectionCentre } from '../src/model/edit/bounds';

const box = (id: string, position: Vec3, size: Vec3, over = {}) =>
  createBody({ id, shape: makeShapeSpec('box', size), position, ...over });
const near = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

describe('edit/bounds', () => {
  it('axis-aligned box: centre ± half size', () => {
    const b = entityBounds([box('a', [1, 2, 3], [2, 4, 6])], 'a')!;
    near(b.min, [0, 0, 0]);
    near(b.max, [2, 4, 6]);
  });

  it('box rotated 45° about Y has a half-diagonal footprint', () => {
    const e = box('a', [0, 0, 0], [2, 1, 2], { rotation: qfromAxisAngle([0, 1, 0], Math.PI / 4) });
    near(aabbSize(entityBounds([e], 'a')!), [2 * Math.SQRT2, 1, 2 * Math.SQRT2]);
  });

  it('sphere, upright and tilted cylinder (analytic support)', () => {
    const sph = createBody({ id: 's', shape: makeShapeSpec('sphere', [2, 2, 2]), position: [0, 5, 0] });
    near(entityBounds([sph], 's')!.min, [-1, 4, -1]);
    const cyl = createBody({
      id: 'c',
      shape: makeShapeSpec('cylinder', [1, 4, 1]),
      rotation: qfromAxisAngle([0, 0, 1], Math.PI / 2),
    });
    near(aabbSize(entityBounds([cyl], 'c')!), [4, 1, 1]);
    const tilt = createBody({
      id: 't',
      shape: makeShapeSpec('cylinder', [1, 4, 1]),
      rotation: qfromAxisAngle([0, 0, 1], Math.PI / 4),
    });
    const h = 2 * Math.SQRT1_2 + 0.5 * Math.SQRT1_2;
    near(aabbSize(entityBounds([tilt], 't')!), [2 * h, 2 * h, 1]);
  });

  it('cone: apex up, base below', () => {
    const cone = createBody({ id: 'k', shape: makeShapeSpec('cone', [2, 3, 2]) });
    const b = entityBounds([cone], 'k')!;
    near(b.min, [-1, -1.5, -1]);
    near(b.max, [1, 1.5, 1]);
  });

  it('compound body is the union of its parts', () => {
    const e = createBody({
      id: 'p',
      shape: makeShapeSpec('box', [1, 1, 1]),
      parts: [
        makePart({ shape: { type: 'box', size: [1, 1, 1] }, position: [-2, 0, 0] }),
        makePart({ shape: { type: 'box', size: [1, 1, 1] }, position: [3, 0, 0] }),
      ],
    });
    const b = entityBounds([e], 'p')!;
    expect(b.min[0]).toBeCloseTo(-2.5);
    expect(b.max[0]).toBeCloseTo(3.5);
  });

  it('group = union of descendants; selection bounds ignores members of a selected group', () => {
    const g = createGroup({ id: 'g', position: [0, 0, 0] });
    const a = box('a', [0, 0, 0], [2, 2, 2], { parent: 'g' });
    const b = box('b', [10, 0, 0], [2, 2, 2], { parent: 'g' });
    const all = [g, a, b];
    const gb = entityBounds(all, 'g')!;
    near(gb.min, [-1, -1, -1]);
    near(gb.max, [11, 1, 1]);
    near(selectionBounds(all, ['g', 'a'])!.max, [11, 1, 1]);
    near(aabbCentre(gb), [5, 0, 0]);
  });

  it('soft body, light and path', () => {
    const jelly = createSoft('jelly', { id: 'j', position: [0, 1, 0], size: [2, 2, 2] });
    near(entityBounds([jelly], 'j')!.max, [1, 2, 1]);
    const l = createLight('point', { id: 'l', position: [1, 2, 3] });
    near(entityBounds([l], 'l')!.min, [1, 2, 3]);
    const p = createPath({
      id: 'pa',
      position: [0, 0, 0],
      points: [
        [0, 0, 0],
        [4, 1, 0],
      ],
    });
    near(entityBounds([p], 'pa')!.max, [4, 1, 0]);
  });

  it('selection centre: median of origins vs bounds centre', () => {
    const all = [box('a', [0, 0, 0], [1, 1, 1]), box('b', [1, 0, 0], [1, 1, 1]), box('c', [8, 0, 0], [2, 1, 1])];
    near(selectionCentre(all, ['a', 'b', 'c'])!, [3, 0, 0]);
    near(selectionCentre(all, ['a', 'b', 'c'], 'bounds')!, [4.25, 0, 0]);
    expect(selectionCentre(all, [])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { createBody } from '../src/model/factory';
import { defaultSize, normalizeSize, shapeVolume } from '../src/model/shapes';
import type { ShapeType } from '../src/model/types';
import { worldOf } from './helpers';

const TYPES: ShapeType[] = ['box', 'sphere', 'cylinder', 'capsule', 'cone', 'wedge', 'prism', 'icosahedron'];

describe('shape volumes', () => {
  it('analytic volume × density matches the engine-integrated mass for every shape', async () => {
    for (const type of TYPES) {
      const body = createBody({ shape: { type, size: defaultSize(type) }, position: [0, 5, 0], material: { preset: 'custom', density: 1000 } });
      const w = await worldOf([body]);
      const mass = w.builtInfo().mass[body.id];
      const expected = shapeVolume(body.shape) * 1000;
      expect(Math.abs(mass - expected) / expected, `${type}: engine ${mass.toFixed(2)} kg vs analytic ${expected.toFixed(2)} kg`).toBeLessThan(0.02);
    }
  });

  it('keeps round shapes round when resized', () => {
    expect(normalizeSize('sphere', [2, 1, 1], [1, 1, 1])).toEqual([2, 2, 2]);
    expect(normalizeSize('cylinder', [1, 3, 2], [1, 3, 1])[0]).toBe(normalizeSize('cylinder', [1, 3, 2], [1, 3, 1])[2]);
    const cap = normalizeSize('capsule', [1, 0.2, 1]);
    expect(cap[1]).toBeGreaterThanOrEqual(cap[0]); // never shorter than a sphere
  });
});

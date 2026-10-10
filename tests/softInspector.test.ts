/** Pure helpers of the soft-body inspector sections (package SF). */
import { describe, expect, it } from 'vitest';
import { createSoft } from '../src/model/factory';
import { softWarnings } from '../src/model/softBudget';
import { softYoungModulus } from '../src/model/softMaterial';
import {
  loadCarried,
  meshShapeOptions,
  particleCaption,
  pascalToKPa,
  stiffnessForKPa,
  tyreSize,
  warningSignature,
  workingPressureHint,
} from '../src/ui/inspector/softSfHelpers';

describe('Young modulus field', () => {
  it('typing a modulus sets the stiffness that gives (about) that modulus', () => {
    const jelly = createSoft('jelly', { stiffness: 20 });
    const target = pascalToKPa(softYoungModulus(jelly)) * 2;
    const f = stiffnessForKPa(jelly, target);
    const back = pascalToKPa(softYoungModulus({ ...jelly, stiffness: f }));
    expect(back / target).toBeGreaterThan(0.97);
    expect(back / target).toBeLessThan(1.03);
    // E scales with f², so doubling E raises f by sqrt(2)
    expect(f / 20).toBeCloseTo(Math.SQRT2, 1);
  });
  it('clamps to the stiffness range', () => {
    const jelly = createSoft('jelly');
    expect(stiffnessForKPa(jelly, 1e12)).toBe(400);
    expect(stiffnessForKPa(jelly, 1e-6)).toBe(3);
  });
});

describe('mesh source shapes', () => {
  it('lists only shapes that produce a surface, with label and icon', () => {
    const opts = meshShapeOptions();
    const ids = opts.map((o) => o.id);
    expect(ids).toContain('sphere');
    expect(ids).toContain('box');
    for (const o of opts) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('fastening load', () => {
  it('is m·g for dynamic bodies and none for fixed ones', () => {
    expect(loadCarried(3, true, 9.81)).toBeCloseTo(29.43, 5);
    expect(loadCarried(3, false, 9.81)).toBeNull();
    expect(loadCarried(0, true, 9.81)).toBeNull();
  });
});

describe('tyre hints', () => {
  it('reports under-inflation, soft rubber and a working state consistently with the stability warning', () => {
    const base = createSoft('tyre', { pneumatic: true });
    for (const [vf, k] of [
      [1.0, 400],
      [1.3, 100],
      [1.3, 400],
      [1.8, 400],
    ] as const) {
      const t = { ...base, volumeFactor: vf, stiffness: k };
      const hint = workingPressureHint(t);
      const warned = softWarnings(t, { gravity: 9.81, attachedMass: 0 }).some((w) => w.id === 'tyre-soft');
      if (vf === 1.8) expect(hint.ok).toBe(false);
      else expect(hint.ok).toBe(!warned);
    }
    expect(workingPressureHint({ pneumatic: false, volumeFactor: 1, stiffness: 10 }).ok).toBe(true);
  });
  it('clamps tyre dimensions', () => {
    expect(tyreSize([0.8, 0.26, 0.2], 1, 0.01)[1]).toBe(0.08);
    expect(tyreSize([0.8, 0.26, 0.2], 0, 1)[0]).toBe(1);
  });
});

describe('captions', () => {
  it('flags heavy bodies and builds a stable warning signature', () => {
    expect(particleCaption(100)).toBe('≈ 100 particles');
    expect(particleCaption(2000)).toContain('heavy');
    expect(particleCaption(4000)).toContain('far too heavy');
    expect(warningSignature([{ id: 'a', message: 'x' }])).toBe('a:x');
    expect(warningSignature([])).toBe('');
  });
});

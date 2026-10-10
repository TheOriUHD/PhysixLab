import { describe, expect, it } from 'vitest';
import { JOINT_TYPE_LABELS } from '../src/model/factory';
import {
  AXIS_B_TYPES,
  AXIS_TYPES,
  COUPLING_TYPES,
  defaultParams,
  INDEPENDENT_ANCHOR_TYPES,
  JT_A_TYPES,
  sanitizeParams,
} from '../src/model/jointParams';
import type { JointType } from '../src/model/types';

describe('sanitizeParams', () => {
  it('turns garbage into the defaults', () => {
    for (const raw of [undefined, null, 5, 'x', [], {}]) expect(sanitizeParams(raw)).toEqual(defaultParams());
  });
  it('keeps valid values and clamps the rest', () => {
    const p = sanitizeParams({
      swing: 99,
      ratio: -3,
      reverse: 'yes',
      refOffset: 0.5,
      refLocked: true,
      pulleyA: [1, 2, 3],
      pulleyB: [1, 2],
      pitch: 0,
      dof: [{ mode: 'limited', min: -1, max: 2, stiffness: -5 }, 'junk'],
    });
    expect(p.swing).toBeCloseTo(Math.PI);
    expect(p.ratio).toBeGreaterThan(0);
    expect(p.reverse).toBe(defaultParams().reverse);
    expect(p.refOffset).toBe(0.5);
    expect(p.refLocked).toBe(true);
    expect(p.pulleyA).toEqual([1, 2, 3]);
    expect(p.pulleyB).toEqual(defaultParams().pulleyB);
    expect(p.pitch).not.toBe(0);
    expect(p.dof).toHaveLength(6);
    expect(p.dof[0]).toMatchObject({ mode: 'limited', min: -1, max: 2, stiffness: 0 });
    expect(p.dof[1].mode).toBe('locked');
  });
  it('round-trips through JSON', () => {
    const p = defaultParams();
    p.dof[2].mode = 'free';
    expect(sanitizeParams(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});

describe('per-type facts', () => {
  const all = Object.keys(JOINT_TYPE_LABELS) as JointType[];
  it('only name real types', () => {
    for (const list of [INDEPENDENT_ANCHOR_TYPES, COUPLING_TYPES, AXIS_TYPES, AXIS_B_TYPES, JT_A_TYPES])
      for (const t of list) expect(all).toContain(t);
  });
  it('are consistent with each other', () => {
    for (const t of COUPLING_TYPES) expect(INDEPENDENT_ANCHOR_TYPES).toContain(t);
    for (const t of AXIS_B_TYPES) expect(AXIS_TYPES).toContain(t);
    expect(JT_A_TYPES).toHaveLength(10);
  });
});

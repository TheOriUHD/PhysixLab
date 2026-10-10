import { describe, expect, it } from 'vitest';
import { qfromAxisAngle } from '../src/core/math';
import { JOINT_TYPE_LABELS, createJoint } from '../src/model/factory';
import {
  anchorBFromGeometry,
  convertJoint,
  convertibleTo,
  JOINT_GROUPS,
  jointGroupTypes,
} from '../src/model/jointConvert';
import type { JointEntity, JointType } from '../src/model/types';

const mk = (type: JointType, extra: Partial<JointEntity> = {}) =>
  createJoint({ type, bodyA: 'a', bodyB: 'b', anchorA: [0.1, 0.2, 0.3], axis: [0, 1, 0], ...extra });
const apply = (j: JointEntity, to: JointType, o = {}) => ({ ...j, ...convertJoint(j, to, o) });

describe('picker groups', () => {
  it('list every joint type exactly once', () => {
    const all = jointGroupTypes();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual((Object.keys(JOINT_TYPE_LABELS) as JointType[]).sort());
    expect(JOINT_GROUPS.map((g) => g.label)).toEqual([
      'Rigid & flexible',
      'Rotating',
      'Linear',
      'Free-form',
      'Elastic',
      'Mechanisms',
    ]);
  });
});

describe('convertibleTo', () => {
  it('lists every type and marks the current one', () => {
    const list = convertibleTo(mk('hinge'));
    expect(list).toHaveLength(Object.keys(JOINT_TYPE_LABELS).length);
    expect(list.find((t) => t.type === 'hinge')).toMatchObject({ ok: false });
    expect(list.find((t) => t.type === 'slider')).toMatchObject({ ok: true });
  });
  it('coupling types need two bodies', () => {
    const list = convertibleTo({ type: 'hinge', bodyA: null, bodyB: 'b' });
    for (const t of ['pulley', 'rack', 'gear', 'belt'] as const) {
      const e = list.find((x) => x.type === t)!;
      expect(e.ok).toBe(false);
      expect(e.reason).toMatch(/two bodies/);
    }
    expect(list.find((x) => x.type === 'winch')!.ok).toBe(true);
    expect(convertibleTo(mk('hinge')).every((t) => t.type === 'hinge' || t.ok)).toBe(true);
  });
});

describe('convertJoint', () => {
  it('is empty for the same type and never touches bodies, anchors or unknown fields', () => {
    const j = { ...mk('hinge'), breakForce: 7 } as JointEntity;
    expect(convertJoint(j, 'hinge')).toEqual({});
    const patch = convertJoint(j, 'ball');
    for (const k of ['bodyA', 'bodyB', 'anchorA', 'id', 'axis', 'breakForce']) expect(patch).not.toHaveProperty(k);
    const out = apply(j, 'ball') as JointEntity & { breakForce: number };
    expect(out.breakForce).toBe(7);
    expect(out.anchorA).toEqual(j.anchorA);
    expect(out.bodyA).toBe('a');
    expect(out.axis).toEqual([0, 1, 0]);
  });

  it('renames only joints still named after their type', () => {
    expect(convertJoint(mk('hinge', { name: 'Hinge' }), 'slider').name).toBe('Slider');
    expect(convertJoint(mk('hinge', { name: 'Hinge 3' }), 'slider').name).toBe('Slider 3');
    expect(convertJoint(mk('hinge', { name: 'Door' }), 'slider')).not.toHaveProperty('name');
  });

  it('hinge <-> slider keeps the motor mode, keys and the enabled flag; the units reset', () => {
    const j = mk('hinge');
    j.limit = { enabled: true, min: -1, max: 2 };
    j.motor = { ...j.motor, mode: 'velocity', keyPos: 'KeyA', targetPosition: 1.2 };
    const s = apply(j, 'slider');
    expect(s.type).toBe('slider');
    expect(s.limit).toEqual({ enabled: true, min: -0.5, max: 0.5 });
    expect(s.motor).toMatchObject({ mode: 'velocity', keyPos: 'KeyA', targetPosition: 0 });
    expect(s.axis).toEqual([0, 1, 0]);
    // hinge -> universal keeps the limit untouched
    expect(apply(j, 'universal').limit).toEqual(j.limit);
  });

  it('spring <-> rope carry the length', () => {
    const sp = mk('spring');
    sp.spring = { ...sp.spring, restLength: 1.7 };
    expect(apply(sp, 'rope').ropeLength).toBeCloseTo(1.7);
    const rp = mk('rope');
    rp.ropeLength = 3.2;
    expect(apply(rp, 'spring').spring.restLength).toBeCloseTo(3.2);
    // a measured distance wins when the source has no length of its own
    expect(apply(mk('ball'), 'rope', { distance: 2.5 }).ropeLength).toBeCloseTo(2.5);
    expect(apply(mk('fixed'), 'spring', { distance: 0.8 }).spring.restLength).toBeCloseTo(0.8);
  });

  it('independent-anchor targets take the resolved end B only from types that derive it', () => {
    expect(apply(mk('hinge'), 'gear', { anchorB: [1, 2, 3] }).anchorB).toEqual([1, 2, 3]);
    expect(apply(mk('hinge'), 'ball', { anchorB: [1, 2, 3] }).anchorB).toEqual(mk('hinge').anchorB);
    const rope = mk('rope', { anchorB: [4, 5, 6] });
    expect(apply(rope, 'pulley', { anchorB: [1, 2, 3] }).anchorB).toEqual([4, 5, 6]);
  });

  it('gear <-> belt: ratio and radii stay consistent', () => {
    const g = mk('gear');
    g.params = { ...g.params, ratio: 2, radiusB: 0.25 };
    const b = apply(g, 'belt');
    expect(b.params.radiusA / b.params.radiusB).toBeCloseTo(2);
    const back = apply(b, 'gear');
    expect(back.params.ratio).toBeCloseTo(2);
  });

  it('winch cannot keep a position motor', () => {
    const j = mk('rope');
    j.motor = { ...j.motor, mode: 'position' };
    expect(apply(j, 'winch').motor.mode).toBe('velocity');
  });

  it('into 6-DOF only the old degrees of freedom stay open', () => {
    const h = mk('hinge');
    h.limit = { enabled: true, min: -0.4, max: 0.9 };
    const d = apply(h, 'sixdof').params.dof;
    expect(d.map((x) => x.mode)).toEqual(['locked', 'locked', 'locked', 'limited', 'locked', 'locked']);
    expect(d[3]).toMatchObject({ min: -0.4, max: 0.9 });
    expect(apply(mk('ball'), 'sixdof').params.dof.map((x) => x.mode)).toEqual([
      'locked',
      'locked',
      'locked',
      'free',
      'free',
      'free',
    ]);
    expect(apply(mk('slider'), 'sixdof').params.dof[0].mode).toBe('free');
    expect(apply(mk('fixed'), 'sixdof').params.dof.every((x) => x.mode === 'locked')).toBe(true);
    // and back: the limited angular X axis becomes the hinge limit
    const six = apply(h, 'sixdof');
    expect(apply(six, 'hinge').limit).toEqual({ enabled: true, min: -0.4, max: 0.9 });
  });

  it('every type converts to every other type that is offered without throwing', () => {
    for (const from of Object.keys(JOINT_TYPE_LABELS) as JointType[])
      for (const t of convertibleTo(mk(from))) {
        if (!t.ok) continue;
        const out = apply(mk(from), t.type);
        expect(out.type).toBe(t.type);
        expect(out.params.dof).toHaveLength(6);
      }
  });
});

describe('anchorBFromGeometry', () => {
  it('expresses the world anchor of A in the frame of B', () => {
    const q = qfromAxisAngle([0, 1, 0], Math.PI / 2);
    const b = anchorBFromGeometry(
      { anchorA: [1, 0, 0] },
      { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      { position: [1, 1, 0], rotation: q },
    );
    // world anchor (1,0,0); relative to B (1,1,0): (0,-1,0), rotated back by -90° about y: stays (0,-1,0)
    expect(b[0]).toBeCloseTo(0);
    expect(b[1]).toBeCloseTo(-1);
    expect(b[2]).toBeCloseTo(0);
    expect(anchorBFromGeometry({ anchorA: [1, 2, 3] }, null, null)).toEqual([1, 2, 3]);
  });
});

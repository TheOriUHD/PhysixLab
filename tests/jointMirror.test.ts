import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, vadd, type Vec3 } from '../src/core/math';
import { Builder } from '../src/model/builder';
import {
  findMirrorPartner,
  isOnPlane,
  MIRROR_PLANES,
  mirrorBody,
  mirrorDir,
  mirrorJoint,
  mirrorPoint,
  mirrorPseudo,
  mirrorRotation,
} from '../src/model/jointMirror';
import { createJoint } from '../src/model/factory';
import type { BodyEntity, JointType } from '../src/model/types';

const near = (a: readonly number[], b: readonly number[], eps = 1e-9) =>
  a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));

function bodies() {
  const b = new Builder('m');
  b.body('A', 'box', [1, 2, 3], [1.5, 2, -0.5], { rotation: qfromAxisAngle([0.3, 0.8, 0.5], 0.7) });
  b.body('B', 'box', [1, 1, 1], [-2, 1, 4], { rotation: qfromAxisAngle([1, 0, 1], -1.1) });
  const doc = b.done();
  return doc.entities.filter((e): e is BodyEntity => e.kind === 'body');
}

const world = (b: BodyEntity | null, v: Vec3): Vec3 => (b ? vadd(b.position, qrot(b.rotation, v)) : v);

for (const axisName of ['x', 'y', 'z'] as const) {
  const pl = { ...MIRROR_PLANES[axisName], offset: 0.25 };
  describe(`mirror across ${axisName} = 0.25`, () => {
    it('reflects points, polar and pseudo vectors', () => {
      const p: Vec3 = [1, 2, 3];
      const m = mirrorPoint(p, pl);
      expect(m[pl.axis]).toBeCloseTo(0.5 - p[pl.axis]);
      expect(mirrorDir(p, pl)[pl.axis]).toBe(-p[pl.axis]);
      expect(mirrorPseudo(p, pl)[pl.axis]).toBe(p[pl.axis]);
      expect(mirrorPoint(m, pl)).toEqual(p);
    });

    it('mirrored bodies: local anchors reflect along the axis and land on the mirrored world point', () => {
      const [A] = bodies();
      const M = mirrorBody(A, pl);
      const local: Vec3 = [0.3, -0.4, 0.7];
      const localM = mirrorDir(local, pl);
      near(world(M, localM), mirrorPoint(world(A, local), pl));
      // the rotation is the reflected frame: R' x = M R M x
      const v: Vec3 = [0.2, 0.9, -0.4];
      near(qrot(mirrorRotation(A.rotation, pl), v), mirrorDir(qrot(A.rotation, mirrorDir(v, pl)), pl));
    });

    const types: JointType[] = ['hinge', 'slider', 'ball', 'fixed', 'universal', 'conetwist', 'sixdof', 'screw'];
    for (const type of types) {
      it(`${type}: both ends mirrored keeps the geometry mirrored`, () => {
        const [A, B] = bodies();
        const j = createJoint({ type, bodyA: A.id, bodyB: B.id, anchorA: [0.2, 0.1, -0.3], axis: [0.6, 0, 0.8] });
        const MA = { ...mirrorBody(A, pl), id: 'a2' };
        const MB = { ...mirrorBody(B, pl), id: 'b2' };
        const m = mirrorJoint(j, pl, { kind: 'copy', body: MA.id }, { kind: 'copy', body: MB.id });
        expect([m.bodyA, m.bodyB]).toEqual(['a2', 'b2']);
        near(world(MA, m.anchorA), mirrorPoint(world(A, j.anchorA), pl));
        const wAxis = qrot(A.rotation, j.axis);
        const wAxisM = qrot(MA.rotation, m.axis);
        if (type === 'slider' || type === 'sixdof') near(wAxisM, mirrorDir(wAxis, pl));
        else near(wAxisM, mirrorPseudo(wAxis, pl));
        expect(m.id).toBe(j.id); // the caller assigns the new id
        expect(m.limit).toEqual(j.limit);
        expect(m.limit).not.toBe(j.limit);
      });
    }

    it('keeps fields of other packages', () => {
      const [A, B] = bodies();
      const j = { ...createJoint({ type: 'hinge', bodyA: A.id, bodyB: B.id, anchorA: [0, 0, 0] }), breakForce: 42 };
      const m = mirrorJoint(j, pl, { kind: 'copy', body: 'x' }, { kind: 'copy', body: 'y' });
      expect((m as unknown as { breakForce: number }).breakForce).toBe(42);
    });

    it('a world-attached end mirrors its world anchor; a kept body keeps its own frame', () => {
      const [A] = bodies();
      const j = createJoint({ type: 'hinge', bodyA: null, bodyB: A.id, anchorA: [1, 2, 3], axis: [0, 1, 0] });
      const m = mirrorJoint(j, pl, { kind: 'world' }, { kind: 'keep', body: A.id, pose: A });
      expect(m.bodyA).toBeNull();
      near(m.anchorA, mirrorPoint([1, 2, 3], pl));
      near(m.axis, mirrorPseudo([0, 1, 0], pl));
      // anchor B on the kept body: world position mirrored
      const jb = createJoint({
        type: 'spring',
        bodyA: null,
        bodyB: A.id,
        anchorA: [0, 3, 0],
        anchorB: [0.1, 0.2, 0.3],
      });
      const mb = mirrorJoint(jb, pl, { kind: 'world' }, { kind: 'keep', body: A.id, pose: A });
      near(world(A, mb.anchorB), mirrorPoint(world(A, jb.anchorB), pl));
    });
  });
}

describe('type-specific mirroring', () => {
  const pl = MIRROR_PLANES.x;
  const [A, B] = bodies();
  const ends = [
    { kind: 'copy', body: 'a' },
    { kind: 'copy', body: 'b' },
  ] as const;

  it('pulley fixed points reflect', () => {
    const j = createJoint({ type: 'pulley', bodyA: A.id, bodyB: B.id, anchorA: [0, 0, 0] });
    j.params = { ...j.params, pulleyA: [1, 5, 2], pulleyB: [3, 5, 2] };
    const m = mirrorJoint(j, pl, ends[0], ends[1]);
    expect(m.params.pulleyA).toEqual([-1, 5, 2]);
    expect(m.params.pulleyB).toEqual([-3, 5, 2]);
  });

  it('screw handedness flips, ratio and radii stay', () => {
    const j = createJoint({ type: 'screw', bodyA: A.id, bodyB: B.id, anchorA: [0, 0, 0] });
    expect(mirrorJoint(j, pl, ends[0], ends[1]).params.pitch).toBeCloseTo(-j.params.pitch);
    const g = createJoint({ type: 'gear', bodyA: A.id, bodyB: B.id, anchorA: [0, 0, 0] });
    const mg = mirrorJoint(g, pl, ends[0], ends[1]);
    expect(mg.params.ratio).toBe(g.params.ratio);
    expect(mg.params.reverse).toBe(g.params.reverse);
  });

  it('rack direction is polar, pinion shaft pseudo', () => {
    const j = createJoint({ type: 'rack', bodyA: A.id, bodyB: B.id, anchorA: [0, 0, 0], axis: [1, 0, 0] });
    j.params = { ...j.params, axisB: [1, 0, 0] };
    const m = mirrorJoint(j, pl, ends[0], ends[1]);
    expect(m.params.axisB).toEqual([-1, 0, 0]);
    expect(m.axis[0]).toBe(1);
  });

  it('6-DOF angular X limits swap and negate', () => {
    const j = createJoint({ type: 'sixdof', bodyA: A.id, bodyB: B.id, anchorA: [0, 0, 0] });
    j.params.dof[3] = { ...j.params.dof[3], mode: 'limited', min: -0.2, max: 0.5, motorVelocity: 2 };
    const m = mirrorJoint(j, pl, ends[0], ends[1]);
    expect(m.params.dof[3]).toMatchObject({ min: -0.5, max: 0.2, motorVelocity: -2 });
    expect(m.params.dof[0]).toEqual(j.params.dof[0]);
    expect(j.params.dof[3].min).toBe(-0.2); // the source is untouched
  });
});

describe('mirror partners', () => {
  it('finds the mirrored copy of a body and recognises bodies on the plane', () => {
    const pl = MIRROR_PLANES.x;
    const [A, B] = bodies();
    const copy = { ...mirrorBody(A, pl), id: 'copy' };
    expect(findMirrorPartner(A, [A, B, copy], pl)?.id).toBe('copy');
    expect(findMirrorPartner(B, [A, B, copy], pl)).toBeUndefined();
    expect(isOnPlane({ position: [0, 3, 1], rotation: [0, 0, 0, 1] }, pl)).toBe(true);
    expect(isOnPlane(A, pl)).toBe(false);
  });
});

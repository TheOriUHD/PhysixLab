import { describe, expect, it } from 'vitest';
import {
  DEG,
  qfromAxisAngle,
  qfromEuler,
  qrot,
  qrotInv,
  vadd,
  vlen,
  vsub,
  type Quat,
  type Vec3,
} from '../src/core/math';
import { makeMeshAsset } from '../src/model/assets';
import { createBody, createJoint, createSoft, createLight, createPath, createGroup } from '../src/model/factory';
import { makePart } from '../src/model/compound';
import { shapeConvexPoints } from '../src/model/shapeRegistry';
import {
  axisPlane,
  findMirrorPairs,
  flipLocal,
  makePlane,
  mirrorCopy,
  mirrorFlip,
  mirrorMeshAsset,
  mirrorRotation,
  reflectPoint,
  shapeSymmetry,
  type MirrorPlane,
} from '../src/model/edit/mirror';
import { decodeMesh } from '../src/model/assets';
import { makeComponent } from '../src/model/componentRegistry';
import type { BodyEntity, Entity, JointEntity, MeshAsset, SoftEntity } from '../src/model/types';
import { isBody, isJoint, isSoft } from '../src/model/types';
import { run, worldOf } from './helpers';

const q = (axis: Vec3, deg: number): Quat => qfromAxisAngle(axis, deg * DEG);

/** World-space vertices of a body's collider hulls (own shape or parts). */
function hull(b: BodyEntity): Vec3[] {
  const out: Vec3[] = [];
  const add = (spec: BodyEntity['shape'], pos: Vec3, rot: Quat) => {
    const pts = shapeConvexPoints(spec);
    if (!pts) throw new Error(`no points for ${spec.type}`);
    for (const p of pts) out.push(vadd(b.position, qrot(b.rotation, vadd(pos, qrot(rot, p)))));
  };
  if (b.parts?.length) for (const part of b.parts) add(part.shape, part.position, part.rotation);
  else add(b.shape, [0, 0, 0], [0, 0, 0, 1]);
  return out;
}

/** Every point of `a` has a partner in `b` within `tol` (and vice versa). */
function sameSet(a: Vec3[], b: Vec3[], tol = 1e-6): boolean {
  const has = (set: Vec3[], p: Vec3) => set.some((r) => vlen(vsub(r, p)) < tol);
  return a.every((p) => has(b, p)) && b.every((p) => has(a, p));
}

const PLANES: [string, MirrorPlane][] = [
  ['x = 0', axisPlane(0)],
  ['y = 0.7', axisPlane(1, 0.7)],
  ['z = -2', axisPlane(2, -2)],
  ['oblique', makePlane([0.5, 0.2, -1], [1, 2, -0.7])],
];

describe('mirror geometry — the mirrored body is the mirror image of the original collider set', () => {
  it('a box rotated 30° about Y mirrored across x = 0 has the exactly mirrored corners', () => {
    const box = createBody({
      shape: { type: 'box', size: [1, 0.5, 2] },
      position: [3, 1, 0.5],
      rotation: q([0, 1, 0], 30),
    });
    const m = mirrorCopy([box], [box.id], axisPlane(0)).entities[0] as BodyEntity;
    expect(m.position[0]).toBeCloseTo(-3, 12);
    expect(m.position[1]).toBeCloseTo(1, 12);
    // Rotated by -30° about Y: the mirror image of a +30° yaw.
    const sign = m.rotation[3] < 0 ? -1 : 1; // q and -q are the same rotation
    expect(sign * m.rotation[1]).toBeCloseTo(Math.sin((-15 * Math.PI) / 180), 9);
    const want = hull(box).map((p) => reflectPoint(axisPlane(0), p));
    expect(sameSet(hull(m), want)).toBe(true);
    // The AABB mirrors exactly: x-range negated, y/z-range unchanged.
    const range = (pts: Vec3[], k: number) => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))];
    const [x0, x1] = range(hull(box), 0);
    expect(range(hull(m), 0)[0]).toBeCloseTo(-x1, 9);
    expect(range(hull(m), 0)[1]).toBeCloseTo(-x0, 9);
    expect(range(hull(m), 2)[0]).toBeCloseTo(range(hull(box), 2)[0], 9);
  });

  for (const [name, plane] of PLANES) {
    for (const [type, params] of [
      ['box', undefined],
      ['wedge', undefined],
      ['prism', { sides: 5 }],
      ['prism', { sides: 6 }],
      ['icosahedron', undefined],
    ] as const) {
      it(`${type}${params ? ` (${params.sides} sides)` : ''} about ${name}: hull is the reflected hull`, () => {
        const b = createBody({
          shape: { type, size: [1.2, 0.7, 1.9], ...(params ? { params } : {}) },
          position: [1.3, 0.8, -0.4],
          rotation: qfromEuler([0.4, -1.1, 0.7]),
        });
        const m = mirrorCopy([b], [b.id], plane).entities[0] as BodyEntity;
        expect(
          sameSet(
            hull(m),
            hull(b).map((p) => reflectPoint(plane, p)),
          ),
        ).toBe(true);
      });
    }
  }

  it('a chiral compound (wedge + box parts, off-centre, rotated) mirrors exactly through part positions/rotations', () => {
    const b = createBody({
      shape: { type: 'box', size: [2, 1, 2] },
      position: [1, 2, 3],
      rotation: qfromEuler([0.3, 0.5, -0.2]),
      parts: [
        makePart({
          shape: { type: 'wedge', size: [0.5, 0.6, 1.2] },
          position: [0.7, 0.1, -0.3],
          rotation: qfromEuler([0.2, 0.9, 0.1]),
        }),
        makePart({
          shape: { type: 'box', size: [0.3, 0.3, 0.9] },
          position: [-0.4, 0.3, 0.6],
          rotation: qfromEuler([0, 0.4, 0.5]),
        }),
        makePart({ shape: { type: 'prism', size: [0.6, 0.4, 0.6], params: { sides: 5 } }, position: [0, -0.4, 0.2] }),
      ],
    });
    for (const [, plane] of PLANES) {
      const m = mirrorCopy([b], [b.id], plane).entities[0] as BodyEntity;
      expect(
        sameSet(
          hull(m),
          hull(b).map((p) => reflectPoint(plane, p)),
        ),
      ).toBe(true);
    }
  });

  it('the symmetry axes found match the shapes (wedge: x only; even prism: x,y,z; odd prism: x,y; cone: x,z)', () => {
    expect(shapeSymmetry({ type: 'wedge', size: [1, 1, 1] }).axes).toEqual([0]);
    expect(shapeSymmetry({ type: 'prism', size: [1, 1, 1], params: { sides: 6 } }).axes).toEqual([0, 1, 2]);
    expect(shapeSymmetry({ type: 'prism', size: [1, 1, 1], params: { sides: 5 } }).axes).toEqual([0, 1]);
    expect(shapeSymmetry({ type: 'cone', size: [1, 1, 1] }).axes).toEqual([0, 2]);
    expect(shapeSymmetry({ type: 'box', size: [1, 2, 3] }).axes).toEqual([0, 1, 2]);
  });

  it('a cone keeps its apex direction mirrored (cone: apex at local +Y)', () => {
    const c = createBody({
      shape: { type: 'cone', size: [1, 2, 1] },
      position: [2, 1, 1],
      rotation: qfromEuler([0.6, 0.2, 0.9]),
    });
    for (const [, plane] of PLANES) {
      const m = mirrorCopy([c], [c.id], plane).entities[0] as BodyEntity;
      const apex = (b: BodyEntity) => vadd(b.position, qrot(b.rotation, [0, 1, 0]));
      expect(vlen(vsub(apex(m), reflectPoint(plane, apex(c))))).toBeLessThan(1e-9);
    }
  });

  it('mirroring twice with the same flip returns the original pose', () => {
    const plane = makePlane([0.3, 0, 0], [0.2, 1, 0.4]);
    const r = qfromEuler([0.4, 1.2, -0.5]);
    for (const i of [0, 1, 2] as const) {
      const twice = mirrorRotation(plane, mirrorRotation(plane, r, i), i);
      const d = Math.abs(twice[0] * r[0] + twice[1] * r[1] + twice[2] * r[2] + twice[3] * r[3]);
      expect(d).toBeCloseTo(1, 9);
    }
  });

  it('velocity reflects as a polar vector, angular velocity as an axial one', () => {
    const b = createBody({ position: [1, 1, 1], velocity: [2, 3, 4], angularVelocity: [5, 6, 7] });
    const m = mirrorCopy([b], [b.id], axisPlane(0)).entities[0] as BodyEntity;
    expect(m.velocity).toEqual([-2, 3, 4]);
    expect(m.angularVelocity).toEqual([5, -6, -7]);
  });

  it('thrust force/torque and the centre-of-mass override follow the local flip', () => {
    const b = createBody({
      position: [1, 1, 1],
      thrust: { force: [1, 2, 3], torque: [4, 5, 6], mode: 'always', key: '' },
      comOverride: [0.1, 0.2, 0.3],
    });
    const m = mirrorCopy([b], [b.id], axisPlane(0)).entities[0] as BodyEntity;
    // identity rotation, plane x: flip axis x
    expect(m.thrust?.force).toEqual([-1, 2, 3]);
    expect(m.thrust?.torque).toEqual([4, -5, -6]);
    expect(m.comOverride).toEqual([-0.1, 0.2, 0.3]);
  });

  it('components with directions are mirrored (constant force in world axes), and get new ids', () => {
    const b = createBody({ position: [1, 1, 1] });
    b.components = [makeComponent('constantForce', { force: [3, 4, 5], torque: [1, 2, 3], space: 'world' })];
    const m = mirrorCopy([b], [b.id], axisPlane(0)).entities[0] as BodyEntity;
    expect(m.components[0].params.force).toEqual([-3, 4, 5]);
    expect(m.components[0].params.torque).toEqual([1, -2, -3]);
    expect(m.components[0].id).not.toBe(b.components[0].id);
  });
});

describe('mirror of soft bodies, lights, paths, groups', () => {
  it('cable pinned at one end: the same particle is pinned (its world position is the mirror image)', () => {
    const s = createSoft('cable', {
      position: [2, 3, 1],
      rotation: qfromEuler([0.2, 0.7, -0.4]),
      size: [3, 0.1, 0.1],
      pin: 'one-end',
    });
    for (const [, plane] of PLANES) {
      const m = mirrorCopy([s], [s.id], plane).entities[0] as SoftEntity;
      expect(m.pin).toBe('one-end');
      const end = (e: SoftEntity, sign: number) => vadd(e.position, qrot(e.rotation, [sign * e.size[0] * 0.5, 0, 0]));
      // The pinned particle sits at local x = -L/2; its image is the mirror's pinned particle.
      expect(vlen(vsub(end(m, -1), reflectPoint(plane, end(s, -1))))).toBeLessThan(1e-9);
      expect(vlen(vsub(end(m, 1), reflectPoint(plane, end(s, 1))))).toBeLessThan(1e-9);
    }
  });

  it('cloth pinned along its back edge keeps that edge (corners pins swap with the lattice)', () => {
    for (const pin of ['edge', 'corners', 'corners4'] as const) {
      const s = createSoft('cloth', {
        position: [2, 3, 1],
        rotation: qfromEuler([0.9, 0.3, 0.1]),
        size: [2, 0.1, 1.5],
        pin,
      });
      for (const [, plane] of PLANES) {
        const m = mirrorCopy([s], [s.id], plane).entities[0] as SoftEntity;
        // Pinned lattice points (local): the back edge z = -d/2, for x in {-w/2, +w/2} (corners) or the midpoint.
        const back: Vec3[] = [
          [-1, 0, -0.75],
          [1, 0, -0.75],
        ];
        const pts: Vec3[] =
          pin === 'edge' ? [...back, [0, 0, -0.75]] : pin === 'corners' ? back : [...back, [-1, 0, 0.75], [1, 0, 0.75]];
        const world = (e: SoftEntity, p: Vec3) => vadd(e.position, qrot(e.rotation, p));
        const orig = pts.map((p) => reflectPoint(plane, world(s, p)));
        const mine = pts.map((p) => world(m, p));
        expect(sameSet(orig, mine, 1e-9)).toBe(true);
      }
    }
  });

  it('a spot light keeps pointing at the mirrored target; a path and a group mirror their points', () => {
    const light = createLight('spot', { position: [2, 4, 1], rotation: qfromEuler([-1.2, 0.5, 0.2]) });
    const path = createPath({
      position: [1, 0, 1],
      rotation: qfromEuler([0.1, 0.8, 0.3]),
      points: [
        [0, 0, 0],
        [1, 0.5, 0],
        [2, 0, 1.5],
      ],
    });
    const group = createGroup({ position: [3, 0, 0] });
    const plane = makePlane([0, 0, 0], [1, 0.3, 0]);
    const res = mirrorCopy([light, path, group], [light.id, path.id, group.id], plane);
    const [ml, mp] = res.entities.filter((e) => e.kind === 'light' || e.kind === 'path') as [typeof light, typeof path];
    const dir = (r: Quat): Vec3 => qrot(r, [0, 0, -1]);
    const want = reflectPoint(plane, vadd(light.position, dir(light.rotation)));
    expect(vlen(vsub(vadd(ml.position, dir(ml.rotation)), want))).toBeLessThan(1e-9);
    mp.points.forEach((p, k) => {
      const w = vadd(mp.position, qrot(mp.rotation, p));
      const o = reflectPoint(plane, vadd(path.position, qrot(path.rotation, path.points[k])));
      expect(vlen(vsub(w, o))).toBeLessThan(1e-9);
    });
  });
});

describe('mirror of joints', () => {
  function pendulum(): { entities: Entity[]; bob: BodyEntity; arm: BodyEntity } {
    const arm = createBody({
      shape: { type: 'box', size: [0.4, 0.4, 0.4] },
      position: [1.5, 6, 0.5],
      bodyType: 'static',
    });
    const bob = createBody({
      shape: { type: 'box', size: [0.5, 0.3, 0.3] },
      position: [3, 6, 0.5],
      rotation: qfromEuler([0.2, 0.5, 0.1]),
      linearDamping: 0,
      angularDamping: 0,
      canSleep: false,
    });
    // A tilted hinge axis (not along a coordinate axis) makes the axial rule observable.
    const axis = [0.25, 0.1, 1].map((v) => v / Math.hypot(0.25, 0.1, 1)) as Vec3;
    const j = createJoint({
      type: 'hinge',
      bodyA: arm.id,
      bodyB: bob.id,
      anchorA: [0.75, 0, 0] as Vec3,
      // The same world point as A's anchor, expressed in the (rotated) bob's frame: a consistent starting pose.
      anchorB: qrotInv(bob.rotation, vsub([2.25, 6, 0.5], bob.position)),
      axis: [axis[0], axis[1], axis[2]],
    });
    return { entities: [arm, bob, j], bob, arm };
  }

  it('a hinge axis flips as an axial vector (local x flip: (ax,ay,az) → (ax,-ay,-az))', () => {
    const arm = createBody({ position: [2, 1, 0], bodyType: 'static' });
    const bob = createBody({ position: [3, 1, 0] });
    const j = createJoint({
      type: 'hinge',
      bodyA: arm.id,
      bodyB: bob.id,
      anchorA: [0.5, 0.2, 0],
      anchorB: [-0.5, 0.2, 0],
      axis: [0.3, 0.4, 0.5],
    });
    const res = mirrorCopy([arm, bob, j], [arm.id, bob.id], axisPlane(0));
    const mj = res.entities.find(isJoint) as JointEntity;
    expect(mj.axis).toEqual([0.3, -0.4, -0.5]);
    expect(mj.anchorA).toEqual([-0.5, 0.2, 0]);
    expect(mj.anchorB).toEqual([0.5, 0.2, 0]);
    expect(mj.bodyA).not.toBe(arm.id);
    expect(res.skippedJoints).toBe(0);
    // A slider axis (polar) flips like a direction.
    const s = createJoint({
      type: 'slider',
      bodyA: arm.id,
      bodyB: bob.id,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      axis: [0.3, 0.4, 0.5],
    });
    const ms = mirrorCopy([arm, bob, s], [arm.id, bob.id], axisPlane(0)).entities.find(isJoint) as JointEntity;
    expect(ms.axis).toEqual([-0.3, 0.4, 0.5]);
  });

  it('world-anchored joint ends are reflected in world coordinates', () => {
    const bob = createBody({ position: [3, 1, 0] });
    const j = createJoint({ type: 'spring', bodyA: null, bodyB: bob.id, anchorA: [3, 4, 1], anchorB: [0, 0.5, 0] });
    const plane = axisPlane(0, 1);
    const mj = mirrorCopy([bob, j], [bob.id], plane).entities.find(isJoint) as JointEntity;
    expect(mj.bodyA).toBeNull();
    expect(mj.anchorA).toEqual([-1, 4, 1]);
  });

  it('a joint to a body that is not mirrored is left out of a copy (and reported)', () => {
    const a = createBody({ position: [1, 1, 0] });
    const b = createBody({ position: [3, 1, 0] });
    const j = createJoint({ type: 'ball', bodyA: a.id, bodyB: b.id, anchorA: [0, 0, 0], anchorB: [0, 0, 0] });
    const res = mirrorCopy([a, b, j], [a.id], axisPlane(0));
    expect(res.entities.filter(isJoint)).toHaveLength(0);
    expect(res.skippedJoints).toBe(1);
  });

  // Gravity must itself be mirror-symmetric, so only vertical planes are used with the engine.
  const VERTICAL: [string, MirrorPlane][] = [
    ['x = 0', axisPlane(0)],
    ['z = -2', axisPlane(2, -2)],
    // far enough from the pendulum that the mirror image does not collide with it
    ['oblique vertical', makePlane([-3, 0, -4], [1, 0, -0.7])],
  ];
  for (const [name, plane] of VERTICAL) {
    it(`a mirrored hinged pendulum behaves as the mirror image in the real engine (${name})`, async () => {
      const { entities, bob } = pendulum();
      const res = mirrorCopy(
        entities,
        entities.filter((e) => !isJoint(e)).map((e) => e.id),
        plane,
      );
      const twin = res.entities.find((e) => isBody(e) && e.bodyType === 'dynamic') as BodyEntity;
      const w = await worldOf([...entities, ...res.entities], { gravity: [0, -9.81, 0] });
      let swung = 0;
      for (let k = 0; k < 6; k++) {
        run(w, 0.3);
        const p = w.getPose(bob.id)!;
        const pm = w.getPose(twin.id)!;
        const want = reflectPoint(plane, p.position);
        expect(vlen(vsub(pm.position, want))).toBeLessThan(2e-3);
        // Orientation: the mirrored body's corner points are the images of the original's corners.
        const corner: Vec3 = [0.25, 0.15, -0.15];
        const c0 = vadd(p.position, qrot(p.rotation, corner));
        const c1 = vadd(pm.position, qrot(pm.rotation, flipLocal(corner, res.axes.get(bob.id)!)));
        expect(vlen(vsub(c1, reflectPoint(plane, c0)))).toBeLessThan(2e-3);
        swung = Math.max(swung, vlen(vsub(p.position, bob.position)));
      }
      // The pendulum really moved (the comparison above is not between two parked bodies).
      expect(swung).toBeGreaterThan(1);
    });
  }
});

describe('mirror of a hinge with asymmetric limits and a motor', () => {
  it('the motor turns the mirror image the mirrored way and the limit stops it at the mirrored angle', async () => {
    const arm = createBody({
      shape: { type: 'cylinder', size: [0.3, 0.3, 0.3] },
      position: [2, 3, 0],
      bodyType: 'static',
    });
    const rotor = createBody({
      shape: { type: 'box', size: [1, 0.2, 0.2] },
      position: [2.5, 3, 0],
      linearDamping: 0,
      angularDamping: 0,
      canSleep: false,
    });
    const j = createJoint({
      type: 'hinge',
      bodyA: arm.id,
      bodyB: rotor.id,
      anchorA: [0, 0, 0],
      anchorB: [-0.5, 0, 0],
      axis: [0, 0, 1],
    });
    j.limit = { enabled: true, min: -0.4, max: 0.9 };
    j.motor = { ...j.motor, mode: 'velocity', targetVelocity: 2, damping: 50, maxForce: 500 };
    const list: Entity[] = [arm, rotor, j];
    const plane = axisPlane(0);
    const res = mirrorCopy(list, [arm.id, rotor.id], plane);
    const twin = res.entities.find((e) => isBody(e) && e.bodyType === 'dynamic') as BodyEntity;
    const w = await worldOf([...list, ...res.entities], { gravity: [0, 0, 0] });
    run(w, 1.5);
    const p = w.getPose(rotor.id)!;
    const pm = w.getPose(twin.id)!;
    // The motor drove the rotor up to its upper limit (0.9 rad about +Z): tip at 0.5 m from the pivot.
    const tip = vsub(vadd(p.position, qrot(p.rotation, [0.5, 0, 0])), [2, 3, 0]);
    expect(Math.atan2(tip[1], tip[0])).toBeCloseTo(0.9, 1);
    expect(vlen(vsub(pm.position, reflectPoint(plane, p.position)))).toBeLessThan(2e-3);
  });
});

describe('mirror in place (flip)', () => {
  it('flip twice restores the pose; locked entities stay put', () => {
    const a = createBody({ position: [2, 1, 1], rotation: qfromEuler([0.3, 0.9, 0.2]), velocity: [1, 2, 3] });
    const locked = createBody({ position: [4, 1, 1], locked: true });
    const plane = makePlane([0.2, 0, 0], [1, 0.5, 0.2]);
    const once = mirrorFlip([a, locked], [a.id, locked.id], plane);
    expect(once.skippedLocked).toBe(1);
    expect(once.patches.map(([id]) => id)).toEqual([a.id]);
    const flipped = { ...a, ...once.patches[0][1] } as BodyEntity;
    const twice = mirrorFlip([flipped], [a.id], plane).patches[0][1] as Partial<BodyEntity>;
    const back = { ...flipped, ...twice };
    expect(vlen(vsub(back.position, a.position))).toBeLessThan(1e-9);
    expect(vlen(vsub(back.velocity, a.velocity))).toBeLessThan(1e-9);
    expect(
      Math.abs(
        back.rotation[0] * a.rotation[0] +
          back.rotation[1] * a.rotation[1] +
          back.rotation[2] * a.rotation[2] +
          back.rotation[3] * a.rotation[3],
      ),
    ).toBeCloseTo(1, 9);
  });

  it('flipping a mechanism also mirrors the joint between its bodies, with the same joint id', () => {
    const arm = createBody({ position: [2, 1, 0], bodyType: 'static' });
    const bob = createBody({ position: [3, 1, 0] });
    const j = createJoint({
      type: 'hinge',
      bodyA: arm.id,
      bodyB: bob.id,
      anchorA: [0.5, 0.2, 0],
      anchorB: [-0.5, 0.2, 0],
      axis: [0.3, 0.4, 0.5],
    });
    const res = mirrorFlip([arm, bob, j], [arm.id, bob.id], axisPlane(0));
    const jp = res.patches.find(([id]) => id === j.id)?.[1] as Partial<JointEntity>;
    expect(jp.axis).toEqual([0.3, -0.4, -0.5]);
    expect((res.patches.find(([id]) => id === bob.id)?.[1] as Partial<BodyEntity>).position).toEqual([-3, 1, 0]);
  });
});

describe('mirror pairs', () => {
  it('findMirrorPairs recovers exactly the pairing made by a mirror copy (bodies and joints, with axes)', () => {
    const a = createBody({
      shape: { type: 'wedge', size: [1, 0.6, 2] },
      position: [2, 1, 0.5],
      rotation: qfromEuler([0.1, 0.7, 0.2]),
    });
    const b = createBody({ position: [3.5, 1, 0.5] });
    const j = createJoint({
      type: 'hinge',
      bodyA: a.id,
      bodyB: b.id,
      anchorA: [0.5, 0, 0],
      anchorB: [-0.5, 0, 0],
      axis: [0, 0, 1],
    });
    const all: Entity[] = [a, b, j];
    const plane = axisPlane(0);
    const res = mirrorCopy(all, [a.id, b.id], plane);
    const pairs = findMirrorPairs([...all, ...res.entities], plane);
    for (const [orig, copy] of res.idMap) {
      expect(pairs.get(orig)?.other).toBe(copy);
      expect(pairs.get(copy)?.other).toBe(orig);
    }
    expect(pairs.get(a.id)?.axis).toBe(res.axes.get(a.id));
    // An entity that is its own mirror image (on the plane) has no partner.
    const centre = createBody({ position: [0, 1, 0] });
    expect(findMirrorPairs([centre], plane).size).toBe(0);
  });

  it('does not pair entities of a different shape or with a different orientation', () => {
    const a = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [2, 1, 0] });
    const wrongSize = createBody({ shape: { type: 'box', size: [1, 2, 1] }, position: [-2, 1, 0] });
    expect(findMirrorPairs([a, wrongSize], axisPlane(0)).size).toBe(0);
    const wrongTurn = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      position: [-2, 1, 0],
      rotation: q([0, 1, 0], 20),
    });
    expect(findMirrorPairs([a, wrongTurn], axisPlane(0)).size).toBe(0);
  });
});

describe('mirror of mesh visuals', () => {
  it('negates the vertex axis and reverses the triangle winding', () => {
    const src = makeMeshAsset('tri', {
      positions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      indices: [0, 1, 2],
      normals: [1, 0, 0, 1, 0, 0, 1, 0, 0],
    });
    const asset = { ...src, id: 'm1', hash: 'h', bytes: 10 } as MeshAsset;
    const m = mirrorMeshAsset(asset, 0);
    const d = decodeMesh({ ...m, id: 'm2', hash: 'h2', bytes: 10 } as MeshAsset);
    expect([...d.positions]).toEqual([-1, 2, 3, -4, 5, 6, -7, 8, 9]);
    expect([...d.indices]).toEqual([0, 2, 1]);
    expect([...(d.normals ?? [])]).toEqual([-1, 0, 0, -1, 0, 0, -1, 0, 0]);
  });
});

void isSoft;

/**
 * JT-21: the joint tool's pure geometry (snap candidates, axis choice, per-type defaults, limit presets, connect-all
 * pairing) and the real Editor / SceneStore building joints from it (type-aware creation, chain = one undo step,
 * "Connect all" = one undo step).
 */
import { describe, expect, it } from 'vitest';
import { vdist, vlen, type Quat, type Vec3 } from '../src/core/math';
import {
  bodyTop,
  closestBoxPoints,
  connectPairs,
  findSnap,
  limitFromPreset,
  pickJointAxis,
  radiusAboutAxis,
  snapCandidates,
  typeDefaults,
  worldBox,
  type EndInfo,
} from '../src/model/jointDefaults';
import { makeShapeSpec } from '../src/model/shapeRegistry';
import { SceneStore } from '../src/model/store';
import type { BodyEntity, JointType } from '../src/model/types';
import { Editor } from '../src/app/editor';
import type { SimController } from '../src/app/simController';
import { ChainTracker, connectBodies, jointOptions } from '../src/app/jointTool';
import { DEFAULT_PREFS } from '../src/app/prefs';

const ID: Quat = [0, 0, 0, 1];
const info = (spec: ReturnType<typeof makeShapeSpec> | null, position: Vec3, rotation: Quat = ID): EndInfo => ({
  body: spec ? 'x' : null,
  point: position,
  position,
  rotation,
  shape: spec,
});

describe('snap candidates', () => {
  const box = makeShapeSpec('box', [2, 1, 4]);

  it('offers centre, 6 face centres, 12 edge midpoints and 8 corners of a box', () => {
    const c = snapCandidates(box);
    const n = (k: string) => c.filter((x) => x.kind === k).length;
    expect([n('center'), n('face'), n('edge'), n('vertex')]).toEqual([1, 6, 12, 8]);
  });

  it('snaps a picked point to the nearest candidate in the body frame, rotated and moved', () => {
    // Box turned 90° about Y at (10, 0, 0): its local +X face centre (1,0,0) is at world (10, 0, -1).
    const q: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const hit = findSnap(snapCandidates(box), [10, 0, 0], q, [10.02, 0.1, -0.97], 0.2);
    expect(hit?.kind).toBe('face');
    expect(hit!.world[0]).toBeCloseTo(10, 6);
    expect(hit!.world[2]).toBeCloseTo(-1, 6);
    // its normal is the rotated local +X
    expect(hit!.normal![2]).toBeCloseTo(-1, 6);
  });

  it('prefers the more specific candidate near a corner and returns null outside the tolerance', () => {
    const c = snapCandidates(box);
    const near = findSnap(c, [0, 0, 0], ID, [1.02, 0.52, 2.01], 0.2);
    expect(near?.kind).toBe('vertex');
    expect(near!.world).toEqual([1, 0.5, 2]);
    expect(findSnap(c, [0, 0, 0], ID, [0.5, 0.25, 0.3], 0.1)).toBeNull();
  });

  it('keeps a ball honest: only the centre and the six poles, no corners in the air', () => {
    const c = snapCandidates(makeShapeSpec('sphere', [1, 1, 1]));
    expect(c.filter((x) => x.kind === 'vertex' || x.kind === 'edge')).toHaveLength(0);
    expect(c.filter((x) => x.kind === 'face')).toHaveLength(6);
    for (const x of c) expect(vlen(x.local)).toBeLessThanOrEqual(0.5 + 1e-3);
  });

  it('uses the real hull vertices for a wedge instead of box corners', () => {
    const wedge = makeShapeSpec('wedge');
    const verts = snapCandidates(wedge).filter((x) => x.kind === 'vertex');
    expect(verts.length).toBeGreaterThanOrEqual(5);
    expect(verts.length).toBeLessThan(8); // a wedge has 6 corners, not the box's 8
  });
});

describe('axis choice', () => {
  const n: Vec3 = [0, 0, 2];
  it('auto follows the face normal, except for round bodies with their own axle', () => {
    expect(pickJointAxis({ type: 'hinge', choice: 'auto', normal: n, axial: false })).toEqual([0, 0, 1]);
    expect(pickJointAxis({ type: 'hinge', choice: 'auto', normal: n, axial: true })).toBeUndefined();
    expect(pickJointAxis({ type: 'hinge', choice: 'auto', normal: null, axial: false })).toBeUndefined();
  });
  it('fixed axes, normal, and types without an axis', () => {
    expect(pickJointAxis({ type: 'slider', choice: 'x', normal: n, axial: false })).toEqual([1, 0, 0]);
    expect(pickJointAxis({ type: 'slider', choice: 'normal', normal: n, axial: true })).toEqual([0, 0, 1]);
    expect(pickJointAxis({ type: 'ball', choice: 'x', normal: n, axial: false })).toBeUndefined();
    expect(pickJointAxis({ type: 'spring', choice: 'normal', normal: n, axial: false })).toBeUndefined();
  });
});

describe('limit presets and pairing', () => {
  it('limit presets', () => {
    expect(limitFromPreset('hinge', 'off')).toBeNull();
    const l = limitFromPreset('hinge', 'pm45')!;
    expect(l.enabled).toBe(true);
    expect(l.max).toBeCloseTo(Math.PI / 4, 9);
    expect(limitFromPreset('slider', 'pm0.5')).toMatchObject({ min: -0.5, max: 0.5 });
    expect(limitFromPreset('ball', 'pm45')).toBeNull();
  });

  it('connectPairs: chain, star, all pairs capped at 40', () => {
    expect(connectPairs(4, 'chain').pairs).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(connectPairs(4, 'star').pairs).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    expect(connectPairs(4, 'pairs').pairs).toHaveLength(6);
    const big = connectPairs(12, 'pairs'); // 66 pairs
    expect(big.pairs).toHaveLength(40);
    expect(big.truncated).toBe(true);
  });

  it('closestBoxPoints: gap along one axis, overlap on the others', () => {
    const [pa, pb] = closestBoxPoints({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [3, 0.5, 0], max: [4, 2, 1] });
    expect(pa).toEqual([1, 0.75, 0.5]);
    expect(pb).toEqual([3, 0.75, 0.5]);
  });
});

describe('per-type defaults', () => {
  const crate = makeShapeSpec('box', [1, 1, 1]);
  const wheel = makeShapeSpec('cylinder', [1.2, 0.3, 1.2]);
  const small = makeShapeSpec('cylinder', [0.6, 0.3, 0.6]);
  const bar = makeShapeSpec('box', [0.2, 0.2, 3]);

  it('pulley: fixed points 2 m above the bodies’ tops', () => {
    const a = info(crate, [0, 1, 0]);
    const b = info(crate, [3, 3, 0]);
    const d = typeDefaults('pulley', a, b, [0, 0, 1]);
    expect(bodyTop(a)).toBeCloseTo(1.5, 9);
    expect(d.params.pulleyA).toEqual([0, 3.5, 0]);
    expect(d.params.pulleyB).toEqual([3, 5.5, 0]);
    expect(d.params.ratio).toBe(1);
  });

  it('gear and belt: radii about the shared axis, ratio = radiusA / radiusB, axisB in B’s frame', () => {
    const a = info(wheel, [0, 1, 0]);
    const b = info(small, [2, 1, 0]);
    const g = typeDefaults('gear', a, b, [0, 1, 0]);
    expect(g.params.radiusA).toBeCloseTo(0.6, 6);
    expect(g.params.radiusB).toBeCloseTo(0.3, 6);
    expect(g.params.ratio).toBeCloseTo(2, 6);
    expect(g.params.axisB![1]).toBeCloseTo(1, 6);
    expect(typeDefaults('belt', a, b, [0, 1, 0]).params.ratio).toBeCloseTo(2, 6);
    // a rotated B: the world axis Y is B's local Z after a 90° turn about X
    const q: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    const g2 = typeDefaults('gear', a, info(small, [2, 1, 0], q), [0, 1, 0]);
    expect(Math.abs(g2.params.axisB![2])).toBeCloseTo(1, 6);
  });

  it('radiusAboutAxis: a box turned to a different axis, a world end', () => {
    expect(radiusAboutAxis(info(crate, [0, 0, 0]), [0, 1, 0])).toBeCloseTo(Math.SQRT1_2, 6);
    expect(radiusAboutAxis(info(null, [0, 0, 0]), [0, 1, 0])).toBe(0.5);
  });

  it('rack: pinion radius from A, travel along the longest side of B; winch reels in at 0.5; cone-twist 45°', () => {
    const r = typeDefaults('rack', info(wheel, [0, 1, 0]), info(bar, [0, 0, 0]), [0, 1, 0]);
    expect(r.params.radiusA).toBeCloseTo(0.6, 6);
    expect(r.params.axisB).toEqual([0, 0, 1]);
    const w = typeDefaults('winch', info(crate, [0, 0, 0]), info(crate, [0, 3, 0]), [0, 0, 1]);
    expect(w.motor).toMatchObject({ mode: 'velocity', targetVelocity: 0.5, keyPos: '', keyNeg: '' });
    expect(
      typeDefaults('conetwist', info(crate, [0, 0, 0]), info(crate, [1, 0, 0]), [0, 0, 1]).params.swing,
    ).toBeCloseTo(Math.PI / 4, 9);
    expect(worldBox(info(crate, [1, 2, 3])).max).toEqual([1.5, 2.5, 3.5]);
  });
});

describe('options', () => {
  it('repairs stale saved values', () => {
    const o = jointOptions({ ...DEFAULT_PREFS, jointAxis: 'diagonal' as never, jointConnect: 'x' as never });
    expect(o.axis).toBe('auto');
    expect(o.connect).toBe('chain');
  });
});

// ---- the real editor and store -------------------------------------------------------------------------

function scene(n: number, over: (i: number) => Partial<BodyEntity> = () => ({})) {
  const store = new SceneStore();
  // The editor only reads poses and the active flag from the controller; the real one needs a Web Worker.
  const sim = {
    active: false,
    poseOf: (id: string) => {
      const e = store.body(id);
      return e ? { position: e.position, rotation: e.rotation } : null;
    },
  } as unknown as SimController;
  const editor = new Editor(store, sim);
  const bodies: BodyEntity[] = [];
  for (let i = 0; i < n; i++) {
    bodies.push(editor.addShape('box', [i * 2, 0.5, 0], over(i)));
  }
  return { store, editor, bodies };
}
const joints = (store: SceneStore) => store.all().filter((e) => e.kind === 'joint');

describe('Editor.addJoint (type-aware creation)', () => {
  it('gives each type its defaults and its name from the label table', () => {
    const { store, editor, bodies } = scene(2);
    const [a, b] = bodies;
    const make = (t: JointType) =>
      editor.addJoint(t, { body: a.id, point: [0, 1, 0] }, { body: b.id, point: [2, 1, 0] }, [0, 1, 0])!;
    const pulley = make('pulley');
    expect(pulley.name).toBe('Pulley');
    expect(pulley.params.pulleyA).toEqual([0, 3.0, 0]); // top of the box (1.0) + 2
    const winch = make('winch');
    expect(winch.motor.mode).toBe('velocity');
    expect(winch.motor.targetVelocity).toBe(0.5);
    expect(winch.ropeLength).toBeCloseTo(2, 6);
    const gear = make('gear');
    expect(gear.params.ratio).toBeCloseTo(1, 6);
    expect(gear.anchorB).toEqual([-0.0 + 0, 0.5, 0]); // independent anchor: the clicked point 2 m along, in B's frame
    expect(joints(store)).toHaveLength(4 - 1);
  });

  it('independent-anchor types keep both clicked points; others derive B from A', () => {
    const { editor, bodies } = scene(2);
    const [a, b] = bodies;
    const rope = editor.addJoint('rope', { body: a.id, point: [0.5, 0.5, 0] }, { body: b.id, point: [2, 1, 0] })!;
    expect(rope.anchorA).toEqual([0.5, 0, 0]);
    expect(rope.anchorB).toEqual([0, 0.5, 0]);
    const hinge = editor.addJoint('hinge', { body: a.id, point: [0.5, 0.5, 0] }, { body: b.id, point: [2, 1, 0] })!;
    // B's stored anchor is A's world point seen from B: (0.5 - 2, 0, 0)
    expect(hinge.anchorB[0]).toBeCloseTo(-1.5, 9);
    expect(hinge.anchorB[1]).toBeCloseTo(0, 9);
  });

  it('an explicit axis is stored in A’s local frame', () => {
    const { editor, bodies } = scene(2, (i) => (i === 0 ? { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } : {}));
    const j = editor.addJoint(
      'hinge',
      { body: bodies[0].id, point: [0, 0.5, 0] },
      { body: bodies[1].id, point: [2, 0.5, 0] },
      [1, 0, 0],
    )!;
    // world X seen from a body turned +90° about Y is its local +Z
    expect(j.axis[0]).toBeCloseTo(0, 9);
    expect(j.axis[2]).toBeCloseTo(1, 9);
  });
});

describe('chain mode: one undo step', () => {
  it('three bodies joined in a sequence undo and redo together', () => {
    const { store, editor, bodies } = scene(4);
    store.setSelection([]);
    const baseline = store.undoDepth;
    const chain = new ChainTracker();
    for (let i = 0; i < 3; i++) {
      const j = editor.addJoint(
        'hinge',
        { body: bodies[i].id, point: [i * 2, 1, 0] },
        { body: bodies[i + 1].id, point: [i * 2 + 2, 1, 0] },
      );
      expect(j).not.toBeNull();
      chain.record(store);
    }
    expect(joints(store)).toHaveLength(3);
    expect(store.undoDepth).toBe(baseline + 1);
    expect(store.undoLabel).toBe('Chain of 3 joints');
    store.undo();
    expect(joints(store)).toHaveLength(0);
    expect(store.all().filter((e) => e.kind === 'body')).toHaveLength(4);
    store.redo();
    expect(joints(store)).toHaveLength(3);
    // consecutive links share a body
    const js = joints(store) as { bodyA: string; bodyB: string }[];
    expect(js[0].bodyB).toBe(js[1].bodyA);
    expect(js[1].bodyB).toBe(js[2].bodyA);
  });

  it('does not fold across an unrelated edit made in between', () => {
    const { store, editor, bodies } = scene(3);
    const chain = new ChainTracker();
    editor.addJoint('ball', { body: bodies[0].id, point: [0, 1, 0] }, { body: bodies[1].id, point: [2, 1, 0] });
    chain.record(store);
    store.update(bodies[2].id, { name: 'Renamed' }, 'Rename');
    editor.addJoint('ball', { body: bodies[1].id, point: [2, 1, 0] }, { body: bodies[2].id, point: [4, 1, 0] });
    chain.record(store);
    store.undo(); // only the second joint
    expect(joints(store)).toHaveLength(1);
  });
});

describe('Connect all', () => {
  const opts = (over: Partial<ReturnType<typeof jointOptions>> = {}) => ({
    ...jointOptions(DEFAULT_PREFS),
    type: 'ball' as JointType,
    ...over,
  });

  it('chain / star / pairs create the right joints as ONE undo step', () => {
    for (const [mode, count, pairs] of [
      [
        'chain',
        3,
        [
          [0, 1],
          [1, 2],
          [2, 3],
        ],
      ],
      [
        'star',
        3,
        [
          [0, 1],
          [0, 2],
          [0, 3],
        ],
      ],
      ['pairs', 6, null],
    ] as const) {
      const { store, editor, bodies } = scene(4);
      const before = store.undoDepth;
      const r = connectBodies(
        editor,
        bodies.map((b) => b.id),
        opts({ connect: mode }),
      );
      expect(r.joints, mode).toHaveLength(count);
      expect(store.undoDepth, mode).toBe(before + 1);
      if (pairs) {
        const got = r.joints.map((j) => [
          bodies.findIndex((b) => b.id === j.bodyA),
          bodies.findIndex((b) => b.id === j.bodyB),
        ]);
        expect(got).toEqual(pairs);
      }
      store.undo();
      expect(joints(store), mode).toHaveLength(0);
    }
  });

  it('anchors: closest box points for a hinge between a gap, body centres for a spring', () => {
    const { editor, bodies } = scene(2);
    const hinge = connectBodies(
      editor,
      bodies.map((b) => b.id),
      opts({ type: 'hinge' }),
    ).joints[0];
    // boxes 1 m wide at x = 0 and 2: they touch at x = 1; anchor A is on that plane, local +0.5
    expect(hinge.anchorA[0]).toBeCloseTo(0.5, 9);
    const spring = connectBodies(
      editor,
      bodies.map((b) => b.id),
      opts({ type: 'spring' }),
    ).joints[0];
    expect(spring.anchorA).toEqual([0, 0, 0]);
    expect(spring.anchorB).toEqual([0, 0, 0]);
    expect(vdist(spring.anchorA, spring.anchorB)).toBe(0);
  });

  it('applies collide-connected and a limit preset; skips pairs of two static bodies', () => {
    const { editor, bodies } = scene(3, (i) => (i < 2 ? { bodyType: 'static' } : {}));
    const r = connectBodies(
      editor,
      bodies.map((b) => b.id),
      opts({ type: 'hinge', collide: true, limit: 'pm90', connect: 'pairs' }),
    );
    expect(r.skipped).toBe(1);
    expect(r.joints).toHaveLength(2);
    for (const j of r.joints) {
      expect(j.collideConnected).toBe(true);
      expect(j.limit).toMatchObject({ enabled: true });
      expect(j.limit.max).toBeCloseTo(Math.PI / 2, 9);
    }
  });
});

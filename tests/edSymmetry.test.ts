import { describe, expect, it } from 'vitest';
import { qfromEuler, vlen, vsub, type Vec3 } from '../src/core/math';
import { Symmetry } from '../src/app/edit/symmetry';
import { mirrorCopy, axisPlane } from '../src/model/edit/mirror';
import { createBody, createJoint, createLight } from '../src/model/factory';
import { SceneStore, type SceneChange } from '../src/model/store';
import type { BodyEntity, JointEntity } from '../src/model/types';

function setup(opts: { sim?: boolean } = {}) {
  const store = new SceneStore();
  const sym = new Symmetry({ store, simActive: () => !!opts.sim });
  return { store, sym };
}

/** A body and its mirror image about x = 0 (made the way a user would: a mirror copy). */
function pair(store: SceneStore) {
  const a = createBody({
    name: 'A',
    shape: { type: 'wedge', size: [1, 0.6, 2] },
    position: [2, 1, 0.5],
    rotation: qfromEuler([0.1, 0.5, 0.2]),
  });
  store.add([a], 'Add', false);
  const res = mirrorCopy(store.all(), [a.id], axisPlane(0));
  store.add(res.entities, 'Mirror', false);
  const b = res.entities[0] as BodyEntity;
  return { a, b, res };
}

const undoSteps = (s: SceneStore): number => {
  let n = 0;
  while (s.undo()) n++;
  return n;
};

describe('symmetry mode', () => {
  it('derives the pairs of an existing mirror-image layout when switched on', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    expect(sym.enabled).toBe(false);
    sym.setEnabled(true);
    expect(sym.partnerOf(a.id)).toBe(b.id);
    expect(sym.partnerOf(b.id)).toBe(a.id);
    expect(sym.pairCount).toBe(1);
  });

  it('does nothing while switched off', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    void sym;
    store.update(a.id, { position: [5, 1, 0] }, 'Move');
    expect((store.body(b.id) as BodyEntity).position).toEqual(b.position);
  });

  it('a move of one half is mirrored on the other, in ONE undo step', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    sym.setEnabled(true);
    store.update(a.id, { position: [4, 2, -1] }, 'Move');
    expect(store.body(b.id)!.position).toEqual([-4, 2, -1]);
    expect(store.undo()).toBe('Move');
    expect(store.body(a.id)!.position).toEqual(a.position);
    expect(store.body(b.id)!.position).toEqual(b.position);
    // redo brings both back, still without creating anything new
    expect(store.redo()).toBe('Move');
    expect(store.body(b.id)!.position).toEqual([-4, 2, -1]);
    expect(store.bodies()).toHaveLength(2);
  });

  it('a gizmo drag (begin/end batch of many updates) is one undo step covering both halves', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    sym.setEnabled(true);
    store.begin('Move');
    for (let i = 1; i <= 8; i++) store.update(a.id, { position: [2 + i * 0.1, 1, 0.5] }, 'Move');
    store.end();
    expect(store.body(b.id)!.position[0]).toBeCloseTo(-2.8, 12);
    // One undo reverts the whole drag, both halves (and nothing of the setup).
    expect(store.undo()).toBe('Move');
    expect(store.body(b.id)!.position).toEqual(b.position);
    expect(store.body(a.id)!.position).toEqual(a.position);
    expect(store.bodies()).toHaveLength(2);
  });

  it('rotation, size, material and mass edits follow (orientation by the pair axis)', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    sym.setEnabled(true);
    store.update(a.id, { rotation: qfromEuler([0, 1.2, 0.3]) }, 'Rotate');
    const wantPair = mirrorCopy([store.body(a.id)!], [a.id], axisPlane(0));
    const A = store.body(a.id)!;
    const B = store.body(b.id)!;
    // the partner's corner points are the images of A's corners
    const corner: Vec3 = [0.4, 0.2, -0.9];
    const qrot = (q: BodyEntity['rotation'], v: Vec3): Vec3 => {
      const [x, y, z, w] = q;
      const t: Vec3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
      return [
        v[0] + w * t[0] + (y * t[2] - z * t[1]),
        v[1] + w * t[1] + (z * t[0] - x * t[2]),
        v[2] + w * t[2] + (x * t[1] - y * t[0]),
      ];
    };
    const axis = sym.pairs.get(a.id)!.axis;
    const flipped: Vec3 = [...corner];
    flipped[axis] = -flipped[axis];
    const wa = qrot(A.rotation, corner).map((v, k) => v + A.position[k]) as Vec3;
    const wb = qrot(B.rotation, flipped).map((v, k) => v + B.position[k]) as Vec3;
    expect(vlen(vsub(wb, [-wa[0], wa[1], wa[2]]))).toBeLessThan(1e-9);
    void wantPair;
    store.update(a.id, { shape: { ...A.shape, size: [2, 0.6, 3] }, massOverride: 7 }, 'Resize');
    expect(store.body(b.id)!.shape.size).toEqual([2, 0.6, 3]);
    expect(store.body(b.id)!.massOverride).toBe(7);
    store.update(a.id, { material: { ...A.material, color: '#123456' } }, 'Recolour');
    expect(store.body(b.id)!.material.color).toBe('#123456');
    // a name is not mirrored
    store.update(a.id, { name: 'Left wing' }, 'Rename');
    expect(store.body(b.id)!.name).not.toBe('Left wing');
  });

  it('edits made on the partner mirror back; no feedback loop (a bounded number of events)', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    sym.setEnabled(true);
    const events: SceneChange[] = [];
    store.on('change', (c) => events.push(c));
    store.update(b.id, { position: [-6, 1, 1] }, 'Move');
    expect(store.body(a.id)!.position).toEqual([6, 1, 1]);
    expect(events.filter((e) => e.type === 'update')).toHaveLength(2);
  });

  it('adding an object adds its mirror image in the same undo step; undo / redo do not duplicate it', () => {
    const { store, sym } = setup();
    sym.setEnabled(true);
    const c = createBody({ name: 'Crate', position: [3, 0.5, 2] });
    store.add([c], 'Add Crate');
    expect(store.bodies()).toHaveLength(2);
    const twin = store.bodies().find((b) => b.id !== c.id)!;
    expect(twin.position).toEqual([-3, 0.5, 2]);
    expect(sym.partnerOf(c.id)).toBe(twin.id);
    expect(store.undo()).toBe('Add Crate');
    expect(store.bodies()).toHaveLength(0);
    expect(store.redo()).toBe('Add Crate');
    expect(store.bodies()).toHaveLength(2);
    // and editing after redo still mirrors
    store.update(c.id, { position: [1, 0.5, 2] }, 'Move');
    expect(store.body(twin.id)!.position).toEqual([-1, 0.5, 2]);
  });

  it('an object on the mirror plane is its own mirror image: no copy is made', () => {
    const { store, sym } = setup();
    sym.setEnabled(true);
    store.add([createBody({ position: [0, 0.5, 0] })], 'Add');
    expect(store.bodies()).toHaveLength(1);
  });

  it('a mirror-image pair added together (paste of both halves) is paired, not mirrored again', () => {
    const { store, sym } = setup();
    sym.setEnabled(true);
    const a = createBody({ position: [2, 1, 0] });
    const b = createBody({ position: [-2, 1, 0] });
    store.add([a, b], 'Paste');
    expect(store.bodies()).toHaveLength(2);
    expect(sym.partnerOf(a.id)).toBe(b.id);
  });

  it('deleting one half deletes the other, in one step; undo brings both back', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    sym.setEnabled(true);
    store.remove([a.id], 'Delete');
    expect(store.has(a.id)).toBe(false);
    expect(store.has(b.id)).toBe(false);
    expect(store.undo()).toBe('Delete');
    expect(store.has(a.id) && store.has(b.id)).toBe(true);
  });

  it('a locked partner is left alone', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    sym.setEnabled(true);
    store.update(b.id, { locked: true }, 'Lock');
    store.update(a.id, { position: [9, 1, 0] }, 'Move');
    expect(store.body(b.id)!.position).toEqual(b.position);
    store.remove([a.id], 'Delete');
    expect(store.has(b.id)).toBe(true);
  });

  it('is inactive while a simulation is live', () => {
    const { store, sym } = setup({ sim: true });
    const { a, b } = pair(store);
    sym.setEnabled(true);
    store.update(a.id, { position: [9, 1, 0] }, 'Move');
    expect(store.body(b.id)!.position).toEqual(b.position);
  });

  it('editing both halves in one update keeps both as given (a select-all move)', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    sym.setEnabled(true);
    store.updateMany(
      [
        [a.id, { position: [3, 1, 0.5] }],
        [b.id, { position: [-1, 1, 0.5] }],
      ],
      'Move all',
    );
    expect(store.body(a.id)!.position[0]).toBe(3);
    expect(store.body(b.id)!.position[0]).toBe(-1);
    // the next edit of one half re-syncs the other
    store.update(a.id, { position: [3.5, 1, 0.5] }, 'Move');
    expect(store.body(b.id)!.position[0]).toBe(-3.5);
  });

  it('works about a Y plane at an offset and re-pairs when the plane changes', () => {
    const { store, sym } = setup();
    const a = createBody({ position: [1, 3, 0] });
    store.add([a], 'Add', false);
    const res = mirrorCopy(store.all(), [a.id], axisPlane(1, 1));
    store.add(res.entities, 'Mirror', false);
    sym.setPlane(1, 1);
    sym.setEnabled(true);
    expect(sym.pairCount).toBe(1);
    store.update(a.id, { position: [1, 5, 2] }, 'Move');
    expect(store.body(res.entities[0].id)!.position).toEqual([1, -3, 2]);
    sym.setPlane(0, 0);
    expect(sym.pairCount).toBe(0);
  });

  it('joint edits are mirrored: limits, motors, and a joint added between paired bodies gets its twin', () => {
    const { store, sym } = setup();
    const post = createBody({ name: 'Post', position: [2, 3, 0], bodyType: 'static' });
    const arm = createBody({ name: 'Arm', position: [3, 3, 0] });
    store.add([post, arm], 'Add', false);
    const res = mirrorCopy(store.all(), [post.id, arm.id], axisPlane(0));
    store.add(res.entities, 'Mirror', false);
    sym.setEnabled(true);
    const j = createJoint({
      type: 'hinge',
      bodyA: post.id,
      bodyB: arm.id,
      anchorA: [0.5, 0.2, 0],
      anchorB: [-0.5, 0.2, 0],
      axis: [0.3, 0.4, 0.5],
    });
    store.add([j], 'Add hinge');
    const joints = store.joints();
    expect(joints).toHaveLength(2);
    const twin = joints.find((x) => x.id !== j.id) as JointEntity;
    expect(twin.bodyA).toBe(res.idMap.get(post.id));
    expect(twin.axis).toEqual([0.3, -0.4, -0.5]);
    expect(twin.anchorA).toEqual([-0.5, 0.2, 0]);
    store.update(j.id, { limit: { enabled: true, min: -0.2, max: 0.7 } }, 'Limit');
    expect((store.joint(twin.id) as JointEntity).limit).toEqual({ enabled: true, min: -0.2, max: 0.7 });
    store.undo();
    expect((store.joint(twin.id) as JointEntity).limit.enabled).toBe(false);
  });

  it('lights are mirrored too', () => {
    const { store, sym } = setup();
    sym.setEnabled(true);
    store.add([createLight('point', { position: [4, 5, 1] })], 'Add light');
    expect(store.lights()).toHaveLength(2);
    expect(
      store
        .lights()
        .map((l) => l.position[0])
        .sort((a, b) => a - b),
    ).toEqual([-4, 4]);
  });

  it('switching off stops mirroring and forgets the pairs', () => {
    const { store, sym } = setup();
    const { a, b } = pair(store);
    sym.setEnabled(true);
    sym.setEnabled(false);
    expect(sym.pairs.size).toBe(0);
    store.update(a.id, { position: [7, 1, 0] }, 'Move');
    expect(store.body(b.id)!.position).toEqual(b.position);
    expect(undoSteps(store)).toBeGreaterThan(0);
  });
});

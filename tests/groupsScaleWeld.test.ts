/**
 * ED-20: group scale (analytic), weld / unweld (the engine moves a welded chain as one rigid body), lock / hide at
 * group level and nested groups.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, type Quat, type Vec3 } from '../src/core/math';
import {
  endScaleGroupDrag,
  scaleGroup,
  scaleGroupDrag,
  unweldGroup,
  weldCount,
  weldGroup,
} from '../src/app/edit/groupOps';
import { parseScaleFactor, scaleGroupPatches } from '../src/model/edit/groupScale';
import { weldEdges } from '../src/model/edit/weld';
import { createBody, createGroup, createJoint, createLight, createPath, createSoft } from '../src/model/factory';
import { naturalMass } from '../src/model/compound';
import { SceneStore } from '../src/model/store';
import type { BodyEntity, Entity, JointEntity } from '../src/model/types';
import { run, worldOf } from './helpers';

const box = (name: string, position: Vec3, over: Partial<BodyEntity> = {}) =>
  createBody({ name, shape: { type: 'box', size: [1, 1, 1] }, position, ...over });

/** Apply `[id, patch]` pairs to a copy of the entity list. */
function applied(entities: Entity[], patches: [string, Partial<Entity>][]): Map<string, Entity> {
  const m = new Map(entities.map((e) => [e.id, e]));
  for (const [id, p] of patches) m.set(id, { ...m.get(id)!, ...p } as Entity);
  return m;
}

const close = (a: Vec3, b: Vec3, d = 1e-9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(d)));

describe('scaleGroupPatches', () => {
  it('doubles sizes, positions about the pivot and mass x8 for two boxes', () => {
    const g = createGroup({ position: [1, 0, 0] });
    const a = box('A', [2, 0.5, 0], { parent: g.id });
    const b = box('B', [0, 0.5, 2], { parent: g.id });
    const all: Entity[] = [g, a, b];
    const { patches, approximate } = scaleGroupPatches(all, g.id, [2, 2, 2]);
    expect(approximate).toBe(false);
    const out = applied(all, patches);
    const A = out.get(a.id) as BodyEntity;
    const B = out.get(b.id) as BodyEntity;
    close(A.position, [1 + 2 * 1, 1, 0]); // pivot + 2 * (p - pivot)
    close(B.position, [1 + 2 * -1, 1, 4]);
    expect(A.shape.size).toEqual([2, 2, 2]);
    expect(naturalMass(A) / naturalMass(a)).toBeCloseTo(8, 9);
    // the group's own pivot never moves
    expect(out.get(g.id)).toBe(g);
  });

  it('is exact for a non-uniform factor along the group axes (group turned 90 degrees about Y)', () => {
    const q: Quat = qfromAxisAngle([0, 1, 0], Math.PI / 2);
    const g = createGroup({ rotation: q });
    // group +x points along world -z after the turn; a world-axis-aligned box is aligned with the group too
    const a = box('A', [0, 0.5, -3], { parent: g.id });
    const all: Entity[] = [g, a];
    const { patches, approximate } = scaleGroupPatches(all, g.id, [3, 1, 1]);
    expect(approximate).toBe(false);
    const A = applied(all, patches).get(a.id) as BodyEntity;
    close(A.position, [0, 0.5, -9]);
    // the factor acts along world z for this box: its local z grows
    close(A.shape.size, [1, 1, 3]);
  });

  it('flags a non-uniform factor as approximate for a member turned against the group axes, never a uniform one', () => {
    const g = createGroup();
    const turned = box('T', [1, 0.5, 0], { parent: g.id, rotation: qfromAxisAngle([0, 1, 0], Math.PI / 4) });
    expect(scaleGroupPatches([g, turned], g.id, [2, 1, 1]).approximate).toBe(true);
    expect(scaleGroupPatches([g, turned], g.id, [2, 2, 2]).approximate).toBe(false);
  });

  it('keeps shape constraints (a sphere stays a sphere) and scales a massOverride with the volume', () => {
    const g = createGroup();
    const s = createBody({
      name: 'S',
      shape: { type: 'sphere', size: [1, 1, 1] },
      position: [1, 0.5, 0],
      parent: g.id,
      massOverride: 5,
    });
    const out = applied([g, s], scaleGroupPatches([g, s], g.id, [2, 2, 2]).patches).get(s.id) as BodyEntity;
    expect(out.shape.size[0]).toBeCloseTo(2, 9);
    expect(out.shape.size[1]).toBeCloseTo(2, 9);
    expect(out.massOverride).toBeCloseTo(40, 6);
  });

  it('scales nested groups: the inner pivot and its members', () => {
    const outer = createGroup();
    const inner = createGroup({ parent: outer.id, position: [4, 0, 0] });
    const m = box('M', [5, 0.5, 0], { parent: inner.id });
    const all: Entity[] = [outer, inner, m];
    const out = applied(all, scaleGroupPatches(all, outer.id, [2, 2, 2]).patches);
    close(out.get(inner.id)!.kind === 'group' ? (out.get(inner.id) as typeof inner).position : [0, 0, 0], [8, 0, 0]);
    close((out.get(m.id) as BodyEntity).position, [10, 1, 0]);
  });

  it('scales joint anchors, spring rest length, rope length and slider limits; world anchors scale about the pivot', () => {
    const g = createGroup();
    const a = box('A', [1, 0.5, 0], { parent: g.id });
    const b = box('B', [3, 0.5, 0], { parent: g.id });
    const hinge = createJoint({
      type: 'hinge',
      bodyA: a.id,
      bodyB: null,
      anchorA: [0.5, 0, 0],
      anchorB: [1.5, 0.5, 0],
      axis: [0, 0, 1],
    });
    const spring = createJoint({
      type: 'spring',
      bodyA: a.id,
      bodyB: b.id,
      anchorA: [0.5, 0, 0],
      anchorB: [-0.5, 0, 0],
      spring: { restLength: 1, stiffness: 100, damping: 1, breakForce: 0 },
    });
    const rope = createJoint({
      type: 'rope',
      bodyA: a.id,
      bodyB: b.id,
      anchorA: [0.5, 0, 0],
      anchorB: [-0.5, 0, 0],
      ropeLength: 1.5,
    });
    const slider = createJoint({
      type: 'slider',
      bodyA: a.id,
      bodyB: b.id,
      anchorA: [0, 0, 0],
      axis: [1, 0, 0],
      limit: { enabled: true, min: -1, max: 1 },
    });
    const all: Entity[] = [g, a, b, hinge, spring, rope, slider];
    const out = applied(all, scaleGroupPatches(all, g.id, [2, 2, 2]).patches);
    close((out.get(hinge.id) as JointEntity).anchorA, [1, 0, 0]);
    close((out.get(hinge.id) as JointEntity).anchorB, [3, 1, 0]); // world end: about the pivot (origin)
    expect((out.get(spring.id) as JointEntity).spring.restLength).toBeCloseTo(2, 9);
    expect((out.get(rope.id) as JointEntity).ropeLength).toBeCloseTo(3, 9);
    expect((out.get(slider.id) as JointEntity).limit).toMatchObject({ min: -2, max: 2 });
  });

  it('scales soft bodies, path points and light position/range but never light intensity', () => {
    const g = createGroup();
    const soft = createSoft('jelly', { position: [2, 1, 0], parent: g.id });
    const path = createPath({
      position: [0, 0, 0],
      parent: g.id,
      points: [
        [1, 0, 0],
        [2, 0, 1],
        [3, 0, 0],
      ],
    });
    const light = createLight('point', { position: [0, 3, 0], parent: g.id, intensity: 123, range: 10 });
    const all: Entity[] = [g, soft, path, light];
    const out = applied(all, scaleGroupPatches(all, g.id, [2, 2, 2]).patches);
    const s2 = out.get(soft.id) as typeof soft;
    expect(s2.size).toEqual([soft.size[0] * 2, soft.size[1] * 2, soft.size[2] * 2]);
    expect(s2.mass).toBeCloseTo(soft.mass * 8, 9);
    expect((out.get(path.id) as typeof path).points).toEqual([
      [2, 0, 0],
      [4, 0, 2],
      [6, 0, 0],
    ]);
    const l2 = out.get(light.id) as typeof light;
    expect(l2.position).toEqual([0, 6, 0]);
    expect(l2.range).toBeCloseTo(20, 9);
    expect(l2.intensity).toBe(123);
  });

  it('does nothing for factor 1 and clamps absurd factors', () => {
    const g = createGroup();
    const a = box('A', [1, 0.5, 0], { parent: g.id });
    expect(scaleGroupPatches([g, a], g.id, [1, 1, 1]).patches).toEqual([]);
    const out = applied([g, a], scaleGroupPatches([g, a], g.id, [1e6, 1e6, 1e6]).patches).get(a.id) as BodyEntity;
    expect(out.shape.size[0]).toBe(50);
  });

  it('parses typed factors', () => {
    expect(parseScaleFactor('2')).toEqual([2, 2, 2]);
    expect(parseScaleFactor('×1,5')).toEqual([1.5, 1.5, 1.5]);
    expect(parseScaleFactor('2 1 0.5')).toEqual([2, 1, 0.5]);
    expect(parseScaleFactor('2,1,0.5')).toEqual([2, 1, 0.5]);
    expect(parseScaleFactor('0')).toBeNull();
    expect(parseScaleFactor('abc')).toBeNull();
    expect(parseScaleFactor('1 2')).toBeNull();
  });
});

describe('scaleGroup on the store', () => {
  function sceneWithGroup() {
    const s = new SceneStore();
    const g = createGroup();
    const a = box('A', [1, 0.5, 0], { parent: g.id });
    const b = box('B', [-1, 0.5, 0], { parent: g.id });
    s.add([g, a, b]);
    return { s, g, a, b };
  }

  it('is one undo step and undo restores every member', () => {
    const { s, g, a, b } = sceneWithGroup();
    const steps = s.undoLabel;
    expect(scaleGroup(s, g.id, [2, 2, 2]).changed).toBe(true);
    expect((s.body(a.id) as BodyEntity).shape.size).toEqual([2, 2, 2]);
    expect(s.undoLabel).toBe('Scale group');
    s.undo();
    expect(s.undoLabel).toBe(steps); // exactly one step was undone
    expect((s.body(a.id) as BodyEntity).shape.size).toEqual([1, 1, 1]);
    expect((s.body(b.id) as BodyEntity).position).toEqual([-1, 0.5, 0]);
  });

  it('a gizmo drag applies the cumulative factor to the state at drag start (back to 1 restores)', () => {
    const { s, g, a } = sceneWithGroup();
    s.begin('Scale');
    scaleGroupDrag(s, g.id, [1.5, 1.5, 1.5]);
    scaleGroupDrag(s, g.id, [3, 3, 3]);
    expect((s.body(a.id) as BodyEntity).shape.size[0]).toBeCloseTo(3, 9); // not 4.5
    scaleGroupDrag(s, g.id, [1, 1, 1]);
    expect((s.body(a.id) as BodyEntity).shape.size[0]).toBeCloseTo(1, 9);
    expect((s.body(a.id) as BodyEntity).position).toEqual([1, 0.5, 0]);
    scaleGroupDrag(s, g.id, [2, 2, 2]);
    s.end();
    expect(endScaleGroupDrag()).toBe(false);
    s.undo();
    expect((s.body(a.id) as BodyEntity).shape.size[0]).toBe(1);
  });
});

describe('weld group', () => {
  it('a spanning tree: n bodies get n-1 fixed joints, no static-static links, nearest neighbours first', () => {
    const bodies = [
      { id: 'a', position: [0, 0, 0] as Vec3, bodyType: 'static' as const },
      { id: 'b', position: [1, 0, 0] as Vec3, bodyType: 'static' as const },
      { id: 'c', position: [2, 0, 0] as Vec3, bodyType: 'dynamic' as const },
      { id: 'd', position: [10, 0, 0] as Vec3, bodyType: 'dynamic' as const },
    ];
    const edges = weldEdges(bodies);
    expect(edges.length).toBe(3);
    const key = edges.map(([x, y]) => bodies[x].id + bodies[y].id);
    expect(key).not.toContain('ab'); // two statics are never linked
    expect(key).toContain('bc');
    expect(key).toContain('cd');
  });

  it('adds one undoable step, is idempotent and unweld removes only the weld joints', () => {
    const s = new SceneStore();
    const g = createGroup({ name: 'Rig' });
    const bs = [0, 1, 2, 3].map((i) => box(`B${i}`, [i, 0.5, 0], { parent: g.id }));
    const keep = createJoint({ type: 'fixed', bodyA: bs[0].id, bodyB: bs[3].id, anchorA: [0, 0, 0], name: 'Weld' });
    s.add([g, ...bs, keep]);
    expect(weldGroup(s, g.id)).toBe(3);
    expect(s.joints().filter((j) => j.type === 'fixed').length).toBe(4);
    expect(weldCount(s, g.id)).toBe(3);
    expect(weldGroup(s, g.id)).toBe(0); // already one assembly
    s.undo();
    expect(weldCount(s, g.id)).toBe(0); // one undo step removes all three
    s.redo();
    expect(unweldGroup(s, g.id)).toBe(3);
    expect(s.joints().map((j) => j.id)).toEqual([keep.id]); // the user's own fixed joint survives
    s.undo();
    expect(weldCount(s, g.id)).toBe(3);
  });

  it('a welded chain simulated in the engine moves rigidly, an unwelded one does not', async () => {
    const make = (welded: boolean) => {
      const s = new SceneStore();
      const g = createGroup({ name: 'Chain' });
      const xs = [0, 1.2, 2.4];
      const bs = xs.map((x, i) => box(`B${i}`, [x, 3, 0], { parent: g.id }));
      s.add([g, ...bs]);
      if (welded) weldGroup(s, g.id);
      // an off-centre kick: ball joint to the world at the first body keeps it from simply falling in sync
      const pin = createJoint({
        type: 'ball',
        bodyA: bs[0].id,
        bodyB: null,
        anchorA: [-0.5, 0, 0],
        anchorB: [-0.5, 3, 0],
      });
      s.add([pin], 'pin', false);
      return { doc: s.toDocument(), ids: bs.map((b) => b.id) };
    };
    const dist = async (welded: boolean) => {
      const { doc, ids } = make(welded);
      const w = await worldOf(doc.entities);
      run(w, 1.5);
      const p = ids.map((id) => w.getPose(id)!.position);
      const d01 = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1], p[0][2] - p[1][2]);
      const d02 = Math.hypot(p[0][0] - p[2][0], p[0][1] - p[2][1], p[0][2] - p[2][2]);
      return { d01, d02 };
    };
    const w = await dist(true);
    expect(w.d01).toBeCloseTo(1.2, 1);
    expect(w.d02).toBeCloseTo(2.4, 1);
    const u = await dist(false);
    // the three loose boxes tumble apart / fall past each other: the spacing is no longer the built one
    expect(Math.abs(u.d02 - 2.4)).toBeGreaterThan(0.2);
  });
});

describe('group level lock / hide and nesting', () => {
  it('toggling lock / hide on an outer group cascades to nested groups and bodies (via the editor)', async () => {
    const { Editor } = await import('../src/app/editor');
    const s = new SceneStore();
    const outer = createGroup();
    const inner = createGroup({ parent: outer.id });
    const a = box('A', [0, 0.5, 0], { parent: inner.id });
    s.add([outer, inner, a]);
    const ed = new Editor(s, { active: false } as never);
    ed.toggleFlag([outer.id], 'locked');
    expect(s.group(inner.id)!.locked).toBe(true);
    expect(s.body(a.id)!.locked).toBe(true);
    ed.toggleFlag([outer.id], 'hidden');
    expect(s.body(a.id)!.hidden).toBe(true);
    ed.toggleFlag([outer.id], 'hidden');
    expect(s.body(a.id)!.hidden).toBe(false);
  });

  it('moving an outer group carries nested groups and members; group selection nests', async () => {
    const { Editor } = await import('../src/app/editor');
    const s = new SceneStore();
    const ed = new Editor(s, { active: false } as never);
    const a = box('A', [0, 0.5, 0]);
    const b = box('B', [2, 0.5, 0]);
    s.add([a, b]);
    const inner = ed.groupSelection([a.id, b.id])!;
    const c = box('C', [10, 0.5, 0]);
    s.add([c]);
    const outer = ed.groupSelection([inner.id, c.id])!;
    expect(s.group(inner.id)!.parent).toBe(outer.id);
    const bx = (id: string) => (s.get(id) as BodyEntity).position[0];
    s.transformGroup(outer.id, { position: [outer.position[0] + 5, outer.position[1], outer.position[2]] });
    expect([bx(a.id), bx(b.id), bx(c.id)]).toEqual([5, 7, 15]);
  });
});

/**
 * The entity kinds added in scene format v3 — group, light and path: factories, sanitising, cloning, store
 * operations with undo, and the group transform command that carries members along.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, vadd, vdist, type Quat, type Vec3 } from '../src/core/math';
import { newReport } from '../src/model/errors';
import {
  createBody,
  createGroup,
  createJoint,
  createLight,
  createPath,
  createSoft,
  LIGHT_DOWN,
  newDocument,
} from '../src/model/factory';
import { descendantIds, childIndex, topLevel, withDescendants } from '../src/model/groups';
import { LIMITS } from '../src/model/limits';
import { SCENE_VERSION } from '../src/model/migrations';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { cloneEntities, SceneStore, type SceneChange } from '../src/model/store';
import type { BodyEntity, Entity, GroupEntity, LightEntity, PathEntity, SceneDocument } from '../src/model/types';
import { isGroup, isLight, isPath, parentOf } from '../src/model/types';

const box = (name: string, p: Vec3 = [0, 0.5, 0], over: Partial<BodyEntity> = {}) =>
  createBody({ name, shape: { type: 'box' }, position: p, ...over });

const near = (a: Vec3, b: Vec3, eps = 1e-9) => expect(vdist(a, b)).toBeLessThan(eps);
const docWith = (entities: Entity[]): SceneDocument => ({ ...newDocument('t'), entities });
const roundTrip = (d: SceneDocument) => parseDocument(serializeDocument(d));

describe('factories', () => {
  it('create each kind with sensible, distinct defaults', () => {
    const g = createGroup();
    expect(g).toMatchObject({ kind: 'group', locked: false, hidden: false });
    expect(g.parent).toBeUndefined();
    const lights = (['point', 'spot', 'directional', 'area'] as const).map((t) => createLight(t));
    expect(lights.map((l) => l.lightType)).toEqual(['point', 'spot', 'directional', 'area']);
    for (const l of lights) {
      expect(l.intensity).toBeGreaterThan(0);
      expect(l.enabled).toBe(true);
    }
    // downward-facing kinds point their −Z axis at −Y; a point light has no direction
    for (const l of lights.slice(1)) near(qrot(l.rotation, [0, 0, -1]), [0, -1, 0], 1e-12);
    expect(lights[0].rotation).toEqual([0, 0, 0, 1]);
    expect(lights[1].castShadow).toBe(true);
    expect(new Set(lights.map((l) => l.id)).size).toBe(4);
    const p = createPath();
    expect(p.points.length).toBeGreaterThanOrEqual(2);
    expect(p.closed).toBe(false);
    expect(p.tension).toBe(0);
    expect(LIGHT_DOWN).toHaveLength(4);
  });
});

describe('sanitising', () => {
  it('round-trips every kind through JSON unchanged', () => {
    const g = createGroup({ name: 'Rig', position: [1, 2, 3], locked: true });
    const k = box('Kid', [0, 0, 0], { parent: g.id });
    const l = createLight('spot', { name: 'Lamp', intensity: 321, angle: 0.5, penumbra: 0.2, parent: g.id });
    const p = createPath({
      name: 'Track',
      closed: true,
      tension: 0.4,
      color: '#ff00aa',
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 0, 2],
      ],
      parent: g.id,
    });
    const s = createSoft('cloth', { parent: g.id });
    const doc = roundTrip(docWith([g, k, l, p, s]));
    expect(doc.version).toBe(SCENE_VERSION);
    expect(doc.entities).toEqual([g, k, l, p, s]);
  });

  it('repairs garbage without throwing', () => {
    const doc = sanitizeDocument({
      format: 'physicslab-scene',
      version: SCENE_VERSION,
      entities: [
        { kind: 'group', id: 'g1', name: 5, position: [Infinity, 'x'], rotation: [0, 0, 0, 0], locked: 'yes' },
        {
          kind: 'light',
          id: 'l1',
          lightType: 'laser',
          intensity: -5,
          angle: 99,
          penumbra: 7,
          size: [0, 1e9],
          color: 'red',
          rotation: 'up',
        },
        { kind: 'light', id: 'l2', lightType: 'spot', intensity: 1e12, range: -3, angle: 0 },
        { kind: 'path', id: 'p1', points: [[1, 2, 3]], closed: true, tension: 9, color: 12 },
        { kind: 'path', id: 'p2', points: 'nope' },
        { kind: 'path', id: 'p3', points: [[0, 0, 0], ['a'], [1, 1, 1], [2, 2]], closed: true },
        { kind: 'teapot', id: 't' },
        null,
      ],
    });
    const byId = (id: string) => doc.entities.find((e) => e.id === id)!;
    const g = byId('g1') as GroupEntity;
    expect(g.name).toBe('Group');
    expect(g.position).toEqual([0, 0, 0]);
    expect(g.rotation).toEqual([0, 0, 0, 1]);
    expect(g.locked).toBe(false);
    const l1 = byId('l1') as LightEntity;
    expect(l1.lightType).toBe('point');
    expect(l1.intensity).toBe(0);
    expect(l1.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(l1.penumbra).toBe(1);
    expect(l1.size[0]).toBeGreaterThan(0);
    expect(l1.size[1]).toBe(1000);
    expect(l1.color).toBe('#fff1d6');
    expect(l1.rotation).toEqual([0, 0, 0, 1]);
    const l2 = byId('l2') as LightEntity;
    expect(l2.intensity).toBe(1e6);
    expect(l2.range).toBe(0);
    expect(l2.angle).toBeGreaterThan(0);
    const p1 = byId('p1') as PathEntity;
    expect(p1.points.length).toBeGreaterThanOrEqual(2); // a single point is no path: the default one replaces it
    expect(p1.tension).toBe(1);
    expect(p1.color).toBe('#5ec8ff');
    expect(byId('p2')).toBeDefined();
    const p3 = byId('p3') as PathEntity;
    expect(p3.points).toEqual([
      [0, 0, 0],
      [1, 1, 1],
    ]); // unusable points dropped
    expect(p3.closed).toBe(false); // …leaving too few to close a loop
    expect(doc.entities.find((e) => e.id === 't')).toBeUndefined();
  });

  it('limits the number of path points and lights', () => {
    const points = Array.from({ length: LIMITS.maxPathPoints + 50 }, (_, i) => [i, 0, 0]);
    const lights = Array.from({ length: LIMITS.maxLights + 5 }, (_, i) => ({
      kind: 'light',
      id: `l${i}`,
      lightType: 'point',
    }));
    const report = newReport();
    const doc = sanitizeDocument(
      { format: 'physicslab-scene', version: SCENE_VERSION, entities: [{ kind: 'path', id: 'p', points }, ...lights] },
      report,
    );
    expect((doc.entities[0] as PathEntity).points.length).toBe(LIMITS.maxPathPoints);
    expect(doc.entities.filter(isLight).length).toBe(LIMITS.maxLights);
    expect(report.warnings.join(' ')).toMatch(/lights are kept per scene/);
  });

  it('keeps parent links to groups, drops dangling and looping ones with a warning', () => {
    const g = createGroup({ name: 'G' });
    const inner = createGroup({ name: 'Inner', parent: g.id });
    const ok = box('ok', [0, 0, 0], { parent: inner.id });
    const orphan = createLight('point', { parent: 'ghost' });
    const a = createGroup({ name: 'A' });
    const b = createGroup({ name: 'B', parent: a.id });
    a.parent = b.id; // loop
    const report = newReport();
    const doc = sanitizeDocument(JSON.parse(serializeDocument(docWith([g, inner, ok, orphan, a, b]))), report);
    const get = (id: string) => doc.entities.find((e) => e.id === id)!;
    expect(parentOf(get(ok.id))).toBe(inner.id);
    expect(parentOf(get(inner.id))).toBe(g.id);
    expect(parentOf(get(orphan.id))).toBeUndefined();
    expect([parentOf(get(a.id)), parentOf(get(b.id))].filter((p) => p !== undefined).length).toBeLessThanOrEqual(1);
    expect(report.warnings.join(' ')).toMatch(/grouping link/);
  });

  it('a scene written by format v2 loads and upgrades to v3 with every v2 value intact', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/scene-v2-car.json', import.meta.url), 'utf8')) as {
      version: number;
      entities: Entity[];
    };
    expect(raw.version).toBe(2);
    const doc = sanitizeDocument(raw);
    expect(doc.version).toBe(SCENE_VERSION);
    expect(doc.entities.length).toBe(raw.entities.length);
    const tagged = doc.entities.find((e) => e.name === 'Tagged compound') as BodyEntity;
    expect(tagged.tags).toEqual(['a', 'b']);
    expect(tagged.collision).toEqual({ group: 3, mask: 0x00ff });
    expect(tagged.massOverride).toBe(7);
    expect(tagged.parts?.length).toBe(1);
    // …and saves back as a v3 file that loads identically
    expect(roundTrip(doc)).toEqual(doc);
  });
});

describe('hierarchy helpers', () => {
  it('walk children, descendants and top-level selections (cycle-safe)', () => {
    const g = createGroup({ name: 'G' });
    const h = createGroup({ name: 'H', parent: g.id });
    const a = box('a', [0, 0, 0], { parent: g.id });
    const b = box('b', [0, 0, 0], { parent: h.id });
    const c = box('c');
    const all: Entity[] = [g, h, a, b, c];
    const index = childIndex(all);
    expect(index.get(g.id)).toEqual([h.id, a.id]);
    expect(descendantIds(index, g.id).sort()).toEqual([h.id, a.id, b.id].sort());
    expect(descendantIds(index, c.id)).toEqual([]);
    expect([...withDescendants(all, [g.id, c.id])].sort()).toEqual([g.id, h.id, a.id, b.id, c.id].sort());
    expect(topLevel(all, [g.id, a.id, b.id, c.id])).toEqual([g.id, c.id]);
    expect(topLevel(all, [a.id, b.id])).toEqual([a.id, b.id]);
    // a hand-made loop terminates
    const x = createGroup({ parent: 'y' });
    const y = createGroup({ parent: x.id });
    const loop = [
      { ...x, id: 'x' },
      { ...y, id: 'y', parent: 'x' },
    ] as Entity[];
    (loop[0] as GroupEntity).parent = 'y';
    expect(descendantIds(childIndex(loop), 'x').length).toBeLessThanOrEqual(2);
    expect(topLevel(loop, ['x', 'y']).length).toBeLessThanOrEqual(2);
  });

  it('store.children / descendants follow the parent links', () => {
    const s = new SceneStore();
    const g = createGroup();
    const a = box('a', [0, 0, 0], { parent: g.id });
    const l = createLight('point', { parent: g.id });
    s.add([g, a, l]);
    expect(s.children(g.id).map((e) => e.id)).toEqual([a.id, l.id]);
    expect(s.descendants(g.id).length).toBe(2);
    expect(s.groups()).toHaveLength(1);
    expect(s.lights()).toHaveLength(1);
    expect(s.paths()).toHaveLength(0);
    expect(s.group(g.id)).toBe(g);
    expect(s.light(l.id)).toBe(l);
    expect(s.group(a.id)).toBeUndefined();
  });
});

describe('store operations', () => {
  it('add, edit, remove and undo work for every kind with precise change events', () => {
    const s = new SceneStore();
    const events: SceneChange[] = [];
    s.on('change', (c) => events.push(c));
    const g = createGroup({ name: 'Rig' });
    const l = createLight('spot');
    const p = createPath();
    s.add([g, l, p], 'Add three');
    expect(s.size).toBe(3);
    s.update(l.id, { intensity: 500, color: '#00ff00' }, 'Edit light');
    s.update(p.id, { closed: true, points: [...p.points, [0, 0, 3]] }, 'Edit path');
    s.update(g.id, { name: 'Renamed' }, 'Rename');
    expect(s.light(l.id)!.intensity).toBe(500);
    expect(s.path(p.id)!.closed).toBe(true);
    expect(s.group(g.id)!.name).toBe('Renamed');
    const last = events[events.length - 1];
    expect(last.type).toBe('update');
    s.remove([l.id], 'Delete light');
    expect(s.light(l.id)).toBeUndefined();
    expect(events[events.length - 1]).toMatchObject({ type: 'remove', ids: [l.id] });
    expect(s.undo()).toBe('Delete light');
    expect(s.light(l.id)!.intensity).toBe(500);
    expect(s.undo()).toBe('Rename');
    expect(s.group(g.id)!.name).toBe('Rig');
    expect(s.undo()).toBe('Edit path');
    expect(s.path(p.id)!.points.length).toBe(4);
    expect(s.undo()).toBe('Edit light');
    expect(s.light(l.id)!.intensity).toBe(createLight('spot').intensity);
    expect(s.redo()).toBe('Edit light');
    expect(s.light(l.id)!.color).toBe('#00ff00');
    expect(s.undo()).toBe('Edit light');
    expect(s.undo()).toBe('Add three');
    expect(s.size).toBe(0);
  });

  it('removing a group releases its members (all kinds), and undo puts the links back', () => {
    const s = new SceneStore();
    const g = createGroup();
    const a = box('a', [0, 0, 0], { parent: g.id });
    const l = createLight('point', { parent: g.id });
    const p = createPath({ parent: g.id });
    const sf = createSoft('jelly', { parent: g.id });
    s.add([g, a, l, p, sf]);
    const events: SceneChange[] = [];
    s.on('change', (c) => events.push(c));
    s.remove([g.id], 'Delete group');
    for (const e of s.all()) expect(parentOf(e)).toBeUndefined();
    expect(s.size).toBe(4);
    const upd = events.find((c) => c.type === 'update');
    expect(upd).toMatchObject({ type: 'update', keys: new Set(['parent']) });
    expect((upd as Extract<SceneChange, { type: 'update' }>).ids.sort()).toEqual([a.id, l.id, p.id, sf.id].sort());
    s.undo();
    expect(s.children(g.id).length).toBe(4);
  });

  it('reorders and selects the new kinds like any other entity', () => {
    const s = new SceneStore();
    const g = createGroup();
    const l = createLight();
    s.add([g, l]);
    expect(s.selection).toEqual([g.id, l.id]);
    s.reorder(l.id, 0);
    expect(s.all().map((e) => e.id)).toEqual([l.id, g.id]);
    expect(s.selectedBodies()).toEqual([]);
  });
});

describe('cloning', () => {
  it('a duplicated group brings its whole subtree and re-links parents to the copies', () => {
    const g = createGroup({ name: 'G', position: [0, 0, 0] });
    const inner = createGroup({ name: 'Inner', parent: g.id });
    const a = box('a', [1, 0, 0], { parent: g.id });
    const b = box('b', [2, 0, 0], { parent: inner.id });
    const l = createLight('point', { position: [0, 3, 0], parent: g.id });
    const p = createPath({ parent: inner.id });
    const bystander = box('outside', [9, 0, 0]);
    const j = createJoint({ type: 'hinge', bodyA: a.id, bodyB: b.id, anchorA: [0, 0, 0] });
    const wj = createJoint({ type: 'ball', bodyA: null, bodyB: b.id, anchorA: [2, 4, 0] });
    const all: Entity[] = [g, inner, a, b, l, p, bystander, j, wj];
    const copies = cloneEntities(all, [g.id], [10, 0, 0]);
    expect(copies.length).toBe(8); // 2 groups + 2 bodies + light + path + 2 joints; the bystander stays out
    const ids = new Set(copies.map((c) => c.id));
    expect(ids.size).toBe(8);
    for (const c of copies) expect(all.some((e) => e.id === c.id)).toBe(false);
    const group = copies.find((c) => isGroup(c) && c.name === 'G')!;
    const innerCopy = copies.find((c) => isGroup(c) && c.name === 'Inner')!;
    expect(parentOf(innerCopy)).toBe(group.id);
    const aCopy = copies.find((c) => c.name === 'a')!;
    const bCopy = copies.find((c) => c.name === 'b')!;
    expect(parentOf(aCopy)).toBe(group.id);
    expect(parentOf(bCopy)).toBe(innerCopy.id);
    expect(parentOf(copies.find(isLight)!)).toBe(group.id);
    expect(parentOf(copies.find(isPath)!)).toBe(innerCopy.id);
    near((aCopy as BodyEntity).position, [11, 0, 0]);
    near(copies.find(isLight)!.position, [10, 3, 0]);
    near((group as GroupEntity).position, [10, 0, 0]);
    // joints are re-linked between the copies; a world anchor travels with them
    const hinge = copies.find((c) => c.kind === 'joint' && c.type === 'hinge');
    expect(hinge).toMatchObject({ bodyA: aCopy.id, bodyB: bCopy.id });
    const world = copies.find((c) => c.kind === 'joint' && c.type === 'ball');
    expect(world).toMatchObject({ bodyA: null, bodyB: bCopy.id });
    near((world as { anchorA: Vec3 }).anchorA, [12, 4, 0]);
  });

  it('a copy whose group is not copied stays in the original group; document order is kept', () => {
    const g = createGroup();
    const a = box('a', [0, 0, 0], { parent: g.id });
    const l = createLight('point', { parent: g.id });
    const [ac, lc] = cloneEntities([g, a, l], [a.id, l.id]);
    expect(parentOf(ac)).toBe(g.id);
    expect(parentOf(lc)).toBe(g.id);
    expect(ac.kind).toBe('body');
    expect(lc.kind).toBe('light');
  });

  it('store.duplicate adds the copies as one undo step', () => {
    const s = new SceneStore();
    const g = createGroup();
    const a = box('a', [0, 0, 0], { parent: g.id });
    s.add([g, a]);
    const ids = s.duplicate([g.id]);
    expect(ids.length).toBe(2);
    expect(s.size).toBe(4);
    s.undo();
    expect(s.size).toBe(2);
  });
});

describe('transformGroup', () => {
  const turn = (deg: number): Quat => qfromAxisAngle([0, 1, 0], (deg * Math.PI) / 180);

  function scene() {
    const g = createGroup({ name: 'G', position: [2, 0, 0] });
    const inner = createGroup({ name: 'Inner', position: [4, 0, 0], parent: g.id });
    const a = box('a', [3, 1, 0], { parent: g.id });
    const b = box('b', [5, 1, 0], { parent: inner.id });
    const l = createLight('point', { position: [2, 4, 0], parent: g.id });
    const p = createPath({ position: [2, 0, 3], parent: g.id });
    const sf = createSoft('jelly', { position: [2, 1, -2], parent: g.id });
    const outside = box('outside', [7, 1, 0]);
    const aToB = createJoint({ type: 'hinge', bodyA: a.id, bodyB: b.id, anchorA: [1, 0, 0] });
    const pin = createJoint({ type: 'ball', bodyA: null, bodyB: a.id, anchorA: [3, 3, 0] });
    const tether = createJoint({ type: 'ball', bodyA: null, bodyB: outside.id, anchorA: [7, 3, 0] });
    const s = new SceneStore();
    s.add([g, inner, a, b, l, p, sf, outside, aToB, pin, tether]);
    return { s, g, inner, a, b, l, p, sf, outside, pin, tether };
  }

  it('translating a group moves every member by the same offset, in one undo step', () => {
    const { s, g, inner, a, b, l, p, sf, outside, pin, tether } = scene();
    s.transformGroup(g.id, { position: [12, 0, 5] });
    near(s.group(g.id)!.position, [12, 0, 5]);
    near(s.group(inner.id)!.position, [14, 0, 5]);
    near(s.body(a.id)!.position, [13, 1, 5]);
    near(s.body(b.id)!.position, [15, 1, 5]);
    near(s.light(l.id)!.position, [12, 4, 5]);
    near(s.path(p.id)!.position, [12, 0, 8]);
    near(s.soft(sf.id)!.position, [12, 1, 3]);
    near(s.body(outside.id)!.position, [7, 1, 0]); // not a member
    near(s.joint(pin.id)!.anchorA, [13, 3, 5]); // world pin of a moved body follows
    near(s.joint(tether.id)!.anchorA, [7, 3, 0]); // world pin of an outside body stays
    expect(s.undo()).toBe('Move group');
    near(s.group(g.id)!.position, [2, 0, 0]);
    near(s.body(a.id)!.position, [3, 1, 0]);
    near(s.joint(pin.id)!.anchorA, [3, 3, 0]);
    expect(s.canUndo).toBe(true); // …but only one step was taken
  });

  it('rotating a group turns members about its pivot, positions and orientations', () => {
    const { s, g, inner, a, b, l, pin } = scene();
    s.transformGroup(g.id, { rotation: turn(90) });
    // pivot (2,0,0): a at +1 x → rotating +90° about y sends +x to −z
    near(s.body(a.id)!.position, [2, 1, -1], 1e-9);
    near(s.body(b.id)!.position, [2, 1, -3], 1e-9);
    near(s.group(inner.id)!.position, [2, 0, -2], 1e-9);
    near(s.light(l.id)!.position, [2, 4, 0], 1e-9); // on the axis
    const q = s.body(a.id)!.rotation;
    near(qrot(q, [1, 0, 0]), [0, 0, -1], 1e-9);
    near(qrot(s.group(g.id)!.rotation, [1, 0, 0]), [0, 0, -1], 1e-9);
    // the world pin (3,3,0) rides the same rotation
    near(s.joint(pin.id)!.anchorA, [2, 3, -1], 1e-9);
    // rotating back restores everything
    s.transformGroup(g.id, { rotation: [0, 0, 0, 1] });
    near(s.body(a.id)!.position, [3, 1, 0], 1e-9);
    near(s.body(b.id)!.position, [5, 1, 0], 1e-9);
  });

  it('a combined move + turn equals the rigid transform p ↦ new + R·(p − old)', () => {
    const { s, g, a } = scene();
    const q = turn(35);
    s.transformGroup(g.id, { position: [-3, 1, 4], rotation: q });
    const expected = vadd([-3, 1, 4], qrot(q, [3 - 2, 1 - 0, 0 - 0]));
    near(s.body(a.id)!.position, expected, 1e-9);
  });

  it('is a no-op for a missing group and when nothing changes', () => {
    const { s, g, a } = scene();
    const before = s.body(a.id);
    const depth = s.canUndo;
    s.transformGroup('nope', { position: [1, 1, 1] });
    s.transformGroup(g.id, { position: [2, 0, 0] });
    expect(s.body(a.id)).toBe(before);
    expect(s.canUndo).toBe(depth);
  });
});

import { describe, expect, it } from 'vitest';
import { DEG, qfromAxisAngle, qrot, vadd, vlen, vsub, type Vec3 } from '../src/core/math';
import { createBody, createGroup, createJoint, createPath, createSoft, newDocument } from '../src/model/factory';
import { newReport } from '../src/model/errors';
import { pathCurveOf } from '../src/model/path';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { cloneEntities, SceneStore } from '../src/model/store';
import { defaultSpec, MAX_ARRAY_INSTANCES, sanitizeArraySpec, type ArraySpec } from '../src/model/edit/arraySpec';
import {
  buildLinkedArray,
  frameFromForward,
  gridPlacements,
  instantiateArray,
  linearPlacements,
  newPlacements,
  pathPlacements,
  placementsFor,
  previewSegments,
  radialPlacements,
  referencePoint,
  regenerateArray,
  sourceBoxes,
} from '../src/model/edit/arrays';
import type { BodyEntity, Entity, GroupEntity, JointEntity } from '../src/model/types';
import { isBody, isGroup, isJoint } from '../src/model/types';
import { run, worldOf } from './helpers';

const near = (a: Vec3, b: Vec3, tol = 1e-9) => expect(vlen(vsub(a, b))).toBeLessThan(tol);
const noPath = () => undefined;

describe('array generators', () => {
  it('radial: 4 copies about Y at radius 2 land on (2,0,0), (0,0,-2), (-2,0,0), (0,0,2)', () => {
    const pl = radialPlacements(
      { kind: 'radial', count: 4, center: [0, 0, 0], axis: [0, 1, 0], angle: 360, orient: true },
      [2, 0, 0],
    );
    expect(pl).toHaveLength(4);
    near(pl[0].position, [2, 0, 0]);
    near(pl[1].position, [0, 0, -2]);
    near(pl[2].position, [-2, 0, 0]);
    near(pl[3].position, [0, 0, 2]);
    // no copy at 360°: the last one is 270° round, not back at the start
    expect(vlen(vsub(pl[3].position, pl[0].position))).toBeGreaterThan(2);
    // orient: each copy is turned by its angle about Y
    near(qrot(pl[1].rotation, [1, 0, 0]), [0, 0, -1]);
  });

  it('radial arc: both ends occupied (180° with 3 copies = 0°, 90°, 180°); orient=false keeps the orientation', () => {
    const pl = radialPlacements(
      { kind: 'radial', count: 3, center: [1, 0, 1], axis: [0, 2, 0], angle: 180, orient: false },
      [3, 5, 1],
    );
    near(pl[0].position, [3, 5, 1]);
    near(pl[1].position, [1, 5, 1 - 2]);
    near(pl[2].position, [-1, 5, 1]);
    near(qrot(pl[2].rotation, [1, 0, 0]), [1, 0, 0]);
  });

  it('radial about a tilted axis keeps the distance to the axis', () => {
    const axis: Vec3 = [1, 1, 0];
    const centre: Vec3 = [0, 1, 0];
    const pl = radialPlacements(
      { kind: 'radial', count: 6, center: centre, axis, angle: 360, orient: true },
      [1, 3, 2],
    );
    const d = (p: Vec3) => {
      const r = vsub(p, centre);
      const a = [Math.SQRT1_2, Math.SQRT1_2, 0] as Vec3;
      const along = r[0] * a[0] + r[1] * a[1] + r[2] * a[2];
      return vlen([r[0] - along * a[0], r[1] - along * a[1], r[2] - along * a[2]]);
    };
    const d0 = d(pl[0].position);
    for (const p of pl) expect(d(p.position)).toBeCloseTo(d0, 9);
  });

  it('linear: positions step by the offset; the rotation / scale ramps compound per step', () => {
    const spec: Extract<ArraySpec, { kind: 'linear' }> = {
      kind: 'linear',
      count: 4,
      offset: [1, 0.5, 0],
      stepRotation: [0, 30, 0],
      stepScale: 1.5,
    };
    const pl = linearPlacements(spec, [1, 1, 1]);
    expect(pl).toHaveLength(4);
    near(pl[3].position, [4, 2.5, 1]);
    expect(pl[2].scale).toBeCloseTo(2.25, 12);
    near(qrot(pl[3].rotation, [1, 0, 0]), [Math.cos(90 * DEG), 0, -Math.sin(90 * DEG)]);
    expect(newPlacements(spec, [1, 1, 1], noPath)).toHaveLength(3); // the original is copy 0
  });

  it('grid: nx·ny·nz cells at the given spacings, original at the origin cell', () => {
    const pl = gridPlacements({ kind: 'grid', counts: [3, 2, 2], spacing: [1, 2, 3] }, [10, 0, 0]);
    expect(pl).toHaveLength(12);
    near(pl[0].position, [10, 0, 0]);
    near(pl[11].position, [12, 2, 3]);
    const keys = new Set(pl.map((p) => p.position.join(',')));
    expect(keys.size).toBe(12);
  });

  it('path (open): copies at equal arc length from the first to the last point, upright, facing along the path', () => {
    const path = createPath({
      position: [0, 1, 0],
      points: [
        [0, 0, 0],
        [5, 0, 0],
        [10, 0, 0],
      ],
    });
    const spec: Extract<ArraySpec, { kind: 'path' }> = {
      kind: 'path',
      pathId: path.id,
      count: 5,
      orient: true,
      forward: 'x',
      offset: [0, 0, 0],
    };
    const pl = pathPlacements(spec, path);
    expect(pl).toHaveLength(5);
    const xs = pl.map((p) => p.position[0]);
    xs.forEach((x, k) => expect(x).toBeCloseTo((k * 10) / 4, 6));
    for (const p of pl) near(qrot(p.rotation, [1, 0, 0]), [1, 0, 0], 1e-6);
  });

  it('path (closed): equal arc-length spacing and no duplicate at the end', () => {
    const path = createPath({
      position: [1, 0, -1],
      rotation: qfromAxisAngle([0, 1, 0], 0.4),
      closed: true,
      points: [
        [-3, 0, -3],
        [3, 0, -3],
        [3, 0, 3],
        [-3, 0, 3],
      ],
    });
    const curve = pathCurveOf(path);
    const pl = pathPlacements(
      { kind: 'path', pathId: path.id, count: 7, orient: false, forward: 'x', offset: [0, 0, 0] },
      path,
    );
    expect(pl).toHaveLength(7);
    // Each copy sits at k·L/7 of arc length: its arc-length coordinate (found by projecting on the curve) matches.
    pl.forEach((p, k) => {
      near(p.position, curve.positionAtDistance((k * curve.length) / 7), 1e-9);
    });
    // The last copy is a full spacing short of the first (not coincident with it).
    expect(vlen(vsub(pl[6].position, pl[0].position))).toBeGreaterThan(0.5 * (curve.length / 7));
    // Equal arc spacing: consecutive arc distances are all L/7.
    for (let k = 1; k < 7; k++) {
      const a = curve.distanceAt(curve.tAtDistance((k * curve.length) / 7));
      const b = curve.distanceAt(curve.tAtDistance(((k - 1) * curve.length) / 7));
      expect(a - b).toBeCloseTo(curve.length / 7, 6);
    }
  });

  it('path with orientation: forward z follows a path along x and a hanging path turns the copy upright-ish', () => {
    const q = frameFromForward([1, 0, 0], 'z');
    near(qrot(q, [0, 0, 1]), [1, 0, 0], 1e-9);
    near(qrot(q, [0, 1, 0]), [0, 1, 0], 1e-9);
    const slope = frameFromForward(vlenNorm([1, 1, 0]), 'x');
    near(qrot(slope, [1, 0, 0]), vlenNorm([1, 1, 0]), 1e-9);
    // the local Y axis keeps a positive vertical component (a tilted path does not roll the copy upside down)
    expect(qrot(slope, [0, 1, 0])[1]).toBeGreaterThan(0);
    // straight up: no unique "upright"; still a valid rotation taking forward onto the tangent
    near(qrot(frameFromForward([0, 1, 0], 'x'), [1, 0, 0]), [0, 1, 0], 1e-9);
  });

  it('path offset is applied in the path-aligned frame when oriented, in world axes otherwise', () => {
    const path = createPath({
      position: [0, 0, 0],
      points: [
        [0, 0, 0],
        [0, 0, 10],
      ],
    });
    const o = pathPlacements(
      { kind: 'path', pathId: path.id, count: 2, orient: true, forward: 'z', offset: [0, 1, 0] },
      path,
    );
    near(o[0].position, [0, 1, 0]);
    const w = pathPlacements(
      { kind: 'path', pathId: path.id, count: 2, orient: false, forward: 'z', offset: [0, 1, 0] },
      path,
    );
    near(w[1].position, [0, 1, 10]);
  });

  it('a missing or degenerate path yields no placements', () => {
    expect(pathPlacements({ ...(defaultSpec('path') as Extract<ArraySpec, { kind: 'path' }>) }, undefined)).toEqual([]);
  });

  it('placementsFor routes to the right generator', () => {
    expect(placementsFor(defaultSpec('linear'), [0, 0, 0], noPath)).toHaveLength(5);
    expect(placementsFor(defaultSpec('grid'), [0, 0, 0], noPath)).toHaveLength(9);
    expect(placementsFor(defaultSpec('radial'), [0, 0, 0], noPath)).toHaveLength(8);
  });
});

function vlenNorm(v: Vec3): Vec3 {
  const l = vlen(v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function mechanism(): { entities: Entity[]; ids: string[]; hinge: JointEntity; bob: BodyEntity; post: BodyEntity } {
  const post = createBody({
    name: 'Post',
    shape: { type: 'box', size: [0.3, 0.3, 0.3] },
    position: [2, 3, 0],
    bodyType: 'static',
  });
  const bob = createBody({
    name: 'Bob',
    shape: { type: 'box', size: [0.6, 0.2, 0.2] },
    position: [2.5, 3, 0],
    velocity: [0, 1, 0],
    linearDamping: 0,
    angularDamping: 0,
    canSleep: false,
  });
  const hinge = createJoint({
    type: 'hinge',
    bodyA: post.id,
    bodyB: bob.id,
    anchorA: [0, 0, 0],
    anchorB: [-0.5, 0, 0],
    axis: [0, 0, 1],
  });
  return { entities: [post, bob, hinge], ids: [post.id, bob.id], hinge, bob, post };
}

describe('instantiateArray', () => {
  it('clones the set once per placement with new ids; joints inside the set are cloned per instance', () => {
    const { entities, ids } = mechanism();
    const ref = referencePoint(entities, ids);
    const pl = newPlacements(
      { kind: 'radial', count: 4, center: [0, 3, 0], axis: [0, 1, 0], angle: 360, orient: true },
      ref,
      noPath,
    );
    const inst = instantiateArray(entities, ids, pl, ref);
    expect(pl).toHaveLength(3);
    expect(inst.entities.filter(isBody)).toHaveLength(6);
    expect(inst.entities.filter(isJoint)).toHaveLength(3);
    const all = new Set([...entities.map((e) => e.id), ...inst.entities.map((e) => e.id)]);
    expect(all.size).toBe(3 + 9);
    // every cloned joint connects two cloned bodies of the same instance
    for (const j of inst.entities.filter(isJoint)) {
      expect(inst.entities.some((e) => e.id === j.bodyA)).toBe(true);
      expect(inst.entities.some((e) => e.id === j.bodyB)).toBe(true);
    }
    // 90° about Y: the post at (2,3,0) goes to (0,3,-2), the velocity (0,1,0) is unchanged by a turn about Y
    const posts = inst.entities.filter((e): e is BodyEntity => isBody(e) && e.name === 'Post');
    near(posts[0].position, [0, 3, -2]);
    near(posts[1].position, [-2, 3, 0]);
  });

  it('velocities rotate with the copy', () => {
    const b = createBody({ position: [1, 0, 0], velocity: [3, 0, 0], angularVelocity: [0, 0, 2] });
    const ref = referencePoint([b], [b.id]);
    const [pl] = newPlacements(
      { kind: 'radial', count: 4, center: [0, 0, 0], axis: [0, 1, 0], angle: 360, orient: true },
      ref,
      noPath,
    );
    const c = instantiateArray([b], [b.id], [pl], ref).entities[0] as BodyEntity;
    near(c.position, [0, 0, -1]);
    near(c.velocity, [0, 0, -3], 1e-9);
    near(c.angularVelocity, [2, 0, 0], 1e-9);
  });

  it('a joint to a body outside the set is not cloned; a world-anchored joint follows its copy', () => {
    const a = createBody({ position: [0, 1, 0] });
    const outside = createBody({ position: [3, 1, 0] });
    const toOutside = createJoint({
      type: 'ball',
      bodyA: a.id,
      bodyB: outside.id,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
    });
    const toWorld = createJoint({ type: 'spring', bodyA: null, bodyB: a.id, anchorA: [0, 5, 0], anchorB: [0, 0.5, 0] });
    const ref = referencePoint([a], [a.id]);
    const inst = instantiateArray(
      [a, outside, toOutside, toWorld],
      [a.id],
      [{ position: [2, 1, 0], rotation: [0, 0, 0, 1], scale: 1 }],
      ref,
    );
    const js = inst.entities.filter(isJoint);
    expect(js).toHaveLength(1);
    near(js[0].anchorA, [2, 5, 0]); // world end moved with the copy
    expect(js[0].bodyB).not.toBe(a.id);
  });

  it('scale ramp scales sizes, offsets from the reference and joint anchors', () => {
    const { entities, ids } = mechanism();
    const ref = referencePoint(entities, ids);
    const inst = instantiateArray(entities, ids, [{ position: ref, rotation: [0, 0, 0, 1], scale: 2 }], ref);
    const bob = inst.entities.find((e): e is BodyEntity => isBody(e) && e.name === 'Bob')!;
    expect(bob.shape.size).toEqual([1.2, 0.4, 0.4]);
    // original bob was 0.25 from ref in x (post -0.25, bob +0.25): now 0.5
    expect(bob.position[0] - ref[0]).toBeCloseTo(0.5, 12);
    const j = inst.entities.find(isJoint)!;
    expect(j.anchorB).toEqual([-1, 0, 0]);
  });

  it('copies of groups keep their members under the copied group; names are renamed per placement', () => {
    const g = createGroup({ name: 'Rig', position: [0, 0, 0] });
    const b = createBody({ name: 'Part', position: [1, 1, 0], parent: g.id });
    const inst = instantiateArray(
      [g, b],
      [g.id],
      [{ position: [5, 0, 0], rotation: [0, 0, 0, 1], scale: 1 }],
      [0, 0, 0],
      {
        rename: (n, i) => `${n} #${i + 2}`,
      },
    );
    const cg = inst.entities.find(isGroup)!;
    const cb = inst.entities.find(isBody)!;
    expect(cb.parent).toBe(cg.id);
    expect(cg.name).toBe('Rig #2');
    expect(inst.roots).toEqual([cg.id]);
  });

  it('copies behave exactly like the original in the engine (4 hinged pendulums around a circle)', async () => {
    const { entities, ids, bob } = mechanism();
    const ref = referencePoint(entities, ids);
    const pl = newPlacements(
      { kind: 'radial', count: 4, center: [0, 3, 0], axis: [0, 1, 0], angle: 360, orient: true },
      ref,
      noPath,
    );
    const inst = instantiateArray(entities, ids, pl, ref);
    const w = await worldOf([...entities, ...inst.entities], { gravity: [0, -9.81, 0] });
    run(w, 1);
    const p0 = w.getPose(bob.id)!;
    expect(vlen(vsub(p0.position, bob.position))).toBeGreaterThan(0.3); // it swung
    const bobs = inst.entities.filter((e): e is BodyEntity => isBody(e) && e.name === 'Bob');
    bobs.forEach((b, k) => {
      const q = qfromAxisAngle([0, 1, 0], (k + 1) * 90 * DEG);
      const rel = vsub(p0.position, [0, 3, 0]);
      const want = vadd([0, 3, 0], qrot(q, rel));
      near(w.getPose(b.id)!.position, want, 5e-3);
    });
  });
});

describe('preview geometry', () => {
  it('boxes of the sources are drawn once per placement: 12 edges per box', () => {
    const { entities, ids } = mechanism();
    const boxes = sourceBoxes(entities, ids);
    expect(boxes).toHaveLength(2);
    near(boxes[1].half, [0.3, 0.1, 0.1]);
    const ref = referencePoint(entities, ids);
    const pl = newPlacements(defaultSpec('linear'), ref, noPath);
    const seg = previewSegments(boxes, pl, ref);
    expect(seg.boxes).toBe(2 * 4);
    expect(seg.positions.length).toBe(2 * 4 * 24 * 3);
    expect(seg.truncated).toBe(false);
    // First segment of the first box of the first copy starts at a corner of the post shifted by one offset.
    const first: Vec3 = [seg.positions[0], seg.positions[1], seg.positions[2]];
    near(first, [2 - 0.15 + 1.5, 3 - 0.15, -0.15], 1e-5);
    expect(previewSegments(boxes, pl, ref, 3).truncated).toBe(true);
  });

  it('a compound body is outlined by the union of its parts, a soft body by its size', () => {
    const s = createSoft('cloth', { size: [2, 0.1, 1] });
    expect(sourceBoxes([s], [s.id])[0].half).toEqual([1, 0.02, 0.5]);
  });
});

describe('linked arrays', () => {
  function scene() {
    const { entities, ids, post } = mechanism();
    const s = new SceneStore();
    s.add(entities, 'Add', false);
    return { s, ids, post };
  }

  it('buildLinkedArray: a group at the reference holds the instances and the definition; sources stay outside', () => {
    const { s, ids } = scene();
    const spec: ArraySpec = { kind: 'linear', count: 4, offset: [0, 0, 2], stepRotation: [0, 0, 0], stepScale: 1 };
    const { group, entities } = buildLinkedArray(s.all(), ids, spec, 'Array');
    expect(group.array?.sourceIds.sort()).toEqual([...ids].sort());
    near(group.position, [2.25, 3, 0]);
    s.add([group, ...entities], 'Array', false);
    expect(s.children(group.id).filter((e) => e.kind === 'body')).toHaveLength(6);
    expect(s.bodies()).toHaveLength(2 + 6);
    expect(s.joints()).toHaveLength(1 + 3);
    for (const id of ids) expect(s.get(id)).toBeDefined();
    expect(ids.every((id) => !s.descendants(group.id).some((d) => d.id === id))).toBe(true);
  });

  it('regenerating with new parameters replaces the instances in ONE undo step', () => {
    const { s, ids } = scene();
    const { group, entities } = buildLinkedArray(s.all(), ids, {
      kind: 'linear',
      count: 4,
      offset: [0, 0, 2],
      stepRotation: [0, 0, 0],
      stepScale: 1,
    });
    s.add([group, ...entities], 'Array', false);
    const before = s.all().length;
    const spec: ArraySpec = { kind: 'linear', count: 3, offset: [0, 0, 3], stepRotation: [0, 0, 0], stepScale: 1 };
    const re = regenerateArray(s.all(), group.id, spec)!;
    s.transact('Update array', () => {
      s.remove(re.remove, 'Update array');
      s.add(re.add, 'Update array', false);
      s.update(group.id, re.group, 'Update array');
    });
    expect(s.bodies().filter((b) => b.name === 'Bob')).toHaveLength(1 + 2);
    expect(s.group(group.id)?.array?.spec).toEqual(spec);
    const zs = s
      .bodies()
      .filter((b) => b.name === 'Post')
      .map((b) => b.position[2])
      .sort((a, b) => a - b);
    expect(zs).toEqual([0, 3, 6]);
    expect(s.undo()).toBe('Update array');
    expect(s.all().length).toBe(before);
    expect(s.group(group.id)?.array?.spec).toMatchObject({ count: 4 });
    expect(s.canUndo).toBe(true); // the 'Array' add is still its own step
  });

  it('editing the SOURCE and regenerating propagates the change to every instance', () => {
    const { s, ids, post } = scene();
    const { group, entities } = buildLinkedArray(s.all(), ids, {
      kind: 'linear',
      count: 3,
      offset: [0, 0, 2],
      stepRotation: [0, 0, 0],
      stepScale: 1,
    });
    s.add([group, ...entities], 'Array', false);
    s.update(post.id, { material: { ...post.material, color: '#ff0000' } }, 'Recolour');
    const re = regenerateArray(s.all(), group.id)!;
    s.transact('Update array', () => {
      s.remove(re.remove);
      s.add(re.add, 'x', false);
    });
    const posts = s.bodies().filter((b) => b.name === 'Post');
    expect(posts).toHaveLength(3);
    expect(posts.every((p) => p.material.color === '#ff0000')).toBe(true);
  });

  it('regenerate reports a missing source or path instead of producing nothing silently', () => {
    const { s, ids } = scene();
    const { group, entities } = buildLinkedArray(s.all(), ids, defaultSpec('linear'));
    s.add([group, ...entities], 'Array', false);
    s.remove([ids[0]]);
    expect(() => regenerateArray(s.all(), group.id)).toThrow(/gone/);
    const { s: s2, ids: ids2 } = scene();
    const g2 = createGroup({
      array: {
        sourceIds: ids2,
        spec: { ...(defaultSpec('path') as Extract<ArraySpec, { kind: 'path' }>), pathId: 'nope' },
      },
    });
    s2.add([g2], 'x', false);
    expect(() => regenerateArray(s2.all(), g2.id)).toThrow(/path/i);
  });

  it('a path-following linked array places copies on the path and leaves the source alone', () => {
    const { s, ids } = scene();
    const path = createPath({
      points: [
        [0, 0, 5],
        [0, 0, 15],
      ],
    });
    s.add([path], 'p', false);
    const { group, entities } = buildLinkedArray(s.all(), ids, {
      kind: 'path',
      pathId: path.id,
      count: 3,
      orient: false,
      forward: 'x',
      offset: [0, 0, 0],
    });
    s.add([group, ...entities], 'x', false);
    const zs = s
      .bodies()
      .filter((b) => b.name === 'Post' && b.parent === group.id)
      .map((b) => b.position[2]);
    // reference z = 0 maps onto the path points z = 5, 10, 15 (the post is at reference z = 0)
    expect(zs.sort((a, b) => a - b).map((v) => Math.round(v * 1000) / 1000)).toEqual([5, 10, 15]);
    expect(s.body(ids[0])!.position[2]).toBe(0);
  });

  it('survives save / load; a missing source turns the group into a plain one with a warning', () => {
    const { s, ids } = scene();
    const spec: ArraySpec = { kind: 'radial', count: 3, center: [0, 3, 0], axis: [0, 1, 0], angle: 180, orient: false };
    const { group, entities } = buildLinkedArray(s.all(), ids, spec);
    s.add([group, ...entities], 'Array', false);
    const doc = s.toDocument();
    const text = serializeDocument(doc);
    const report = newReport();
    const back = parseDocument(text, report);
    const g = back.entities.find((e): e is GroupEntity => isGroup(e) && e.id === group.id)!;
    expect(g.array).toEqual(group.array);
    expect(report.warnings).toEqual([]);
    // sanitise twice: idempotent
    expect(sanitizeDocument(JSON.parse(serializeDocument(back))).entities.find((e) => e.id === group.id)).toEqual(g);
    // drop a source from the raw file
    const raw = JSON.parse(text) as { entities: { id: string }[] };
    raw.entities = raw.entities.filter((e) => e.id !== ids[0]);
    const rep2 = newReport();
    const loaded = sanitizeDocument(raw, rep2);
    const g2 = loaded.entities.find((e): e is GroupEntity => isGroup(e) && e.id === group.id)!;
    expect(g2.array).toBeUndefined();
    expect(rep2.warnings.join(' ')).toMatch(/linked array/);
  });

  it('sanitising repairs garbage array fields', () => {
    const doc = newDocument();
    const g = createGroup();
    const raw: unknown = JSON.parse(
      JSON.stringify({
        ...doc,
        entities: [{ ...g, array: { sourceIds: ['x', 7, ''], spec: { kind: 'wat', count: 1e9 } } }],
      }),
    );
    const clean = sanitizeDocument(raw);
    // no such source → dropped
    expect((clean.entities[0] as GroupEntity).array).toBeUndefined();
    const spec = sanitizeArraySpec({ kind: 'grid', counts: [100, 100, 100], spacing: [1, 'a', 3] });
    expect(spec.kind === 'grid' && spec.counts[0] * spec.counts[1] * spec.counts[2]).toBeLessThanOrEqual(
      MAX_ARRAY_INSTANCES,
    );
    expect(sanitizeArraySpec({ kind: 'linear', count: -4 })).toMatchObject({ kind: 'linear', count: 1 });
    expect(sanitizeArraySpec(null).kind).toBe('linear');
  });

  it('duplicating the array group alone makes an independent group; duplicating it with its sources keeps a re-pointed link', () => {
    const { s, ids } = scene();
    const { group, entities } = buildLinkedArray(s.all(), ids, defaultSpec('linear'));
    s.add([group, ...entities], 'Array', false);
    const alone = cloneEntities(s.all(), [group.id]);
    const cg = alone.find(isGroup)!;
    expect(cg.array).toBeUndefined();
    const both = cloneEntities(s.all(), [group.id, ...ids]);
    const lg = both.find(isGroup)!;
    expect(lg.array).toBeDefined();
    const newIds = new Set(both.map((e) => e.id));
    expect(lg.array!.sourceIds.every((id) => newIds.has(id) && !ids.includes(id))).toBe(true);
  });

  it('deleting the group removes the array definition; its former instances stay as ordinary objects', () => {
    const { s, ids } = scene();
    const { group, entities } = buildLinkedArray(s.all(), ids, defaultSpec('linear'));
    s.add([group, ...entities], 'Array', false);
    s.remove([group.id]);
    expect(s.group(group.id)).toBeUndefined();
    expect(s.bodies()).toHaveLength(2 + 8);
    expect(s.bodies().every((b) => b.parent === undefined)).toBe(true);
  });
});

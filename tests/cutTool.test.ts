/** Cut tool geometry and document edit (src/app/cutTool.ts, src/model/shapes/chunk.ts) against the real engine. */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, vadd, vlen, type Quat, type Vec3 } from '../src/core/math';
import { applyCut, canCut, planeCutBody } from '../src/app/cutTool';
import { createBody, createJoint } from '../src/model/factory';
import { parseDocument, serializeDocument } from '../src/model/serialize';
import {
  makeShapeSpec,
  sanitizeShapeSpec,
  shapeBoundingRadius,
  shapeColliders,
  shapeConvexPoints,
  shapeVolume,
} from '../src/model/shapeRegistry';
import { SceneStore } from '../src/model/store';
import type { BodyEntity } from '../src/model/types';
import { initRapier } from '../src/physics/world';
import { run, worldOf } from './helpers';

beforeAll(async () => {
  await initRapier();
});

const massOf = (b: BodyEntity) => shapeVolume(b.shape) * b.material.density;
const boxBody = (over: Partial<BodyEntity> & { size?: Vec3 } = {}) => {
  const { size, ...rest } = over;
  return createBody({ shape: { type: 'box', size: size ?? [2, 1, 1] }, material: 'wood', ...rest });
};

/** World-space bounding box of a chunk body from its convex points. */
function worldBox(b: BodyEntity): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const pts = makeChunkPoints(b);
  for (const p of pts) {
    const w = vadd(b.position, qrot(b.rotation, p));
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], w[k]);
      max[k] = Math.max(max[k], w[k]);
    }
  }
  return { min, max };
}
const makeChunkPoints = (b: BodyEntity): Vec3[] => shapeConvexPoints(b.shape) ?? [];

describe('planeCutBody', () => {
  it('halves a box through its centre: two bodies of half the mass each, centroids at the quarter points', () => {
    const body = boxBody({ position: [1, 2, 3] });
    const m0 = massOf(body);
    const r = planeCutBody(body, [1, 2, 3], [1, 0, 0])!;
    expect(r).not.toBeNull();
    expect(r.a.shape.type).toBe('chunk');
    expect(massOf(r.a)).toBeCloseTo(m0 / 2, 1);
    expect(massOf(r.b)).toBeCloseTo(m0 / 2, 1);
    expect(massOf(r.a) + massOf(r.b)).toBeCloseTo(m0, 9);
    expect(r.a.position[0]).toBeCloseTo(1.5, 3);
    expect(r.b.position[0]).toBeCloseTo(0.5, 3);
    expect(r.a.position[1]).toBeCloseTo(2, 3);
    expect(r.a.name).toBe('Box (cut A)');
    expect(r.b.name).toBe('Box (cut B)');
    // each half is 1 x 1 x 1
    for (const h of [r.a, r.b]) {
      expect(h.shape.size[0]).toBeCloseTo(1, 3);
      expect(h.shape.size[1]).toBeCloseTo(1, 3);
      expect(h.shape.size[2]).toBeCloseTo(1, 3);
    }
  });

  it('an off-centre cut splits the mass 25 / 75', () => {
    const body = boxBody({ size: [4, 1, 1] }); // x in [-2, 2]
    const r = planeCutBody(body, [-1, 0, 0], [1, 0, 0])!;
    const m0 = massOf(body);
    expect(massOf(r.b)).toBeCloseTo(m0 * 0.25, 1); // x in [-2, -1]
    expect(massOf(r.a)).toBeCloseTo(m0 * 0.75, 1);
    expect(r.b.position[0]).toBeCloseTo(-1.5, 3);
    expect(r.a.position[0]).toBeCloseTo(0.5, 3);
  });

  it('cuts a rotated body: pieces keep the rotation and the world bounding boxes tile the original', () => {
    const q: Quat = qfromAxisAngle([0, 0, 1], Math.PI / 4);
    const body = boxBody({ size: [2, 2, 2], rotation: q, position: [0, 5, 0] });
    const r = planeCutBody(body, [0, 5, 0], [0, 1, 0])!;
    expect(r.a.rotation).toEqual(q);
    expect(massOf(r.a) + massOf(r.b)).toBeCloseTo(massOf(body), 9);
    expect(massOf(r.a)).toBeCloseTo(massOf(r.b), 1);
    const A = worldBox(r.a),
      B = worldBox(r.b);
    // the upper piece sits on the plane y = 5, the lower one under it
    expect(A.min[1]).toBeCloseTo(5, 3);
    expect(B.max[1]).toBeCloseTo(5, 3);
    // a cube turned 45 degrees about z reaches sqrt(2) in x and y
    expect(A.max[1]).toBeCloseTo(5 + Math.SQRT2, 3);
    expect(B.min[1]).toBeCloseTo(5 - Math.SQRT2, 3);
    expect(Math.max(A.max[0], B.max[0])).toBeCloseTo(Math.SQRT2, 3);
  });

  it('returns null when the plane misses the body', () => {
    expect(planeCutBody(boxBody(), [10, 0, 0], [1, 0, 0])).toBeNull();
    expect(planeCutBody(boxBody({ parts: [] }), [0, 0, 0], [1, 0, 0])).not.toBeNull();
  });

  it('cuts curved shapes by sampling and still conserves their mass exactly', () => {
    for (const type of ['sphere', 'cylinder', 'capsule', 'cone', 'wedge', 'prism'] as const) {
      const body = createBody({ shape: { type }, material: 'steel' });
      const r = planeCutBody(body, body.position, [0.3, 1, 0.2]);
      expect(r, type).not.toBeNull();
      expect(massOf(r!.a) + massOf(r!.b), type).toBeCloseTo(massOf(body), 6);
      expect(r!.a.shape.type).toBe('chunk');
    }
    // a sphere cut at the equator is symmetric
    const s = createBody({ shape: { type: 'sphere', size: [2, 2, 2] } });
    const r = planeCutBody(s, [0, 0, 0], [0, 1, 0])!;
    expect(massOf(r.a) / massOf(r.b)).toBeCloseTo(1, 1);
    // centroid of a hemisphere: 3r/8 from the centre
    expect(r.a.position[1]).toBeGreaterThan(0.33);
    expect(r.a.position[1]).toBeLessThan(0.42);
  });

  it('splits an explicit mass proportionally and keeps the material, flags and velocity', () => {
    const body = boxBody({
      massOverride: 10,
      velocity: [1, 0, 0],
      angularVelocity: [0, 0, 2],
      tags: ['x'],
      layer: 'main',
      linearDamping: 0.3,
    });
    const r = planeCutBody(body, [-0.5, 0, 0], [1, 0, 0])!; // 25 / 75
    expect(r.b.massOverride! + r.a.massOverride!).toBeCloseTo(10, 9);
    expect(r.b.massOverride!).toBeCloseTo(2.5, 1);
    expect(r.a.material.preset).toBe(body.material.preset);
    expect(r.a.tags).toEqual(['x']);
    expect(r.b.layer).toBe('main');
    expect(r.a.linearDamping).toBe(0.3);
    // v + w x r : a at x = +0.25 -> (0,0,2) x (0.25,0,0) = (0, 0.5, 0)
    expect(r.a.velocity[1]).toBeCloseTo(0.5, 1);
    expect(r.a.velocity[0]).toBeCloseTo(1, 6);
  });

  it('static bodies stay static and motionless', () => {
    const r = planeCutBody(boxBody({ bodyType: 'static', velocity: [3, 0, 0] }), [0, 0, 0], [0, 1, 0])!;
    expect(r.a.bodyType).toBe('static');
    expect(r.a.velocity).toEqual([0, 0, 0]);
  });

  it('keeps a joint on the half that contains its anchor', () => {
    const body = boxBody({ position: [0, 1, 0] });
    const j = createJoint({ type: 'ball', bodyA: body.id, bodyB: null, anchorA: [0.8, 0, 0], anchorB: [0.8, 1, 0] });
    const r = planeCutBody(body, [0, 1, 0], [1, 0, 0], { joints: [j] })!;
    expect(r.joints).toHaveLength(1);
    expect(r.joints[0].bodyA).toBe(r.a.id); // x = +0.8 is on the +x side
    // the anchor still sits at the same world point
    const w = vadd(r.a.position, qrot(r.a.rotation, r.joints[0].anchorA));
    expect(w[0]).toBeCloseTo(0.8, 3);
    expect(w[1]).toBeCloseTo(1, 3);
  });

  it('a chunk survives save and load: the point list is a sanitised, kept parameter', () => {
    const r = planeCutBody(boxBody(), [0, 0, 0], [1, 1, 0])!;
    const store = new SceneStore();
    store.add([r.a, r.b]);
    const doc = parseDocument(serializeDocument(store.toDocument()));
    const back = doc.entities.find((e) => e.id === r.a.id) as BodyEntity;
    expect(back.shape.params?.pts).toBe(r.a.shape.params?.pts);
    expect(shapeVolume(back.shape)).toBeCloseTo(shapeVolume(r.a.shape), 12);
    // garbage and over-long text are repaired, never thrown on
    expect(sanitizeShapeSpec({ type: 'chunk', params: { pts: 42 } }).params).toEqual({ pts: '' });
    expect(sanitizeShapeSpec({ type: 'chunk', params: { pts: 'x'.repeat(50000) } }).params!.pts).toHaveLength(24000);
    expect(shapeVolume(makeShapeSpec('chunk', undefined, { pts: '1,2;nope;a,b,c' }))).toBeGreaterThan(0);
  });

  it('resizing a chunk scales its volume and bounding radius', () => {
    const r = planeCutBody(boxBody(), [0, 0, 0], [1, 0, 0])!;
    const doubled = {
      ...r.a.shape,
      size: [r.a.shape.size[0] * 2, r.a.shape.size[1] * 2, r.a.shape.size[2] * 2] as Vec3,
    };
    expect(shapeVolume(doubled)).toBeCloseTo(shapeVolume(r.a.shape) * 8, 9);
    expect(shapeBoundingRadius(doubled)).toBeCloseTo(shapeBoundingRadius(r.a.shape) * 2, 9);
  });

  it('collider mass equals density x volume in the real engine', () => {
    const r = planeCutBody(boxBody({ size: [1.3, 0.7, 2.1] }), [0.1, 0, 0], [1, 0.4, 0.2])!;
    for (const h of [r.a, r.b]) {
      const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
      const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
      for (const c of shapeColliders(RAPIER, h.shape)) world.createCollider(c.desc.setDensity(h.material.density), rb);
      expect(rb.mass() / massOf(h)).toBeCloseTo(1, 2);
      world.free();
    }
  });
});

describe('applyCut (the document edit)', () => {
  it('cuts several bodies as one undo step and selects the halves', () => {
    const store = new SceneStore();
    const a = boxBody({ position: [0, 1, 0] });
    const b = boxBody({ position: [5, 1, 0] });
    const locked = boxBody({ position: [10, 1, 0], locked: true });
    store.add([a, b, locked]);
    expect(canCut(locked)).toBe(false);
    const n = applyCut(store, [a.id, b.id, locked.id], (x) => ({ point: x.position, normal: [1, 0, 0] }));
    expect(n).toBe(2);
    expect(store.bodies()).toHaveLength(5); // 2 x 2 halves + the locked one
    expect(store.selection).toHaveLength(4);
    expect(store.undoLabel).toBe('Cut 2 bodies');
    store.undo();
    expect(store.bodies().map((x) => x.id)).toEqual([a.id, b.id, locked.id]);
    store.redo();
    expect(store.bodies()).toHaveLength(5);
  });

  it('re-attaches joints, also between two bodies that are both cut, and undo restores them', () => {
    const store = new SceneStore();
    const a = boxBody({ position: [0, 1, 0] });
    const b = boxBody({ position: [3, 1, 0] });
    const j = createJoint({ type: 'fixed', bodyA: a.id, bodyB: b.id, anchorA: [1, 0, 0], anchorB: [-1, 0, 0] });
    store.add([a, b, j]);
    expect(applyCut(store, [a.id, b.id], (x) => ({ point: x.position, normal: [0, 1, 0] }))).toBe(2);
    expect(store.joints()).toHaveLength(1);
    const nj = store.joints()[0];
    expect(store.body(nj.bodyA)).toBeDefined();
    expect(store.body(nj.bodyB)).toBeDefined();
    expect(nj.bodyA).not.toBe(a.id);
    expect(nj.bodyB).not.toBe(b.id);
    store.undo();
    expect(store.joints()[0].bodyA).toBe(a.id);
    expect(store.joints()[0].bodyB).toBe(b.id);
  });

  it('does nothing (and records no history) when the plane misses', () => {
    const store = new SceneStore();
    const a = boxBody();
    store.add([a]);
    const before = store.undoLabel;
    expect(applyCut(store, [a.id], () => ({ point: [50, 0, 0], normal: [1, 0, 0] }))).toBe(0);
    expect(store.undoLabel).toBe(before);
    expect(store.bodies()).toHaveLength(1);
  });
});

describe('cut pieces in the real engine', () => {
  it('both halves of a cut box build, fall onto the ground and settle without exploding', async () => {
    const body = boxBody({ size: [1, 1, 1], position: [0, 2, 0] });
    const r = planeCutBody(body, body.position, [1, 0.3, 0])!;
    const world = await worldOf([r.a, r.b]);
    run(world, 4);
    for (const h of [r.a, r.b]) {
      const p = world.getPose(h.id)!;
      expect(p.position.every(Number.isFinite)).toBe(true);
      expect(vlen(p.position)).toBeLessThan(10);
      // resting on the ground: the lowest point of the piece is at y ~ 0
      expect(p.position[1]).toBeGreaterThan(0.05);
      expect(p.position[1]).toBeLessThan(1);
    }
    world.dispose();
  });

  it('the pieces hold the same total mass as the original in the engine', async () => {
    const body = boxBody({ size: [1, 2, 0.5], position: [0, 3, 0] });
    const r = planeCutBody(body, body.position, [0, 1, 0])!;
    const w0 = await worldOf([body]);
    const w1 = await worldOf([r.a, r.b]);
    const total = (w: Awaited<ReturnType<typeof worldOf>>) => {
      let m = 0;
      w.world.forEachRigidBody((rb) => {
        if (rb.isDynamic()) m += rb.mass();
      });
      return m;
    };
    expect(total(w0)).toBeGreaterThan(0);
    expect(total(w1) / total(w0)).toBeCloseTo(1, 2);
    w0.dispose();
    w1.dispose();
  });
});

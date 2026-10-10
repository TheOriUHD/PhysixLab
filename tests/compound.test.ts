/**
 * Compound bodies (`BodyEntity.parts`): one rigid body with a collider per part. Mass, centre of mass and
 * inertia are checked against analytic values, the dynamics against a physical pendulum and a spinning fall,
 * part material overrides against a friction slope, and the sanitiser / helpers against hostile input.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, qtwist, vlen, type Vec3 } from '../src/core/math';
import {
  compoundVolume,
  isCompound,
  makePart,
  massEstimate,
  naturalMass,
  partMaterial,
  scaleParts,
} from '../src/model/compound';
import { newReport } from '../src/model/errors';
import { createBody, createJoint, newDocument } from '../src/model/factory';
import { LIMITS } from '../src/model/limits';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { makeShapeSpec, registerShape, shapeVolume, type ShapeDef } from '../src/model/shapeRegistry';
import type { BodyEntity } from '../src/model/types';
import { PhysicsWorld, initRapier } from '../src/physics/world';
import { docOf, run } from './helpers';

const free = { linearDamping: 0, angularDamping: 0, canSleep: false };
const noGround = { ground: { enabled: false, friction: 0.5, restitution: 0, halfSize: 50, color: '#000' } };
const G = 9.81;
const RHO = 1000;
const mat = { preset: 'custom', density: RHO };

const sphere = (r: number, at: Vec3, extra: Record<string, unknown> = {}) =>
  makePart({ shape: { type: 'sphere', size: [2 * r, 2 * r, 2 * r] }, position: at, ...extra });
const box = (size: Vec3, at: Vec3, extra: Record<string, unknown> = {}) =>
  makePart({ shape: { type: 'box', size }, position: at, ...extra });

const compound = (parts: ReturnType<typeof makePart>[], over: Record<string, unknown> = {}): BodyEntity =>
  createBody({ shape: { type: 'box', size: [1, 1, 1] }, material: mat, parts, ...free, ...over });

const build = async (entities: BodyEntity[], settings = {}) => {
  await initRapier();
  const w = new PhysicsWorld(docOf([], settings));
  const recs = entities.map((e) => w.addBody(e, false));
  return { w, recs };
};

const sphereVol = (r: number) => (4 / 3) * Math.PI * r ** 3;
const cylVol = (r: number, h: number) => Math.PI * r * r * h;

describe('mass, centre of mass and inertia of a compound body', () => {
  // an asymmetric dumbbell along X: spheres of different size joined by a thin bar
  const parts = () => [
    sphere(0.25, [-1, 0, 0]),
    sphere(0.35, [1, 0, 0]),
    makePart({ shape: { type: 'cylinder', size: [0.1, 2, 0.1] }, rotation: qfromAxisAngle([0, 0, 1], Math.PI / 2) }),
  ];

  it('is the sum of the parts, centred on their mass-weighted mean', async () => {
    const body = compound(parts());
    const { w, recs } = await build([body]);
    const m1 = RHO * sphereVol(0.25),
      m2 = RHO * sphereVol(0.35),
      mb = RHO * cylVol(0.05, 2);
    const total = m1 + m2 + mb;
    expect(w.builtInfo().mass[body.id]).toBeCloseTo(total, 1);
    expect(Math.abs(w.builtInfo().mass[body.id] - total) / total).toBeLessThan(0.002);
    const com = w.builtInfo().com[body.id];
    expect(com[0]).toBeCloseTo((-m1 + m2) / total, 3);
    expect(com[1]).toBeCloseTo(0, 5);
    expect(com[2]).toBeCloseTo(0, 5);
    // the model's own estimate agrees with the engine
    expect(Math.abs(massEstimate(body) - recs[0].mass) / recs[0].mass).toBeLessThan(0.002);
    w.dispose();
  });

  it('has the principal moments the parallel-axis theorem predicts (two cubes)', async () => {
    const s = 0.5,
      d = 1;
    const body = compound([box([s, s, s], [-d, 0, 0]), box([s, s, s], [d, 0, 0])]);
    const { recs } = await build([body]);
    const m = RHO * s ** 3;
    const own = (m * s * s) / 6; // cube about any axis through its centre
    const about = {
      x: 2 * own, // the line through both cubes
      y: 2 * (own + m * d * d),
      z: 2 * (own + m * d * d),
    };
    const I = recs[0].rb.principalInertia();
    const sorted = [I.x, I.y, I.z].sort((a, b) => a - b);
    expect(sorted[0]).toBeCloseTo(about.x, 1);
    expect(Math.abs(sorted[1] - about.y) / about.y).toBeLessThan(0.002);
    expect(Math.abs(sorted[2] - about.z) / about.z).toBeLessThan(0.002);
    expect(recs[0].mass).toBeCloseTo(2 * m, 3);
  });

  it('honours per-part density and a body massOverride', async () => {
    const heavy = sphere(0.2, [-1, 0, 0], { material: { density: 4000 } });
    const light = sphere(0.2, [1, 0, 0]);
    const body = compound([heavy, light]);
    const { w, recs } = await build([body]);
    const mh = 4000 * sphereVol(0.2),
      ml = RHO * sphereVol(0.2);
    expect(recs[0].mass).toBeCloseTo(mh + ml, 2);
    expect(w.builtInfo().com[body.id][0]).toBeCloseTo((-mh + ml) / (mh + ml), 3);
    const capped = w.addBody({ ...body, id: 'capped', massOverride: 3 }, false);
    expect(capped.mass).toBeCloseTo(3, 4);
    // the shape of the distribution survives: same centre of mass
    expect(capped.rb.localCom().x).toBeCloseTo(w.builtInfo().com[body.id][0], 4);
    w.dispose();
  });

  it('a sensor part still adds mass unless its density is zero; it never collides', async () => {
    const solid = box([1, 0.4, 1], [0, 0, 0]);
    const ghostPart = box([1, 0.4, 1], [0, -1, 0], { sensor: true });
    const massless = box([1, 0.4, 1], [0, -1, 0], { sensor: true, material: { density: 0 } });
    const a = compound([solid, ghostPart], { position: [0, 5, 0] });
    const b = compound([solid, massless], { position: [0, 5, 0] });
    const { w, recs } = await build([a, { ...b, id: 'b' }]);
    expect(recs[0].mass).toBeCloseTo(2 * RHO * 0.4, 1);
    expect(recs[1].mass).toBeCloseTo(RHO * 0.4, 1);
    w.dispose();
    // dropped on the ground: the solid part rests on it, the sensor hangs through it
    const drop = compound([solid, ghostPart], { position: [0, 3, 0] });
    const wd = new PhysicsWorld(docOf([drop]));
    run(wd, 3);
    expect(wd.getPose(drop.id)!.position[1]).toBeCloseTo(0.2, 2); // solid part's half-height above the ground
    wd.dispose();
    const control = compound([solid, { ...ghostPart, sensor: false }], { position: [0, 3, 0] });
    const wc = new PhysicsWorld(docOf([control]));
    run(wc, 3);
    expect(wc.getPose(control.id)!.position[1]).toBeCloseTo(1.2, 2); // a solid lower part holds it up 1 m
  });

  it('parts whose shape is itself compound compose their colliders (nested)', async () => {
    const twin: ShapeDef = {
      id: 'test-twin',
      label: 'Twin',
      icon: 'sphere',
      category: 'special',
      defaultSize: [1, 0.4, 0.4],
      params: [],
      sizeFields: [{ axis: 0, label: 'Length' }],
      normalizeSize: ([x, y, z]) => [Math.max(x, 0.1), Math.max(y, 0.1), Math.max(z, 0.1)],
      volume: ({ size }) => 2 * sphereVol(size[1] / 2),
      boundingRadius: ({ size }) => size[0] / 2,
      halfHeight: ({ size }) => size[1] / 2,
      colliders: (R, { size }) => [
        { desc: R.ColliderDesc.ball(size[1] / 2), localPos: [-size[0] / 4, 0, 0], localRot: [0, 0, 0, 1] },
        { desc: R.ColliderDesc.ball(size[1] / 2), localPos: [size[0] / 4, 0, 0], localRot: [0, 0, 0, 1] },
      ],
      geometry: (T) => new T.SphereGeometry(0.5, 8, 6),
    };
    registerShape(twin);
    // the twin spun a quarter turn about z and lifted: its two balls end up one above the other
    const part = makePart({
      shape: { type: 'test-twin' },
      position: [0, 2, 0],
      rotation: qfromAxisAngle([0, 0, 1], Math.PI / 2),
    });
    const body = compound([part]);
    const { w, recs } = await build([body]);
    expect(recs[0].cols).toHaveLength(2);
    expect(recs[0].mass).toBeCloseTo(RHO * shapeVolume(part.shape), 2);
    const com = recs[0].rb.localCom();
    expect([com.x, com.y, com.z].map((v) => +v.toFixed(4))).toEqual([0, 2, 0]);
    // each ball sits on the rotated axis: x offsets vanish, y offsets are ±0.25
    const ys = recs[0].cols.map((c) => c.translation().y).sort((a, b) => a - b);
    const xs = recs[0].cols.map((c) => c.translation().x);
    expect(ys[0]).toBeCloseTo(1.75, 5);
    expect(ys[1]).toBeCloseTo(2.25, 5);
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-6);
    w.dispose();
  });
});

describe('dynamics of a compound body', () => {
  it('a physical pendulum built from parts has the period 2π√(I / (M·g·d))', async () => {
    // a hanging bar (y from 0 down to −1.1) with a small and a large bob; pivot at the body origin
    const bob1 = sphere(0.1, [0, -0.6, 0]);
    const bob2 = sphere(0.15, [0, -1.0, 0]);
    const bar = makePart({ shape: { type: 'cylinder', size: [0.04, 1.1, 0.04] }, position: [0, -0.55, 0] });
    const body = compound([bob1, bob2, bar], { position: [0, 5, 0], rotation: qfromAxisAngle([0, 0, 1], 0.1) });
    const pivot = createJoint({
      type: 'hinge',
      bodyA: null,
      bodyB: body.id,
      anchorA: [0, 5, 0],
      anchorB: [0, 0, 0],
      axis: [0, 0, 1],
    });
    await initRapier();
    const w = new PhysicsWorld(docOf([], { ...noGround }));
    w.addBody(body, false);
    w.addJoint(pivot);
    // analytic: Σ mᵢ, Σ mᵢ·dᵢ and the moment about the pivot axis by the parallel-axis theorem
    const m = [bob1, bob2, bar].map((p) => RHO * shapeVolume(p.shape));
    const [m1, m2, mb] = m;
    const M = m1 + m2 + mb;
    const d = (m1 * 0.6 + m2 * 1.0 + mb * 0.55) / M;
    const I =
      (2 / 5) * m1 * 0.1 ** 2 +
      m1 * 0.6 ** 2 +
      (2 / 5) * m2 * 0.15 ** 2 +
      m2 * 1.0 ** 2 +
      (mb * (3 * 0.02 ** 2 + 1.1 ** 2)) / 12 +
      mb * 0.55 ** 2;
    const expected = 2 * Math.PI * Math.sqrt(I / (M * G * d));
    expect(w.builtInfo().mass[body.id]).toBeCloseTo(M, 1);
    const dt = 1 / w.settings.physicsHz;
    const angle: number[] = [];
    for (let i = 0; i < 8 * w.settings.physicsHz; i++) {
      w.stepOnce();
      const q = w.getPose(body.id)!.rotation;
      angle.push(qtwist(q, [0, 0, 1]));
    }
    const up: number[] = [];
    for (let i = 1; i < angle.length; i++) {
      if (angle[i - 1] < 0 && angle[i] >= 0) up.push((i - 1 + -angle[i - 1] / (angle[i] - angle[i - 1])) * dt);
    }
    expect(up.length).toBeGreaterThanOrEqual(3);
    const period = (up[up.length - 1] - up[0]) / (up.length - 1);
    expect(Math.abs(period - expected) / expected).toBeLessThan(0.015);
    w.dispose();
  });

  it('spins about its centre of mass while falling: COM in free fall, angle ω·t, origin on a circle', async () => {
    // origin is not the centre of mass: the heavy part sits at x = +0.5
    const body = compound([sphere(0.2, [0.5, 0, 0], { material: { density: 8000 } }), sphere(0.2, [-0.5, 0, 0])], {
      position: [0, 100, 0],
      angularVelocity: [0, 0, 3],
    });
    const { w, recs } = await build([body], noGround);
    const rb = recs[0].rb;
    const com0 = rb.worldCom();
    const local = rb.localCom();
    const r = Math.hypot(local.x, local.y, local.z);
    expect(r).toBeGreaterThan(0.3);
    const T = 1.2;
    let maxRadiusErr = 0;
    for (let i = 0; i < T * w.settings.physicsHz; i++) {
      w.stepOnce();
      const p = rb.translation();
      const c = rb.worldCom();
      maxRadiusErr = Math.max(maxRadiusErr, Math.abs(Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) - r));
    }
    const c = rb.worldCom();
    expect(c.y).toBeCloseTo(100 - 0.5 * G * T * T, 1); // the COM falls as if nothing spun
    expect(Math.abs(c.x - com0.x) + Math.abs(c.z - com0.z)).toBeLessThan(1e-3); // and does not drift sideways
    expect(maxRadiusErr).toBeLessThan(1e-4); // the origin circles the COM at a constant radius
    const angle = qtwist(w.getPose(body.id)!.rotation, [0, 0, 1]);
    const wrapped = ((3 * T + Math.PI) % (2 * Math.PI)) - Math.PI;
    expect(Math.abs(angle - wrapped)).toBeLessThan(0.02);
    w.dispose();
  });

  it('settles with its mass distribution dictating the pose: a roly-poly rolls over until the heavy part is lowest', () => {
    // a big light sphere with a small dense ball inside it, near the top: unstable, so it rolls over
    const shell = sphere(0.4, [0, 0, 0], { material: { density: 100 } });
    const ballast = sphere(0.1, [0, 0.28, 0], { material: { density: 20000 } });
    const body = compound([shell, ballast], {
      position: [0, 0.4, 0],
      rotation: qfromAxisAngle([0, 0, 1], 0.05),
      angularDamping: 1.5,
      material: { preset: 'custom', density: 100, friction: 0.8, restitution: 0 },
    });
    const w = new PhysicsWorld(
      docOf([body], { ground: { enabled: true, friction: 0.8, restitution: 0, halfSize: 50, color: '#000' } }),
    );
    expect(w.builtInfo().com[body.id][1]).toBeGreaterThan(0.1); // the centre of mass starts above the sphere's centre
    run(w, 25);
    const p = w.getPose(body.id)!;
    const toBallast = qrot(p.rotation, [0, 1, 0]);
    expect(toBallast[1]).toBeLessThan(-0.97); // the ballast ended up straight below the centre
    expect(vlen(p.angvel)).toBeLessThan(0.05);
    w.dispose();
  });
});

describe('energy accounting of a compound body', () => {
  it("uses the compound's own mass, centre of mass and inertia", async () => {
    // origin is not the centre of mass; spin about z (a principal axis of the planar dumbbell) while drifting
    const heavy = sphere(0.2, [0.5, 0, 0], { material: { density: 8000 } });
    const light = sphere(0.2, [-0.5, 0, 0]);
    const body = compound([heavy, light], {
      position: [0, 50, 0],
      velocity: [2, 0, 0],
      angularVelocity: [0, 0, 3],
      gravityScale: 0,
    });
    const { w, recs } = await build([body], { ...noGround });
    const rec = recs[0];
    const m = rec.mass;
    const I = rec.rb.principalInertia();
    const Izz = Math.max(I.x, I.y, I.z);
    const com = rec.rb.worldCom();
    w.readPoses(1);
    const e = w.stats().energy;
    expect(e.kinetic).toBeCloseTo(0.5 * m * 4, 2); // ½ m v² with the COM velocity
    expect(e.rotational).toBeCloseTo(0.5 * Izz * 9, 1); // ½ I ω² about the COM
    // gravitational potential is measured at the centre of mass, not at the body origin
    expect(e.potential).toBeCloseTo(0, 6); // gravityScale 0 -> no potential energy booked
    const falling = {
      ...body,
      id: 'g',
      position: [30, 50, 0] as Vec3,
      gravityScale: 1,
      velocity: [0, 0, 0] as Vec3,
      angularVelocity: [0, 0, 0] as Vec3,
    };
    const rg = w.addBody(falling, false);
    w.readPoses(1);
    const comG = rg.rb.worldCom();
    expect(w.stats().energy.potential).toBeCloseTo(rg.mass * G * comG.y + 0, 0); // the first body adds none (gravityScale 0)
    expect(comG.y).toBeCloseTo(50, 5);
    expect(com.x).toBeGreaterThan(0.3); // sanity: the COM really is off the origin
    // the spin energy stays put while it drifts
    for (let i = 0; i < 240; i++) w.stepOnce();
    w.readPoses(1);
    const after = w.stats().energy;
    expect(Math.abs(after.rotational - e.rotational) / e.rotational).toBeLessThan(0.005); // spin energy is conserved
    w.dispose();
  });

  it('volume and mass estimates are Σ over the parts', () => {
    const b = compound([sphere(0.25, [-1, 0, 0]), box([1, 1, 1], [1, 0, 0], { material: { density: 10 } })]);
    expect(compoundVolume(b)).toBeCloseTo(sphereVol(0.25) + 1, 12);
    expect(naturalMass(b)).toBeCloseTo(RHO * sphereVol(0.25) + 10, 9);
    expect(compoundVolume({ ...b, parts: undefined })).toBeCloseTo(1, 12); // the primary 1×1×1 box
  });
});

describe('part materials', () => {
  /** A block resting on a slab under tilted gravity: slides iff the pair friction is below tan(tilt). */
  const slide = (partFriction: number | undefined) => {
    const tilt = (20 * Math.PI) / 180;
    const slab = createBody({
      shape: { type: 'box', size: [40, 0.4, 40] },
      position: [0, -0.2, 0],
      bodyType: 'static',
      material: { preset: 'custom', friction: 0.5 },
    });
    const part = box(
      [0.4, 0.4, 0.4],
      [0, 0, 0],
      partFriction === undefined ? {} : { material: { friction: partFriction } },
    );
    const block = compound([part], {
      position: [0, 0.2, 0],
      material: { preset: 'custom', density: RHO, friction: 0.5 },
    });
    const w = new PhysicsWorld(
      docOf([slab, block], { ...noGround, gravity: [G * Math.sin(tilt), -G * Math.cos(tilt), 0] }),
    );
    run(w, 2);
    const x = w.getPose(block.id)!.position[0];
    w.dispose();
    return x;
  };

  it("a part's friction override beats the body material: ice slides, rubber holds, the body value is the fallback", () => {
    const ice = slide(0.05); // pair μ = (0.05 + 0.5) / 2 = 0.275 < tan 20° = 0.364
    const grippy = slide(0.9); // (0.9 + 0.5) / 2 = 0.7 > 0.364
    const inherited = slide(undefined); // body friction 0.5 -> pair 0.5 > 0.364
    const a = G * (Math.sin((20 * Math.PI) / 180) - 0.275 * Math.cos((20 * Math.PI) / 180));
    expect(Math.abs(ice - 0.5 * a * 4) / (0.5 * a * 4)).toBeLessThan(0.15);
    expect(Math.abs(grippy)).toBeLessThan(0.02);
    expect(Math.abs(inherited)).toBeLessThan(0.02);
  });

  it("a body with parts of different friction reports each collider's own value, and edits update them live", async () => {
    const body = compound(
      [
        box([0.4, 0.4, 0.4], [-1, 0, 0], { material: { friction: 0.1, restitution: 0.9 } }),
        box([0.4, 0.4, 0.4], [1, 0, 0]),
      ],
      {
        material: { preset: 'custom', density: RHO, friction: 0.6, restitution: 0.2 },
      },
    );
    const { w, recs } = await build([body]);
    const r = recs[0];
    expect(r.cols.map((c) => +c.friction().toFixed(3))).toEqual([0.1, 0.6]);
    expect(r.cols.map((c) => +c.restitution().toFixed(3))).toEqual([0.9, 0.2]);
    // editing the body material re-applies the overrides on top of it, without a rebuild
    const before = recs[0].cols[0].handle;
    w.updateBody({ ...body, material: { ...body.material, friction: 0.3 } });
    expect(r.cols.map((c) => +c.friction().toFixed(3))).toEqual([0.1, 0.3]);
    expect(r.cols[0].handle).toBe(before);
    // changing a part rebuilds the body with new colliders
    w.updateBody({ ...body, parts: [body.parts![0]] });
    expect(w.builtInfo().mass[body.id]).toBeCloseTo(RHO * 0.4 ** 3, 2);
    w.dispose();
  });

  it('partMaterial merges overrides over the body material', () => {
    const b = createBody({ shape: { type: 'box' }, material: { preset: 'steel' } });
    const p = box([1, 1, 1], [0, 0, 0], { material: { color: '#ff0000', friction: 0.01 } });
    const m = partMaterial(b, p);
    expect(m.color).toBe('#ff0000');
    expect(m.friction).toBe(0.01);
    expect(m.density).toBe(b.material.density);
    expect(partMaterial(b, box([1, 1, 1], [0, 0, 0]))).toBe(b.material);
  });
});

describe('colliders land where the parts say', () => {
  it('a static T of two parts stops a falling ball at the right heights; the world is empty beyond it', () => {
    const stem = box([0.4, 2, 0.4], [0, 1, 0]);
    const bar = box([3, 0.3, 0.4], [0, 2.15, 0]);
    const tee = createBody({
      shape: { type: 'box', size: [3, 2.3, 0.4] },
      position: [0, 0, 0],
      bodyType: 'static',
      parts: [stem, bar],
    });
    const mk = (x: number) =>
      createBody({
        shape: { type: 'sphere', size: [0.4, 0.4, 0.4] },
        position: [x, 6, 0],
        ...free,
        material: mat,
        id: `b${x}`,
      });
    const balls = [mk(1.2), mk(0), mk(2.5)];
    const w = new PhysicsWorld(docOf([tee, ...balls]));
    run(w, 4);
    const y = (x: number) => w.getPose(`b${x}`)!.position[1];
    expect(y(1.2)).toBeCloseTo(2.3 + 0.2, 2); // on the end of the crossbar
    expect(y(0)).toBeCloseTo(2.3 + 0.2, 2); // on the middle of the crossbar
    expect(y(2.5)).toBeCloseTo(0.2, 2); // beyond the bar: on the ground
    w.dispose();
  });

  it("every part carries the body's collision group and the contact overlay sees all of them", async () => {
    const body = compound([box([0.5, 0.5, 0.5], [-0.6, 0, 0]), box([0.5, 0.5, 0.5], [0.6, 0, 0])], {
      position: [0, 0.26, 0],
      collision: { group: 4, mask: 0x00ff },
    });
    const { w, recs } = await build([body]);
    const groups = recs[0].cols.map((c) => c.collisionGroups());
    expect(new Set(groups).size).toBe(1);
    expect(groups[0] >>> 16).toBe(1 << 4);
    expect(groups[0] & 0xffff).toBe(0x00ff);
    run(w, 0.5);
    const pts = w.readContacts();
    // both feet touch the ground: contact points on both sides of the middle
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i += 7) xs.push(pts[i]);
    expect(xs.some((x) => x < -0.3) && xs.some((x) => x > 0.3)).toBe(true);
    w.dispose();
  });
});

describe('compound helpers and the sanitiser', () => {
  it('makePart / isCompound / naturalMass', () => {
    const p = makePart({ shape: { type: 'sphere', size: [1, 2, 3] } });
    expect(p.shape.size).toEqual([1, 1, 1]); // normalised through the registry (a sphere is uniform)
    expect(p.id).toMatch(/^p_/);
    expect(p.position).toEqual([0, 0, 0]);
    expect(p.sensor).toBeUndefined();
    expect(makePart({ shape: { type: 'box' }, visible: false, sensor: true })).toMatchObject({
      visible: false,
      sensor: true,
    });
    const b = createBody({ shape: { type: 'box', size: [1, 1, 1] }, material: mat });
    expect(isCompound(b)).toBe(false);
    expect(naturalMass(b)).toBe(RHO);
    expect(isCompound({ ...b, parts: [] })).toBe(false);
    expect(
      naturalMass({
        ...b,
        parts: [box([1, 1, 1], [0, 0, 0]), box([2, 1, 1], [0, 0, 0], { material: { density: 10 } })],
      }),
    ).toBe(RHO + 20);
    expect(massEstimate({ ...b, massOverride: 7 })).toBe(7);
  });

  it('scaleParts scales positions exactly and axis-aligned part sizes exactly', () => {
    const parts = [
      box([1, 1, 1], [1, 2, 3]),
      box([1, 2, 3], [0, 0, 0], { rotation: qfromAxisAngle([0, 0, 1], Math.PI / 2) }), // x and y swapped
      sphere(0.5, [0, 1, 0]),
    ];
    const out = scaleParts(parts, [2, 1, 3]);
    expect(out[0].position).toEqual([2, 2, 9]);
    expect(out[0].shape.size).toEqual([2, 1, 3]);
    // the rotated box's local x axis points along world y (factor 1) and its local y along -x (factor 2)
    expect(out[1].shape.size[0]).toBeCloseTo(1, 9);
    expect(out[1].shape.size[1]).toBeCloseTo(4, 9);
    expect(out[1].shape.size[2]).toBeCloseTo(9, 9);
    // a sphere stays a sphere
    expect(new Set(out[2].shape.size).size).toBe(1);
    expect(scaleParts(parts, [1, 1, 1]).map((p) => p.shape.size)).toEqual(parts.map((p) => p.shape.size));
    expect(parts[0].position).toEqual([1, 2, 3]); // the input is untouched
  });

  it('sanitises parts: shapes through the registry, ranges, unique ids, limits', () => {
    const report = newReport();
    const doc = sanitizeDocument(
      {
        format: 'physixlab-scene',
        entities: [
          {
            kind: 'body',
            id: 'a',
            name: 'Thing',
            parts: [
              {
                id: 'x',
                shape: { type: 'sphere', size: [1, 2, 3] },
                position: [1, 2, 3],
                material: { friction: -3, density: 1e12, color: 'nope', opacity: 0 },
              },
              { id: 'x', shape: { type: 'tesseract' }, rotation: [0, 0, 0, 0], sensor: 'yes', visible: false },
              'junk',
              null,
              { shape: 'box', material: {} },
            ],
          },
          { kind: 'body', id: 'b', parts: [] },
          { kind: 'body', id: 'c', parts: 'many' },
          { kind: 'body', id: 'd', parts: Array.from({ length: 200 }, () => ({ shape: { type: 'box' } })) },
        ],
      },
      report,
    );
    const [a, b, c, d] = doc.entities as BodyEntity[];
    expect(a.parts).toHaveLength(5);
    expect(a.parts![0].shape.size).toEqual([1, 1, 1]); // a sphere is uniform
    expect(a.parts![0].material).toEqual({ density: 1e6, friction: 0, opacity: 0.05 });
    expect(a.parts![1].shape.type).toBe('box');
    expect(a.parts![1].rotation).toEqual([0, 0, 0, 1]);
    expect(a.parts![1].sensor).toBeUndefined();
    expect(a.parts![1].visible).toBe(false);
    expect(new Set(a.parts!.map((p) => p.id)).size).toBe(5); // 'x' twice became x and x~2
    expect(b.parts).toBeUndefined();
    expect(c.parts).toBeUndefined();
    expect(d.parts).toHaveLength(LIMITS.maxPartsPerBody);
    expect(report.warnings.some((w) => /Unknown shape "tesseract" on a collider part of "Thing"/.test(w))).toBe(true);
    expect(report.warnings.some((w) => /200 collider parts/.test(w))).toBe(true);
  });

  it('round-trips through the serialiser and v1 scenes stay simple bodies', () => {
    const doc = newDocument('c');
    const body = compound([
      sphere(0.2, [1, 0, 0], { material: { color: '#ff0000' }, sensor: true }),
      box([1, 1, 1], [0, 1, 0], { visible: false }),
    ]);
    doc.entities.push(body);
    expect(parseDocument(serializeDocument(doc)).entities[0]).toEqual(body);
    expect(makeShapeSpec('box').size).toEqual([1, 1, 1]);
  });
});

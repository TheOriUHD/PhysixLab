/**
 * The live-edit protocol ops, stepping accumulator, readback buffers and thrusters of `PhysicsWorld`
 * (src/physics/world/*), checked against analytic expectations. These paths used to be exercised only
 * through the browser; they are the contract the worker relies on, so they get engine-level tests too.
 */
import { describe, expect, it } from 'vitest';
import { createBody, createJoint, run, worldOf } from './helpers';
import { B, BODY_STRIDE, CONTACT_STRIDE, J } from '../src/physics/protocol';
import { PhysicsWorld, initRapier } from '../src/physics/world';
import { vlen } from '../src/core/math';

const free = { linearDamping: 0, angularDamping: 0, canSleep: false };
const zeroG = { gravity: [0, 0, 0] as [number, number, number] };
const noGround = { ground: { enabled: false, friction: 0.5, restitution: 0, halfSize: 50, color: '#000' } };

const ball = (over: Parameters<typeof createBody>[0] = {}) =>
  createBody({ shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [0, 5, 0], ...free, ...over });

describe('PhysicsWorld façade', () => {
  it('exposes the full public API the worker, the tests and the app depend on', async () => {
    await initRapier();
    const w = await worldOf([ball()]);
    const methods = [
      'dispose',
      'addBody',
      'addJoint',
      'addSoft',
      'removeEntities',
      'updateBody',
      'updateJoint',
      'applySettings',
      'teleport',
      'setVelocity',
      'applyOp',
      'setKeys',
      'stepOnce',
      'advance',
      'stepManual',
      'readPoses',
      'readJoints',
      'readSoft',
      'readContacts',
      'drainEvents',
      'builtInfo',
      'stats',
      'getPose',
      'getJointRec',
    ] as const;
    for (const m of methods) expect(typeof w[m], m).toBe('function');
    for (const p of [
      'world',
      'settings',
      'simTime',
      'stepCount',
      'layoutVersion',
      'fixedDt',
      'alpha',
      'bodyIds',
      'jointIds',
    ])
      expect(p in w, p).toBe(true);
    expect(w).toBeInstanceOf(PhysicsWorld);
    expect(w.fixedDt).toBeCloseTo(1 / 120, 12);
    w.settings = { ...w.settings, physicsHz: 60 };
    expect(w.fixedDt).toBeCloseTo(1 / 60, 12); // settings is a live, settable property backed by the shared state
  });
});

describe('one-shot ops', () => {
  it('impulse at the centre of mass changes velocity by J/m and adds no spin', async () => {
    const b = ball({ position: [0, 5, 0] });
    const w = await worldOf([b], zeroG);
    const m = w.builtInfo().mass[b.id];
    w.applyOp({ op: 'impulse', id: b.id, impulse: [12, 0, -6], point: [0, 5, 0] });
    w.stepOnce();
    const p = w.getPose(b.id)!;
    expect(p.linvel[0]).toBeCloseTo(12 / m, 3);
    expect(p.linvel[2]).toBeCloseTo(-6 / m, 3);
    expect(vlen(p.angvel)).toBeLessThan(1e-4);
  });

  it('impulse off-centre also spins the body (angular impulse = r × J)', async () => {
    const b = ball({ position: [0, 5, 0] });
    const w = await worldOf([b], zeroG);
    w.applyOp({ op: 'impulse', id: b.id, impulse: [0, 0, 10], point: [0.5, 5, 0] });
    w.stepOnce();
    // r = (0.5,0,0), J = (0,0,10)  →  r × J = (0, −5, 0): spin about −y
    expect(w.getPose(b.id)!.angvel[1]).toBeLessThan(-0.1);
  });

  it('setVelocity moves a free body at exactly that speed', async () => {
    const b = ball();
    const w = await worldOf([b], zeroG);
    w.applyOp({ op: 'setVelocity', id: b.id, linvel: [3, 0, 0], angvel: [0, 0, 0] });
    run(w, 1);
    expect(w.getPose(b.id)!.position[0]).toBeCloseTo(3, 1);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(3, 6);
  });

  it('teleport sets the pose and zeroes velocity unless keepVelocity is set', async () => {
    const b = ball({ velocity: [4, 0, 0] });
    const w = await worldOf([b], zeroG);
    w.applyOp({ op: 'teleport', id: b.id, position: [10, 2, 3], rotation: [0, 0, 0, 1] });
    const p = w.getPose(b.id)!;
    expect(p.position).toEqual([10, 2, 3]);
    expect(vlen(p.linvel)).toBe(0);
    w.applyOp({ op: 'setVelocity', id: b.id, linvel: [4, 0, 0], angvel: [0, 0, 0] });
    w.applyOp({ op: 'teleport', id: b.id, position: [0, 0, 0], rotation: [0, 0, 0, 1], keepVelocity: true });
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(4, 6);
  });

  it('explode pushes bodies inside the radius away from the centre and leaves distant ones alone', async () => {
    const near = ball({ position: [2, 0, 0] });
    const far = ball({ position: [20, 0, 0] });
    const w = await worldOf([near, far], { ...zeroG, ...noGround });
    w.applyOp({ op: 'explode', center: [0, 0, 0], strength: 30, radius: 7 });
    w.stepOnce();
    expect(w.getPose(near.id)!.linvel[0]).toBeGreaterThan(0.5);
    expect(vlen(w.getPose(far.id)!.linvel)).toBe(0);
  });

  it('wakeAll wakes sleeping bodies', async () => {
    const b = ball({ canSleep: true });
    const w = await worldOf([b], zeroG);
    run(w, 3);
    expect(w.readPoses(1)[B.state]).toBe(1); // asleep in zero gravity
    w.applyOp({ op: 'wakeAll' });
    expect(w.readPoses(1)[B.state]).toBe(0);
  });
});

describe('grab spring', () => {
  it('drags a body to the target, hovering against gravity, and a release lets it fall', async () => {
    const b = ball({ position: [0, 2, 0], canSleep: false, linearDamping: 0.01 });
    const w = await worldOf([b]);
    w.applyOp({ op: 'grab', id: b.id, point: [0, 2, 0], target: [3, 4, 0] });
    run(w, 2.5);
    const p = w.getPose(b.id)!;
    expect(p.position[0]).toBeCloseTo(3, 1);
    expect(p.position[1]).toBeCloseTo(4, 1);
    expect(vlen(p.linvel)).toBeLessThan(0.1);
    // retarget while holding
    w.applyOp({ op: 'grabMove', target: [-2, 3, 1] });
    run(w, 2.5);
    expect(w.getPose(b.id)!.position[0]).toBeCloseTo(-2, 1);
    w.applyOp({ op: 'release' });
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[1]).toBeLessThan(-3);
  });

  it('ignores static bodies and removing the grabbed body drops the grab', async () => {
    const wall = createBody({ shape: { type: 'box' }, bodyType: 'static', position: [0, 1, 0] });
    const b = ball({ position: [0, 5, 0] });
    const w = await worldOf([wall, b], zeroG);
    w.applyOp({ op: 'grab', id: wall.id, point: [0, 1, 0], target: [5, 5, 5] });
    run(w, 0.5);
    expect(w.getPose(wall.id)!.position).toEqual([0, 1, 0]);
    w.applyOp({ op: 'grab', id: b.id, point: [0, 5, 0], target: [4, 5, 0] });
    w.applyOp({ op: 'remove', ids: [b.id] });
    expect(() => run(w, 0.2)).not.toThrow();
    expect(w.getPose(b.id)).toBeNull();
  });
});

describe('thrusters', () => {
  it('"always" thrust accelerates at F/m, in the body frame', async () => {
    const b = ball({ thrust: { mode: 'always', key: '', force: [2000, 0, 0], torque: [0, 0, 0] } });
    const w = await worldOf([b], zeroG);
    const m = w.builtInfo().mass[b.id];
    run(w, 1);
    expect(w.getPose(b.id)!.linvel[0]).toBeCloseTo(2000 / m, 1);
  });

  it('"key" thrust only fires while its key is held and stops when it is released', async () => {
    const b = ball({ thrust: { mode: 'key', key: 'KeyT', force: [0, 0, 3000], torque: [0, 0, 0] } });
    const w = await worldOf([b], zeroG);
    run(w, 0.5);
    expect(vlen(w.getPose(b.id)!.linvel)).toBe(0);
    w.setKeys(['KeyT']);
    run(w, 0.5);
    const v = w.getPose(b.id)!.linvel[2];
    expect(v).toBeGreaterThan(0.5);
    w.setKeys([]);
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[2]).toBeCloseTo(v, 4); // coasting at constant speed
  });
});

describe('live structural edits', () => {
  it('rebuilding a body (density change) keeps its pose, velocity and its joints', async () => {
    const post = createBody({ shape: { type: 'box' }, bodyType: 'static', position: [0, 3, 0] });
    const arm = createBody({ shape: { type: 'box', size: [1, 0.2, 0.2] }, position: [1, 3, 0], ...free });
    const hinge = createJoint({ type: 'hinge', bodyA: post.id, bodyB: arm.id, anchorA: [0.5, 0, 0], axis: [0, 0, 1] });
    const w = await worldOf([post, arm, hinge]);
    run(w, 0.4);
    const before = w.getPose(arm.id)!;
    const mass0 = w.builtInfo().mass[arm.id];
    const v0 = w.layoutVersion;
    w.applyOp({ op: 'updateBody', body: { ...arm, material: { ...arm.material, density: arm.material.density * 2 } } });
    const after = w.getPose(arm.id)!;
    expect(after.position[0]).toBeCloseTo(before.position[0], 6);
    expect(after.position[1]).toBeCloseTo(before.position[1], 6);
    expect(after.linvel[1]).toBeCloseTo(before.linvel[1], 5);
    expect(w.builtInfo().mass[arm.id]).toBeCloseTo(2 * mass0, 3);
    expect(w.jointIds).toEqual([hinge.id]);
    expect(w.layoutVersion).toBeGreaterThan(v0);
    run(w, 0.5);
    expect(Number.isFinite(w.getJointRec(hinge.id)!.value)).toBe(true);
  });

  it('removing a body drops the joints attached to it', async () => {
    const a = createBody({ shape: { type: 'box' }, position: [0, 3, 0], ...free });
    const b = createBody({ shape: { type: 'box' }, position: [2, 3, 0], ...free });
    const j = createJoint({ type: 'ball', bodyA: a.id, bodyB: b.id, anchorA: [1, 0, 0] });
    const w = await worldOf([a, b, j]);
    expect(w.jointIds).toEqual([j.id]);
    w.applyOp({ op: 'remove', ids: [a.id] });
    expect(w.jointIds).toEqual([]);
    expect(w.bodyIds).toEqual([b.id]);
  });

  it('addJoint / updateJoint ops: a limit added to a swinging hinge is respected', async () => {
    const post = createBody({ shape: { type: 'box' }, bodyType: 'static', position: [0, 3, 0] });
    const arm = createBody({ shape: { type: 'box', size: [1, 0.2, 0.2] }, position: [1, 3, 0], ...free });
    const w = await worldOf([post, arm], noGround);
    const hinge = createJoint({ type: 'hinge', bodyA: post.id, bodyB: arm.id, anchorA: [0.5, 0, 0], axis: [0, 0, 1] });
    w.applyOp({ op: 'addJoint', joint: hinge });
    expect(w.jointIds).toEqual([hinge.id]);
    run(w, 0.6);
    expect(Math.abs(w.getJointRec(hinge.id)!.value)).toBeGreaterThan(0.3); // swings freely under gravity
    w.applyOp({ op: 'teleport', id: arm.id, position: [1, 3, 0], rotation: [0, 0, 0, 1] });
    w.applyOp({ op: 'updateJoint', joint: { ...hinge, limit: { enabled: true, min: -0.2, max: 0.2 } } });
    run(w, 2);
    const angle = w.getJointRec(hinge.id)!.value;
    expect(Math.abs(angle)).toBeLessThan(0.3);
    expect(Math.abs(angle)).toBeGreaterThan(0.1); // pressed against the limit by gravity
  });
});

describe('stepping accumulator', () => {
  it('advance converts wall-clock time into whole fixed steps and keeps the remainder', async () => {
    const w = await worldOf([ball()]);
    const dt = 1 / 120;
    expect(w.advance(0.02, 1, 1e9)).toBe(2); // 2.4 steps
    expect(w.alpha).toBeCloseTo(0.4, 6);
    expect(w.advance(0.02, 0.5, 1e9)).toBe(1); // 0.4 + 1.2 = 1.6 steps → 1 step, remainder 0.6
    expect(w.alpha).toBeCloseTo(0.6, 6);
    expect(w.simTime).toBeCloseTo(3 * dt, 12);
    expect(w.stepCount).toBe(3);
    expect(w.advance(0, 1, 1e9)).toBe(0);
    expect(w.stats().realtimeFactor).toBe(1);
  });

  it('advance clamps a long frame to 0.25 s of simulated time', async () => {
    const w = await worldOf([ball()]);
    expect(w.advance(10, 1, 1e9)).toBe(30);
  });

  it('stepManual takes exactly n steps and clears the interpolation remainder', async () => {
    const w = await worldOf([ball()]);
    w.advance(0.02, 1, 1e9);
    w.stepManual(5);
    expect(w.stepCount).toBe(7);
    expect(w.alpha).toBe(0);
    expect(w.simTime).toBeCloseTo(7 / 120, 12);
  });

  it('readPoses interpolates between the previous and the current step', async () => {
    const b = ball({ position: [0, 50, 0] });
    const w = await worldOf([b]);
    const y0 = w.getPose(b.id)!.position[1];
    w.advance(1.5 / 120, 1, 1e9); // one step, leaving alpha = 0.5
    const y1 = w.getPose(b.id)!.position[1];
    expect(y1).toBeLessThan(y0);
    expect(w.alpha).toBeCloseTo(0.5, 6);
    const buf = w.readPoses(w.alpha);
    expect(buf[B.py]).toBeCloseTo((y0 + y1) / 2, 4);
    expect(w.readPoses(1)[B.py]).toBeCloseTo(y1, 4);
  });
});

describe('readback', () => {
  it('readPoses fills one record per body, reusing the supplied buffer', async () => {
    const a = ball({ position: [0, 5, 0] });
    const b = ball({ position: [1, 6, 0], velocity: [0, 0, 2] });
    const w = await worldOf([a, b], zeroG);
    const out = new Float32Array(2 * BODY_STRIDE);
    const r = w.readPoses(1, out);
    expect(r).toBe(out);
    expect(r[B.py]).toBeCloseTo(5, 6);
    expect(r[BODY_STRIDE + B.vz]).toBeCloseTo(2, 6); // second body's vz
    expect(r[BODY_STRIDE + B.ke]).toBeGreaterThan(0);
    expect(r[B.ke]).toBe(0);
  });

  it('bodies that fall out of the world are disabled and reported as state 2', async () => {
    const b = ball({ position: [0, -395, 0] });
    const w = await worldOf([b], noGround);
    run(w, 3);
    expect(w.readPoses(1)[B.state]).toBe(2);
    const y = w.getPose(b.id)!.position[1];
    run(w, 0.5);
    expect(w.getPose(b.id)!.position[1]).toBe(y); // frozen once disabled
  });

  it('readContacts reports upward normals and a total force that supports the resting weight', async () => {
    const box = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [0, 0.5, 0], canSleep: false });
    const w = await worldOf([box]);
    run(w, 1.5);
    const c = w.readContacts();
    expect(c.length).toBeGreaterThan(0);
    expect(c.length % CONTACT_STRIDE).toBe(0);
    let force = 0;
    for (let i = 0; i < c.length; i += CONTACT_STRIDE) {
      expect(Math.abs(c[i + 4])).toBeGreaterThan(0.9); // normal is vertical (sign depends on pair order)
      force += c[i + 6]; // each solver point carries pair force / points, so the sum is the pair force
    }
    expect(w.stats().contacts).toBeGreaterThan(0);
    const weight = w.builtInfo().mass[box.id] * 9.81;
    expect(force).toBeGreaterThan(0.7 * weight);
    expect(force).toBeLessThan(1.3 * weight);
    expect(w.readContacts(2).length).toBeLessThanOrEqual(2 * CONTACT_STRIDE); // honours the cap
  });

  it('readJoints reports value, speed, force and broken state per joint', async () => {
    const post = createBody({ shape: { type: 'box' }, bodyType: 'static', position: [0, 6, 0] });
    const weight = createBody({ shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [0, 3, 0], ...free });
    const spring = createJoint({
      type: 'spring',
      bodyA: post.id,
      bodyB: weight.id,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      spring: { restLength: 2, stiffness: 300, damping: 5, breakForce: 0 },
    });
    const w = await worldOf([post, weight, spring]);
    run(w, 0.05);
    const j = w.readJoints();
    expect(j.length).toBe(4);
    expect(j[J.value]).toBeGreaterThan(2.5); // stretched from rest length 2 (anchor distance 3)
    expect(j[J.force]).toBeGreaterThan(100); // k·x ≈ 300 N of tension
    expect(j[J.broken]).toBe(0);
  });

  it('a spring past its break force snaps once, raises one event and the queue then empties', async () => {
    const post = createBody({ shape: { type: 'box' }, bodyType: 'static', position: [0, 6, 0] });
    const weight = createBody({ shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [0, 3, 0], ...free });
    const spring = createJoint({
      type: 'spring',
      bodyA: post.id,
      bodyB: weight.id,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      spring: { restLength: 1, stiffness: 400, damping: 5, breakForce: 50 },
    });
    const w = await worldOf([post, weight, spring]);
    run(w, 0.1);
    const ev = w.drainEvents();
    expect(ev).toEqual([{ kind: 'jointBroken', id: spring.id, force: expect.any(Number) as number }]);
    expect(w.drainEvents()).toEqual([]);
    expect(w.getJointRec(spring.id)!.broken).toBe(true);
    expect(w.readJoints()[J.broken]).toBe(1);
  });
});

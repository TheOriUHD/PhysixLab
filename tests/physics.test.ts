import { describe, expect, it } from 'vitest';
import { createBody, createJoint, run, worldOf } from './helpers';
import { qfromAxisAngle, qrot, vlen } from '../src/core/math';
import { materialFromPreset } from '../src/model/materials';

const noDamp = { linearDamping: 0, angularDamping: 0, canSleep: false };

describe('free motion', () => {
  it('falls under gravity with the analytic displacement', async () => {
    const ball = createBody({ shape: { type: 'sphere', size: [0.4, 0.4, 0.4] }, position: [0, 20, 0], ...noDamp });
    const w = await worldOf([ball]);
    run(w, 1.0);
    const y = w.getPose(ball.id)!.position[1];
    // y = y0 - g t²/2 (symplectic Euler: tiny O(dt) bias)
    expect(y).toBeGreaterThan(20 - 0.5 * 9.81 - 0.1);
    expect(y).toBeLessThan(20 - 0.5 * 9.81 + 0.1);
  });

  it('conserves linear momentum in zero gravity', async () => {
    const a = createBody({
      shape: { type: 'sphere', size: [1, 1, 1] },
      position: [-3, 5, 0],
      velocity: [4, 0, 0],
      ...noDamp,
      material: { preset: 'steel', restitution: 1 },
    });
    const b = createBody({
      shape: { type: 'sphere', size: [1, 1, 1] },
      position: [3, 5, 0],
      velocity: [-1, 0, 0],
      ...noDamp,
      material: { preset: 'steel', restitution: 1 },
    });
    const w = await worldOf([a, b], { gravity: [0, 0, 0] });
    const p0 = 4 * w.getPose(a.id)!.linvel[0] * 0 + 0; // placeholder to keep types simple
    void p0;
    const ma = w.builtInfo().mass[a.id],
      mb = w.builtInfo().mass[b.id];
    const before = ma * 4 + mb * -1;
    run(w, 3);
    const va = w.getPose(a.id)!.linvel[0],
      vb = w.getPose(b.id)!.linvel[0];
    expect(ma * va + mb * vb).toBeCloseTo(before, 0);
    // elastic equal-mass collision exchanges velocities
    expect(va).toBeLessThan(0);
    expect(vb).toBeGreaterThan(0);
  });
});

describe('contacts', () => {
  it('bounces with the material restitution', async () => {
    const ball = createBody({
      shape: { type: 'sphere', size: [0.4, 0.4, 0.4] },
      position: [0, 3.2, 0],
      ...noDamp,
      material: materialFromPreset('rubber', { restitution: 0.6 }),
    });
    const w = await worldOf([ball], {
      ground: { enabled: true, friction: 0.8, restitution: 0, halfSize: 50, color: '#000' },
    });
    let maxAfter = 0,
      hit = false,
      lastVy = 0;
    for (let i = 0; i < 600; i++) {
      w.stepOnce();
      const p = w.getPose(ball.id)!;
      if (!hit && lastVy < -1 && p.linvel[1] > 0) hit = true;
      if (hit) maxAfter = Math.max(maxAfter, p.position[1]);
      lastVy = p.linvel[1];
    }
    // drop height of the centre: 3.0 above resting height 0.2 -> rebound ≈ e²·h
    const ratio = (maxAfter - 0.2) / 3.0;
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(0.45); // e² = 0.36
  });

  it('holds a box on a slope below the friction angle and slides above it', async () => {
    const mu = 0.5;
    const results: boolean[] = [];
    for (const deg of [15, 40]) {
      const ang = (deg * Math.PI) / 180;
      const q = qfromAxisAngle([0, 0, 1], ang);
      const ramp = createBody({
        shape: { type: 'box', size: [20, 0.4, 4] },
        bodyType: 'static',
        rotation: q,
        material: { preset: 'custom', friction: mu, restitution: 0 },
      });
      const up = qrot(q, [0, 0.7, 0]); // half ramp thickness + half box height
      const box = createBody({
        shape: { type: 'box', size: [1, 1, 1] },
        position: [up[0] - 0.0, up[1] + 0.0, 0],
        rotation: q,
        material: { preset: 'custom', density: 500, friction: mu, restitution: 0 },
      });
      box.position = [up[0], up[1] + 0.001, 0];
      const w = await worldOf([ramp, box], {
        ground: { enabled: false, friction: 0.5, restitution: 0, halfSize: 50, color: '#000' },
      });
      const p0 = w.getPose(box.id)!.position;
      run(w, 2);
      const p1 = w.getPose(box.id)!.position;
      results.push(vlen([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]) > 1.0);
    }
    expect(results).toEqual([false, true]); // μ = 0.5 -> critical angle ≈ 26.6°
  });

  it('keeps a 10-box tower standing', async () => {
    const boxes = Array.from({ length: 10 }, (_, i) =>
      createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [0, 0.5 + i * 1.0, 0], material: 'wood' }),
    );
    const w = await worldOf(boxes);
    run(w, 5);
    const top = w.getPose(boxes[9].id)!.position;
    expect(Math.abs(top[0])).toBeLessThan(0.05);
    expect(top[1]).toBeGreaterThan(9.3);
  });
});

describe('joints', () => {
  it('ball-joint pendulum has the physical-pendulum period', async () => {
    const L = 2;
    const bob = createBody({
      shape: { type: 'sphere', size: [0.2, 0.2, 0.2] },
      position: [Math.sin(0.1) * L, 6 - Math.cos(0.1) * L, 0],
      ...noDamp,
    });
    const j = createJoint({ type: 'ball', bodyA: null, bodyB: bob.id, anchorA: [0, 6, 0] });
    const w = await worldOf([bob, j], { physicsHz: 240 });
    const xs: number[] = [];
    for (let i = 0; i < 240 * 6; i++) {
      w.stepOnce();
      xs.push(w.getPose(bob.id)!.position[0]);
    }
    // measure time between successive upward zero-crossings
    const t: number[] = [];
    for (let i = 1; i < xs.length; i++) if (xs[i - 1] < 0 && xs[i] >= 0) t.push(i / 240);
    expect(t.length).toBeGreaterThanOrEqual(2);
    const period = t[1] - t[0];
    const r = 0.1;
    const expected = 2 * Math.PI * Math.sqrt((L / 9.81) * (1 + (0.4 * (r * r)) / (L * L)));
    expect(Math.abs(period - expected) / expected).toBeLessThan(0.02);
  });

  it('spring-mass oscillator matches 2π√(m/k)', async () => {
    const m = createBody({
      shape: { type: 'box', size: [0.5, 0.5, 0.5] },
      position: [2, 5, 0],
      material: { preset: 'custom', density: 80 },
      ...noDamp,
      gravityScale: 0,
    });
    const sp = createJoint({
      type: 'spring',
      bodyA: null,
      bodyB: m.id,
      anchorA: [0, 5, 0],
      anchorB: [0, 0, 0],
      spring: { restLength: 1, stiffness: 800, damping: 0, breakForce: 0 },
    });
    const w = await worldOf([m, sp], { gravity: [0, 0, 0] });
    const mass = w.builtInfo().mass[m.id];
    const xs: number[] = [];
    for (let i = 0; i < 240; i++) {
      w.stepOnce();
      xs.push(w.getPose(m.id)!.position[0]);
    }
    const t: number[] = [];
    for (let i = 1; i < xs.length; i++) if (xs[i - 1] - 1 > 0 && xs[i] - 1 <= 0) t.push(i / 120);
    expect(t.length).toBeGreaterThanOrEqual(2);
    const expected = 2 * Math.PI * Math.sqrt(mass / 800);
    expect(Math.abs(t[1] - t[0] - expected) / expected).toBeLessThan(0.03);
  });

  it('a velocity motor spins a hinge at the target speed and honours limits', async () => {
    const wheel = createBody({
      shape: { type: 'cylinder', size: [1, 0.2, 1] },
      position: [0, 3, 0],
      rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
      ...noDamp,
    });
    const hinge = createJoint({
      type: 'hinge',
      bodyA: null,
      bodyB: wheel.id,
      anchorA: [0, 3, 0],
      axis: [0, 0, 1],
      motor: {
        mode: 'velocity',
        targetVelocity: 8,
        targetPosition: 0,
        stiffness: 0,
        damping: 100,
        maxForce: 5000,
        keyPos: '',
        keyNeg: '',
        slewRate: 1,
        brake: true,
      },
    });
    const w = await worldOf([wheel, hinge]);
    run(w, 2);
    const st = w.getJointRec(hinge.id)!;
    expect(st.speed).toBeGreaterThan(7.5);
    expect(st.speed).toBeLessThan(8.5);
    expect(st.value).toBeGreaterThan(10); // multi-turn angle is unwrapped

    const w2 = await worldOf([wheel, { ...hinge, limit: { enabled: true, min: -0.5, max: 0.5 } }]);
    run(w2, 2);
    expect(w2.getJointRec(hinge.id)!.value).toBeLessThan(0.6);
  });

  it('a position motor drives a slider to its target', async () => {
    const block = createBody({ shape: { type: 'box', size: [0.5, 0.5, 0.5] }, position: [0, 3, 0], gravityScale: 0 });
    const slider = createJoint({
      type: 'slider',
      bodyA: null,
      bodyB: block.id,
      anchorA: [0, 3, 0],
      axis: [1, 0, 0],
      motor: {
        mode: 'position',
        targetVelocity: 0,
        targetPosition: 1.5,
        stiffness: 8000,
        damping: 800,
        maxForce: 1e5,
        keyPos: '',
        keyNeg: '',
        slewRate: 1,
        brake: true,
      },
    });
    const w = await worldOf([block, slider], { gravity: [0, 0, 0] });
    run(w, 3);
    expect(w.getPose(block.id)!.position[0]).toBeCloseTo(1.5, 1);
  });

  it('keyboard input drives a keyed motor', async () => {
    const wheel = createBody({
      shape: { type: 'cylinder', size: [1, 0.2, 1] },
      position: [0, 3, 0],
      rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
      ...noDamp,
    });
    const hinge = createJoint({
      type: 'hinge',
      bodyA: null,
      bodyB: wheel.id,
      anchorA: [0, 3, 0],
      axis: [0, 0, 1],
      motor: {
        mode: 'velocity',
        targetVelocity: 5,
        targetPosition: 0,
        stiffness: 0,
        damping: 100,
        maxForce: 5000,
        keyPos: 'KeyW',
        keyNeg: 'KeyS',
        slewRate: 1,
        brake: true,
      },
    });
    const w = await worldOf([wheel, hinge]);
    run(w, 1);
    expect(Math.abs(w.getJointRec(hinge.id)!.speed)).toBeLessThan(0.1);
    w.setKeys(['KeyW']);
    run(w, 1);
    expect(w.getJointRec(hinge.id)!.speed).toBeGreaterThan(4.5);
    w.setKeys(['KeyS']);
    run(w, 1.5);
    expect(w.getJointRec(hinge.id)!.speed).toBeLessThan(-4.5);
  });

  it('weld joints hold heavy loads and breakable springs snap', async () => {
    const anchor = createBody({ shape: { type: 'box', size: [1, 1, 1] }, bodyType: 'static', position: [0, 10, 0] });
    const load = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      position: [0, 8.0, 0],
      material: { preset: 'custom', density: 8000 },
    });
    const weld = createJoint({ type: 'fixed', bodyA: anchor.id, bodyB: load.id, anchorA: [0, -0.75, 0] });
    const w = await worldOf([anchor, load, weld]);
    run(w, 3);
    expect(w.getPose(load.id)!.position[1]).toBeCloseTo(8.0, 2);

    const cable = createJoint({
      type: 'spring',
      bodyA: anchor.id,
      bodyB: load.id,
      anchorA: [0, -0.5, 0],
      anchorB: [0, 0.5, 0],
      spring: { restLength: 1, stiffness: 1e6, damping: 1000, breakForce: 20000 },
    });
    const w2 = await worldOf([anchor, load, cable]);
    run(w2, 1);
    expect(w2.getJointRec(cable.id)!.broken).toBe(true); // 8000 kg × 9.81 = 78 kN > 20 kN
    const w3 = await worldOf([
      anchor,
      load,
      { ...cable, spring: { ...cable.spring, damping: 1e5, breakForce: 200000 } },
    ]);
    run(w3, 3);
    expect(w3.getJointRec(cable.id)!.broken).toBe(false);
    expect(w3.getJointRec(cable.id)!.force).toBeGreaterThan(70000);
  });
});

describe('energy', () => {
  it('conserves mechanical energy for an elastic bounce', async () => {
    const ball = createBody({
      shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
      position: [0, 4, 0],
      ...noDamp,
      material: { preset: 'custom', density: 500, restitution: 1, friction: 0 },
    });
    const w = await worldOf([ball], {
      ground: { enabled: true, friction: 0, restitution: 1, halfSize: 50, color: '#000' },
    });
    const total = () => {
      w.readPoses(1);
      const e = w.stats().energy;
      return e.kinetic + e.rotational + e.potential + e.elastic;
    };
    const e0 = total();
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      w.stepOnce();
      worst = Math.max(worst, Math.abs(total() - e0) / Math.abs(e0));
    }
    expect(worst).toBeLessThan(0.08);
  });
});

describe('determinism and live edits', () => {
  it('replays identically', async () => {
    const mk = () =>
      Array.from({ length: 12 }, (_, i) =>
        createBody({
          id: `fixed${i}`,
          shape: { type: i % 2 ? 'box' : 'sphere', size: [0.6, 0.6, 0.6] },
          position: [(i % 3) * 0.7, 2 + i * 0.8, (i % 2) * 0.3],
        }),
      );
    const ents = mk().map((e, i) => ({ ...e, id: `b${i}` }));
    const w1 = await worldOf(ents);
    const w2 = await worldOf(ents);
    run(w1, 3);
    run(w2, 3);
    for (const e of ents) expect(w1.getPose(e.id)!.position).toEqual(w2.getPose(e.id)!.position);
  });

  it('adds, edits and removes bodies while running', async () => {
    const a = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [0, 0.5, 0] });
    const w = await worldOf([a]);
    run(w, 0.5);
    const b = createBody({ shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [3, 4, 0] });
    w.applyOp({ op: 'addBody', body: b });
    run(w, 1);
    expect(w.getPose(b.id)!.position[1]).toBeLessThan(3);
    w.applyOp({ op: 'updateBody', body: { ...b, shape: { type: 'sphere', size: [1, 1, 1] } } });
    run(w, 1);
    expect(w.getPose(b.id)).not.toBeNull();
    expect(w.builtInfo().mass[b.id]).toBeGreaterThan(0.5 * 0.5 * 0.5 * 1000 * 0.52 * 7); // larger sphere is heavier
    w.applyOp({ op: 'remove', ids: [b.id] });
    expect(w.getPose(b.id)).toBeNull();
    expect(w.bodyIds).toEqual([a.id]);
  });
});

describe('performance', () => {
  it('steps 400 bodies comfortably in real time', async () => {
    const boxes = Array.from({ length: 400 }, (_, i) =>
      createBody({
        shape: { type: i % 3 === 0 ? 'sphere' : 'box', size: [0.5, 0.5, 0.5] },
        position: [(i % 8) * 0.6, 1 + Math.floor(i / 64) * 0.7, (Math.floor(i / 8) % 8) * 0.6],
      }),
    );
    const w = await worldOf(boxes);
    const t0 = performance.now();
    run(w, 2);
    const ms = (performance.now() - t0) / (2 * 120);
    process.stderr.write(`400 bodies: ${ms.toFixed(2)} ms / step\n`);
    expect(ms).toBeLessThan(8.3); // fits a 120 Hz budget
  });
});

describe('settings', () => {
  it('changing gravity wakes sleeping bodies', async () => {
    const ball = createBody({ shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [0, 5, 0] });
    const w = await worldOf([ball], { gravity: [0, 0, 0] });
    run(w, 3); // falls asleep in zero-g
    expect(w.getPose(ball.id)!.position[1]).toBeCloseTo(5, 3);
    w.applyOp({ op: 'settings', settings: { ...w.settings, gravity: [0, -9.81, 0] } });
    run(w, 1);
    expect(w.getPose(ball.id)!.position[1]).toBeLessThan(0.7 * 5);
  });

  it('ghost bodies keep their mass but do not collide', async () => {
    const ghost = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [0, 3, 0], ghost: true });
    const solid = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [0, 3, 0] });
    const w = await worldOf([ghost, solid]);
    expect(w.builtInfo().mass[ghost.id]).toBeGreaterThan(0);
    run(w, 2);
    expect(w.getPose(ghost.id)!.position[1]).toBeLessThan(-5); // fell through the floor
    expect(w.getPose(solid.id)!.position[1]).toBeCloseTo(0.5, 1); // the solid one stands on it
  });
});

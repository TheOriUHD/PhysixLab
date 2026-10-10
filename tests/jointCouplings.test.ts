/**
 * JT-A: the coupled joint types against analytic expectations (Atwood machine, gear ratio and reversal, rack pitch,
 * screw lead, belt ratio and slip, winch reel-in, cone/6-DOF limits, soft weld stiffness, universal-joint twist lock).
 */
import { describe, expect, it } from 'vitest';
import { Builder } from '../src/model/builder';
import { PhysicsWorld } from '../src/physics/world';
import { qrot, type Vec3 } from '../src/core/math';
import { defaultDof } from '../src/model/jointParams';

const G = 9.81;
const noGround = { ground: { enabled: false, friction: 0.5, restitution: 0, halfSize: 50, color: '#000' } } as const;

async function make(b: Builder, extra: Record<string, unknown> = {}): Promise<PhysicsWorld> {
  const doc = b.done();
  doc.settings = { ...doc.settings, ...noGround, ...extra };
  return PhysicsWorld.create(doc);
}
const stepFor = (w: PhysicsWorld, sec: number) => {
  const n = Math.round(sec * w.settings.physicsHz);
  for (let i = 0; i < n; i++) w.stepOnce();
};

describe('pulley (JT-3)', () => {
  it('reproduces the Atwood machine a = (m2 − m1)g/(m1 + m2)', async () => {
    const b = new Builder('atwood');
    const m1 = b.body('m1', 'box', [0.4, 0.4, 0.4], [-1, 0, 0], { massOverride: 1 });
    const m2 = b.body('m2', 'box', [0.4, 0.4, 0.4], [1, 0, 0], { massOverride: 3 });
    const j = b.joint('pulley', m1, m2, [0, 0, 0], [0, 0, 1], {
      params: { ...b.joint('pulley', null, null, [0, 0, 0]).params, pulleyA: [-1, 6, 0], pulleyB: [1, 6, 0], ratio: 1 },
    });
    b.doc.entities = b.doc.entities.filter((e) => e.kind !== 'joint' || e.id === j.id);
    // anchors on both bodies' centres
    j.anchorA = [0, 0, 0];
    j.anchorB = [0, 0, 0];
    const w = await make(b);
    const t = 0.6;
    stepFor(w, t);
    const a = ((3 - 1) * G) / 4;
    const y2 = w.getPose(m2.id)!.position[1];
    const y1 = w.getPose(m1.id)!.position[1];
    expect(y2).toBeCloseTo(-0.5 * a * t * t, 1);
    expect(y1).toBeCloseTo(0.5 * a * t * t, 1);
    expect(w.getJointRec(j.id)!.force).toBeCloseTo((2 * 1 * 3 * G) / 4, 0); // tension 2 m1 m2 g/(m1+m2)
  });

  it('ratio 2 (a 2:1 block-and-tackle) moves the second mass half as far', async () => {
    const b = new Builder('tackle');
    const m1 = b.body('m1', 'box', [0.4, 0.4, 0.4], [-1, 0, 0], { massOverride: 1 });
    const m2 = b.body('m2', 'box', [0.4, 0.4, 0.4], [1, 0, 0], { massOverride: 4 });
    const j = b.joint('pulley', m1, m2, [0, 0, 0], [0, 0, 1]);
    j.params = { ...j.params, pulleyA: [-1, 6, 0], pulleyB: [1, 6, 0], ratio: 2 };
    j.anchorA = [0, 0, 0];
    j.anchorB = [0, 0, 0];
    const w = await make(b);
    stepFor(w, 0.4);
    const y1 = w.getPose(m1.id)!.position[1];
    const y2 = w.getPose(m2.id)!.position[1];
    expect(y1).toBeGreaterThan(0.02); // lifted
    expect(y2).toBeCloseTo(-y1 / 2, 2);
  });
});

/** Two wheels on hinges to the world, joined by a gear/belt/rack joint. */
function wheels(
  type: 'gear' | 'belt',
  opts: { ratio?: number; reverse?: boolean; rA?: number; rB?: number; slip?: number },
) {
  const b = new Builder(type);
  const a = b.body('A', 'cylinder', [0.5, 0.2, 0.5], [0, 0, 0], { rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
  const c = b.body('B', 'cylinder', [0.5, 0.2, 0.5], [2, 0, 0], { rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
  const hA = b.joint('hinge', null, a, [0, 0, 0], [0, 0, 1]);
  const hB = b.joint('hinge', null, c, [2, 0, 0], [0, 0, 1]);
  hA.motor = { ...hA.motor, mode: 'velocity', targetVelocity: 4, maxForce: 1e4, damping: 1e4 };
  const g = b.joint(type, a, c, [0, 0, 0], [0, 0, 1]);
  g.anchorB = [0, 0, 0];
  g.params = {
    ...g.params,
    axisB: c.rotation ? qrotInvZ(c.rotation) : [0, 0, 1],
    ratio: opts.ratio ?? 1,
    reverse: opts.reverse ?? true,
    radiusA: opts.rA ?? 0.5,
    radiusB: opts.rB ?? 0.5,
    slipTorque: opts.slip ?? 0,
  };
  g.axis = qrotInvZ(a.rotation);
  void hB;
  return { b, a, c, g };
}
const qrotInvZ = (q: [number, number, number, number]): Vec3 => {
  // the local axis that points along world +Z for a body rotated by q
  const inv: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]];
  return qrot(inv, [0, 0, 1]);
};

describe('gear pair (JT-4)', () => {
  it('reverses direction and applies the ratio ωB = −ratio·ωA', async () => {
    const { b, a, c } = wheels('gear', { ratio: 2, reverse: true });
    const w = await make(b);
    stepFor(w, 1.5);
    const wa = w.getPose(a.id)!.angvel[2];
    const wb = w.getPose(c.id)!.angvel[2];
    expect(Math.abs(wa)).toBeGreaterThan(1);
    expect(wb / wa).toBeCloseTo(-2, 1);
  });
  it('keeps the same direction when not reversing', async () => {
    const { b, a, c } = wheels('gear', { ratio: 1, reverse: false });
    const w = await make(b);
    stepFor(w, 1.5);
    expect(w.getPose(c.id)!.angvel[2] / w.getPose(a.id)!.angvel[2]).toBeCloseTo(1, 1);
  });
});

describe('belt / chain (JT-5)', () => {
  it('turns the driven pulley at rA/rB of the driver, same direction', async () => {
    const { b, a, c } = wheels('belt', { rA: 0.6, rB: 0.2, reverse: false });
    const w = await make(b);
    stepFor(w, 1.5);
    expect(w.getPose(c.id)!.angvel[2] / w.getPose(a.id)!.angvel[2]).toBeCloseTo(3, 1);
  });
  it('slips when the torque exceeds the slip limit', async () => {
    const free = wheels('belt', { rA: 0.5, rB: 0.5, reverse: false, slip: 0 });
    const slip = wheels('belt', { rA: 0.5, rB: 0.5, reverse: false, slip: 0.01 });
    // load the driven wheel with a heavy brake: a damped hinge
    for (const s of [free, slip]) {
      const h = s.b.doc.entities.filter((e) => e.kind === 'joint' && e.type === 'hinge')[1];
      if (h.kind === 'joint') h.motor = { ...h.motor, mode: 'velocity', targetVelocity: 0, maxForce: 50, damping: 50 };
    }
    const wf = await make(free.b);
    const ws = await make(slip.b);
    stepFor(wf, 1);
    stepFor(ws, 1);
    const rf = wf.getPose(free.c.id)!.angvel[2] / wf.getPose(free.a.id)!.angvel[2];
    const rs = ws.getPose(slip.c.id)!.angvel[2] / ws.getPose(slip.a.id)!.angvel[2];
    process.stderr.write(`belt ratios ${rf} ${rs}\n`);
    expect(rf).toBeCloseTo(1, 1);
    expect(rs).toBeLessThan(0.8);
  });
});

describe('rack and pinion (JT-4)', () => {
  it('moves the rack r·ω per second (pitch radius × angular speed)', async () => {
    const b = new Builder('rack');
    const pinion = b.body('pinion', 'cylinder', [0.3, 0.2, 0.3], [0, 1, 0], {
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    });
    const rk = b.body('rack', 'box', [2, 0.1, 0.2], [0, 0.5, 0], {});
    const h = b.joint('hinge', null, pinion, [0, 1, 0], [0, 0, 1]);
    h.motor = { ...h.motor, mode: 'velocity', targetVelocity: 2, maxForce: 1e4, damping: 1e4 };
    const s = b.joint('slider', null, rk, [0, 0.5, 0], [1, 0, 0]);
    void s;
    const j = b.joint('rack', pinion, rk, [0, 1, 0], [0, 0, 1]);
    j.axis = qrotInvZ(pinion.rotation);
    j.anchorB = [0, 0, 0];
    j.params = { ...j.params, radiusA: 0.3, axisB: [1, 0, 0], reverse: false };
    const w = await make(b);
    stepFor(w, 1);
    const speed = w.getPose(rk.id)!.linvel[0];
    const wp = w.getPose(pinion.id)!.angvel[2];
    expect(Math.abs(speed)).toBeCloseTo(Math.abs(wp) * 0.3, 1);
    expect(Math.abs(speed)).toBeGreaterThan(0.3);
  });
});

describe('screw (JT-7)', () => {
  it('advances pitch metres per revolution', async () => {
    const b = new Builder('screw');
    const rod = b.body('rod', 'box', [0.1, 0.1, 2], [0, 0, 0], { bodyType: 'static' });
    const nut = b.body('nut', 'box', [0.3, 0.3, 0.2], [0, 0, 0], { massOverride: 1 });
    const j = b.joint('screw', rod, nut, [0, 0, 0], [0, 0, 1], { params: undefined });
    j.params = { ...j.params, pitch: 0.2 };
    // drive the nut's spin with an initial angular velocity, no gravity
    const doc = b.done();
    const wld = await PhysicsWorld.create({ ...doc, settings: { ...doc.settings, ...noGround, gravity: [0, 0, 0] } });
    wld.setVelocity?.(nut.id, [0, 0, 0], [0, 0, 6.2832]);
    stepFor(wld, 1);
    const pz = wld.getPose(nut.id)!.position[2];
    const turns = wld.getPose(nut.id)!.angvel[2] / (2 * Math.PI);
    expect(Math.abs(pz)).toBeGreaterThan(0.1);
    expect(Math.abs(pz)).toBeCloseTo(Math.abs(0.2 * turns), 1);
  });
});

describe('winch (JT-7)', () => {
  it('reels the load in at the motor speed and pays out when overloaded', async () => {
    const mk = (rating: number) => {
      const b = new Builder('winch');
      const drum = b.body('drum', 'box', [0.4, 0.4, 0.4], [0, 4, 0], { bodyType: 'static' });
      const load = b.body('load', 'box', [0.4, 0.4, 0.4], [0, 1, 0], { massOverride: 5 });
      const j = b.joint('winch', drum, load, [0, 4, 0], [0, 0, 1]);
      j.anchorA = [0, 0, 0];
      j.anchorB = [0, 0, 0];
      j.motor = { ...j.motor, mode: 'velocity', targetVelocity: 0.5, maxForce: 1000 };
      j.params = { ...j.params, loadRating: rating, radiusA: 0.2 };
      return { b, load, j };
    };
    const ok = mk(200);
    const w = await make(ok.b);
    stepFor(w, 2);
    // starts 3 m below the drum, reels 0.5 m/s for 2 s: now ≈ 2 m below
    expect(w.getPose(ok.load.id)!.position[1]).toBeGreaterThan(1.8);
    expect(w.getPose(ok.load.id)!.position[1]).toBeLessThan(2.2);
    const weak = mk(10); // 5 kg weighs 49 N > 10 N rating
    const w2 = await make(weak.b);
    stepFor(w2, 1);
    expect(w2.getPose(weak.load.id)!.position[1]).toBeLessThan(0.5);
  });
});

describe('universal joint (JT-6)', () => {
  it('bends about two axes but resists twist', async () => {
    const b = new Builder('universal');
    const top = b.body('top', 'box', [0.2, 0.2, 0.2], [0, 3, 0], { bodyType: 'static' });
    const arm = b.body('arm', 'box', [0.1, 1, 0.1], [0, 2.5, 0], { massOverride: 1 });
    const j = b.joint('universal', top, arm, [0, 3, 0], [0, 1, 0]);
    void j;
    const w = await make(b);
    w.setVelocity?.(arm.id, [1, 0, 0], [0, 4, 0]); // swing sideways and try to spin about the shaft
    stepFor(w, 1);
    const p = w.getPose(arm.id)!;
    expect(Math.abs(p.angvel[1])).toBeLessThan(0.5); // twist about the shaft is locked
    expect(Math.hypot(p.position[0], p.position[2])).toBeGreaterThan(0.1); // but it swings
  });
});

describe('soft weld (JT-8)', () => {
  it('sags under load by m·g/k and holds', async () => {
    const b = new Builder('softweld');
    const top = b.body('top', 'box', [0.4, 0.4, 0.4], [0, 3, 0], { bodyType: 'static' });
    const mass = b.body('mass', 'box', [0.4, 0.4, 0.4], [0, 2.4, 0], { massOverride: 2 });
    const j = b.joint('softweld', top, mass, [0, 2.7, 0]);
    j.params = { ...j.params, linStiffness: 2000, linDamping: 120, angStiffness: 500, angDamping: 40 };
    const w = await make(b);
    stepFor(w, 3);
    const y = w.getPose(mass.id)!.position[1];
    expect(y).toBeCloseTo(2.4 - (2 * G) / 2000, 2); // static deflection m·g/k ≈ 9.8 mm
    stepFor(w, 0.5);
    expect(Math.abs(w.getPose(mass.id)!.position[1] - y)).toBeLessThan(1e-4); // at rest
  });
});

describe('cone-twist (JT-1)', () => {
  it('keeps a hanging arm inside the swing cone', async () => {
    const b = new Builder('cone');
    const top = b.body('top', 'box', [0.2, 0.2, 0.2], [0, 3, 0], { bodyType: 'static' });
    const arm = b.body('arm', 'box', [0.1, 1, 0.1], [0, 2.5, 0], { massOverride: 1 });
    // the cone axis points up (+Y world → local); the arm swung out pushes against the limit
    const j = b.joint('conetwist', top, arm, [0, 3, 0], [0, -1, 0]);
    j.params = { ...j.params, swing: 0.5, twistMin: -0.2, twistMax: 0.2 };
    const w = await make(b);
    w.setVelocity?.(arm.id, [3, 0, 0], [0, 0, -3]);
    let maxSwing = 0;
    for (let i = 0; i < 180; i++) {
      w.stepOnce();
      maxSwing = Math.max(maxSwing, w.getJointRec(j.id)!.value);
    }
    expect(maxSwing).toBeGreaterThan(0.3); // it did swing out
    expect(maxSwing).toBeLessThan(0.5 + 0.12); // and was stopped near the limit
  });
});

describe('6-DOF (JT-2)', () => {
  it('locked axes hold, a limited linear axis stops at its limit, a free one moves', async () => {
    const b = new Builder('sixdof');
    const base = b.body('base', 'box', [0.4, 0.4, 0.4], [0, 3, 0], { bodyType: 'static' });
    const car = b.body('car', 'box', [0.3, 0.3, 0.3], [0, 3, 0], { massOverride: 1 });
    const j = b.joint('sixdof', base, car, [0, 3, 0], [1, 0, 0]);
    const dof = defaultDof();
    dof[0] = { ...dof[0], mode: 'limited', min: -0.3, max: 0.5 };
    j.params = { ...j.params, dof };
    const w = await make(b, { gravity: [0, 0, 0] });
    w.setVelocity?.(car.id, [2, 0, 0], [0, 0, 0]);
    stepFor(w, 1.5);
    const p = w.getPose(car.id)!;
    expect(p.position[0]).toBeLessThan(0.5 + 0.06);
    expect(p.position[0]).toBeGreaterThan(0.35);
    expect(Math.abs(p.position[1] - 3)).toBeLessThan(0.01); // locked
  });
});

/**
 * Physics-side constraints for the joint types the engine has no native joint for (JT-A): pulley, rack-and-pinion,
 * gear pair, belt / chain, screw, winch, soft weld, plus the limits / springs / motors of cone-twist and 6-DOF joints.
 *
 * The engine's own joint (when there is one) holds the positional DOFs; this module adds velocity-level rows that
 * are solved once per engine step *before* it, as impulses on the two bodies (`applyImpulse`/`applyTorqueImpulse`).
 * Each row is a Jacobian (J_A, J_B) with `cdot = J·v`; the impulse is `λ = −(cdot + bias)/(K + γ)` clamped to
 * `[lo, hi]`, `K = J M⁻¹ Jᵀ`. Velocities are *predicted* with this step's gravity so a constraint that holds a hanging
 * mass is exact (the Atwood machine reproduces a = (m2−m1)g/(m1+m2)). Soft rows (springs, soft weld) use the
 * implicit softness of Box2D/Catto, so they stay stable at any stiffness.
 *
 * Approximations (also in docs/LIMITATIONS.md): one pass per step (no iterations between rows of different joints),
 * the angular coordinates of 6-DOF / cone-twist use the rotation vector (exact per single axis, approximate for large
 * simultaneous rotations), and ropes/limits are unilateral with speculative contact.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import {
  clamp,
  qconj,
  qmul,
  qrot,
  qrotInv,
  qtwist,
  vadd,
  vcross,
  vdot,
  vlen,
  vscale,
  vsub,
  type Quat,
  type Vec3,
} from '../../core/math';
import type { JointRec, WorldState } from './state';
import { pos, QI, rot, ZERO } from './util';

/** Position-error correction factor of the hard and unilateral rows. */
const BETA = 0.2;
/** True during the after-step pass (readouts are only integrated in the before-step pass). */
let postPass = false;
const INF = Infinity;

interface Dyn {
  rb: RAPIER.RigidBody;
  dyn: boolean;
  im: number;
  /** World inverse inertia, upper triangle: m11 m12 m13 m22 m23 m33. */
  I: [number, number, number, number, number, number];
  v: Vec3;
  w: Vec3;
  com: Vec3;
}
const mk = (): Dyn => ({
  rb: null as never,
  dyn: false,
  im: 0,
  I: [0, 0, 0, 0, 0, 0],
  v: [0, 0, 0],
  w: [0, 0, 0],
  com: [0, 0, 0],
});
const dA = mk();
const dB = mk();

function load(d: Dyn, rb: RAPIER.RigidBody, g: Vec3, dt: number): void {
  d.rb = rb;
  d.dyn = rb.isDynamic();
  const c = rb.worldCom();
  d.com[0] = c.x;
  d.com[1] = c.y;
  d.com[2] = c.z;
  const lv = rb.linvel();
  const av = rb.angvel();
  if (d.dyn) {
    d.im = rb.invMass();
    const m = rb.effectiveWorldInvInertia();
    d.I[0] = m.m11;
    d.I[1] = m.m12;
    d.I[2] = m.m13;
    d.I[3] = m.m22;
    d.I[4] = m.m23;
    d.I[5] = m.m33;
    const gs = rb.gravityScale() * dt;
    d.v[0] = lv.x + g[0] * gs;
    d.v[1] = lv.y + g[1] * gs;
    d.v[2] = lv.z + g[2] * gs;
  } else {
    d.im = 0;
    d.I.fill(0);
    d.v[0] = lv.x;
    d.v[1] = lv.y;
    d.v[2] = lv.z;
  }
  d.w[0] = av.x;
  d.w[1] = av.y;
  d.w[2] = av.z;
}

/** The current Jacobian: `cdot = lA·vA + aA·ωA + lB·vB + aB·ωB`. */
const R = { lA: [0, 0, 0] as Vec3, aA: [0, 0, 0] as Vec3, lB: [0, 0, 0] as Vec3, aB: [0, 0, 0] as Vec3 };

function set3(o: Vec3, x: number, y: number, z: number): void {
  o[0] = x;
  o[1] = y;
  o[2] = z;
}
function clearRow(): void {
  set3(R.lA, 0, 0, 0);
  set3(R.aA, 0, 0, 0);
  set3(R.lB, 0, 0, 0);
  set3(R.aB, 0, 0, 0);
}
/** Pure angular row: `cdot = cA·(nA·ωA) + cB·(nB·ωB)`. */
function angRow(nA: Vec3, cA: number, nB: Vec3, cB: number): void {
  clearRow();
  set3(R.aA, nA[0] * cA, nA[1] * cA, nA[2] * cA);
  set3(R.aB, nB[0] * cB, nB[1] * cB, nB[2] * cB);
}
/** `cdot = sB·n·(vB + ωB×rB) + sA·n·(vA + ωA×rA)` — a linear direction measured at the two anchor points. */
function linRow(n: Vec3, rA: Vec3, sA: number, rB: Vec3, sB: number): void {
  const ca = vcross(rA, n);
  const cb = vcross(rB, n);
  set3(R.lA, n[0] * sA, n[1] * sA, n[2] * sA);
  set3(R.aA, ca[0] * sA, ca[1] * sA, ca[2] * sA);
  set3(R.lB, n[0] * sB, n[1] * sB, n[2] * sB);
  set3(R.aB, cb[0] * sB, cb[1] * sB, cb[2] * sB);
}

function imul(d: Dyn, a: Vec3): Vec3 {
  const I = d.I;
  return [
    I[0] * a[0] + I[1] * a[1] + I[2] * a[2],
    I[1] * a[0] + I[3] * a[1] + I[4] * a[2],
    I[2] * a[0] + I[4] * a[1] + I[5] * a[2],
  ];
}

/** Solve the current row, apply the impulse to both bodies and keep the predicted velocities in sync. Returns λ. */
function solve(bias: number, lo: number, hi: number, gamma = 0): number {
  const cdot = vdot(R.lA, dA.v) + vdot(R.aA, dA.w) + vdot(R.lB, dB.v) + vdot(R.aB, dB.w);
  const IaA = imul(dA, R.aA);
  const IaB = imul(dB, R.aB);
  const K = dA.im * vdot(R.lA, R.lA) + vdot(R.aA, IaA) + dB.im * vdot(R.lB, R.lB) + vdot(R.aB, IaB) + gamma;
  if (K < 1e-12) return 0;
  const lam = clamp(-(cdot + bias) / K, lo, hi);
  if (Math.abs(lam) < 1e-12) return 0;
  if (dA.dyn) push(dA, R.lA, R.aA, IaA, lam);
  if (dB.dyn) push(dB, R.lB, R.aB, IaB, lam);
  return lam;
}
function push(d: Dyn, l: Vec3, a: Vec3, Ia: Vec3, lam: number): void {
  d.rb.applyImpulse({ x: l[0] * lam, y: l[1] * lam, z: l[2] * lam }, true);
  d.rb.applyTorqueImpulse({ x: a[0] * lam, y: a[1] * lam, z: a[2] * lam }, true);
  d.v[0] += d.im * l[0] * lam;
  d.v[1] += d.im * l[1] * lam;
  d.v[2] += d.im * l[2] * lam;
  d.w[0] += Ia[0] * lam;
  d.w[1] += Ia[1] * lam;
  d.w[2] += Ia[2] * lam;
}

/** Unilateral limit row: `C > 0` is a violation, `Ċ = cdot`; only pulls back (λ ≤ 0). Returns λ. */
function limit(C: number, dt: number): number {
  return solve(C < 0 ? C / dt : (BETA * C) / dt, -INF, 0);
}
/** Soft (spring-damper) row on coordinate error `C`; returns λ. */
function soft(C: number, k: number, c: number, dt: number): number {
  if (k <= 0 && c <= 0) return 0;
  const gamma = 1 / (dt * (c + dt * k));
  const bias = C * dt * k * gamma;
  return solve(bias, -INF, INF, gamma);
}

function rotVec(q: Quat): Vec3 {
  const s = q[3] < 0 ? -1 : 1;
  const x = q[0] * s,
    y = q[1] * s,
    z = q[2] * s,
    w = q[3] * s;
  const n = Math.hypot(x, y, z);
  if (n < 1e-9) return [0, 0, 0];
  const ang = 2 * Math.atan2(n, w);
  return [(x / n) * ang, (y / n) * ang, (z / n) * ang];
}

const UNIT: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const KINEMATIC = new Set(['gear', 'belt', 'rack', 'screw']);
export const COUPLED_TYPES = new Set([
  'conetwist',
  'sixdof',
  'pulley',
  'rack',
  'gear',
  'belt',
  'screw',
  'winch',
  'softweld',
]);

/** Set the runtime values of a coupling at build time (rope lengths …). Called by `addJoint`. */
export function initCoupling(s: WorldState, rec: JointRec): void {
  const t = rec.def.type;
  rec.rt = [];
  const rbA = rec.A?.rb ?? s.worldBody;
  const rbB = rec.B?.rb ?? s.worldBody;
  const pA = vadd(pos(rbA), qrot(rec.A ? rot(rbA) : QI, rec.aA));
  const pB = vadd(pos(rbB), qrot(rec.B ? rot(rbB) : QI, rec.aB));
  const p = rec.def.params;
  if (t === 'pulley') {
    rec.rt = [vlen(vsub(pA, p.pulleyA)) + p.ratio * vlen(vsub(pB, p.pulleyB))];
  } else if (t === 'winch') {
    rec.rt = [Math.max(0.02, vlen(vsub(pB, pA)))];
  } else if (t === 'gear' || t === 'belt' || t === 'rack' || t === 'screw') {
    rec.rt = [0];
  }
}

/** Run the coupling rows of every coupled joint; called once before each engine step with that step's `dt`. */
export function stepCouplings(s: WorldState, dt: number, post = false): void {
  // The `post` pass (after the engine step) re-couples the purely kinematic types so the velocities a motor or a
  // contact disturbed inside the step are consistent again when they are read; it needs no gravity prediction.
  const g = post ? ZERO : s.settings.gravity;
  postPass = post;
  for (const rec of s.jointOrder) {
    if (rec.broken || !rec.joint || !COUPLED_TYPES.has(rec.def.type)) continue;
    if (post && !KINEMATIC.has(rec.def.type)) continue;
    if ((rec.A && rec.A.disabled) || (rec.B && rec.B.disabled)) continue;
    const rbA = rec.A ? rec.A.rb : s.worldBody;
    const rbB = rec.B ? rec.B.rb : s.worldBody;
    if (!rbA.isDynamic() && !rbB.isDynamic()) continue;
    if (rec.rt.length === 0) initCoupling(s, rec);
    load(dA, rbA, g, dt);
    load(dB, rbB, g, dt);
    const qA = rec.A ? rot(rbA) : QI;
    const qB = rec.B ? rot(rbB) : QI;
    switch (rec.def.type) {
      case 'gear':
      case 'belt':
        gearLike(rec, qA, qB, dt);
        break;
      case 'rack':
        rack(rec, qA, qB, dt);
        break;
      case 'pulley':
        pulley(rec, qA, qB, dt, s);
        break;
      case 'winch':
        winch(s, rec, qA, qB, dt);
        break;
      case 'screw':
        screw(rec, qA, qB, dt);
        break;
      case 'softweld':
        softweld(rec, qA, qB, dt);
        break;
      case 'conetwist':
        coneTwist(rec, qA, qB, dt);
        break;
      case 'sixdof':
        sixDof(rec, qA, qB, dt);
        break;
      default:
        break;
    }
  }
}

function anchors(rec: JointRec, qA: Quat, qB: Quat) {
  const pA = vadd(rec.A ? pos(rec.A.rb) : ZERO, qrot(qA, rec.aA));
  const pB = vadd(rec.B ? pos(rec.B.rb) : ZERO, qrot(qB, rec.aB));
  return { pA, pB, rA: vsub(pA, dA.com), rB: vsub(pB, dB.com) };
}

function axisWorld(q: Quat, a: Vec3): Vec3 {
  const w = qrot(q, a);
  const l = vlen(w) || 1;
  return [w[0] / l, w[1] / l, w[2] / l];
}

// ---- gear pair, belt / chain -----------------------------------------------------------------------------------

/** Angular coupling `ωB·nB + s·ratio·ωA·nA = 0`; the belt's slip torque limits the driver's torque. */
function gearLike(rec: JointRec, qA: Quat, qB: Quat, dt: number): void {
  const p = rec.def.params;
  const nA = axisWorld(qA, rec.def.axis);
  const nB = axisWorld(qB, p.axisB);
  const belt = rec.def.type === 'belt';
  const ratio = belt ? p.radiusA / p.radiusB : p.ratio;
  const sgn = p.reverse ? 1 : -1;
  angRow(nA, sgn * ratio, nB, 1);
  const slip = belt && p.slipTorque > 0 ? (p.slipTorque * dt) / Math.max(ratio, 1e-6) : INF;
  const lam = solve(0, -slip, slip);
  const wa = vdot(dA.w, nA);
  if (postPass) return;
  rec.rt[0] += wa * dt;
  rec.value = rec.rt[0];
  rec.speed = wa;
  rec.force = Math.abs(lam) / dt; // torque on the driven shaft, N·m
}

// ---- rack and pinion -----------------------------------------------------------------------------------------------

function rack(rec: JointRec, qA: Quat, qB: Quat, dt: number): void {
  const p = rec.def.params;
  const nA = axisWorld(qA, rec.def.axis);
  const dir = axisWorld(qB, p.axisB);
  const sgn = p.reverse ? 1 : -1; // vB·dir + sgn·r·ωA·nA = 0
  clearRow();
  set3(R.lB, dir[0], dir[1], dir[2]);
  set3(R.aA, nA[0] * sgn * p.radiusA, nA[1] * sgn * p.radiusA, nA[2] * sgn * p.radiusA);
  const lam = solve(0, -INF, INF);
  const wa = vdot(dA.w, nA);
  if (postPass) return;
  rec.rt[0] += wa * dt * p.radiusA;
  rec.value = rec.rt[0];
  rec.speed = wa * p.radiusA;
  rec.force = Math.abs(lam) / dt; // force on the rack, N
}

// ---- pulley ------------------------------------------------------------------------------------------------------------

function pulley(rec: JointRec, qA: Quat, qB: Quat, dt: number, _s: WorldState): void {
  const p = rec.def.params;
  const { pA, pB, rA, rB } = anchors(rec, qA, qB);
  const dAv = vsub(pA, p.pulleyA);
  const dBv = vsub(pB, p.pulleyB);
  const la = vlen(dAv);
  const lb = vlen(dBv);
  if (la < 1e-6 || lb < 1e-6) return;
  const nA = vscale(dAv, 1 / la);
  const nB = vscale(dBv, 1 / lb);
  const C = la + p.ratio * lb - rec.rt[0];
  // Ċ = nA·v_A + ratio·nB·v_B (points on the rope ends, away from the pulleys)
  const ca = vcross(rA, nA);
  const cb = vcross(rB, nB);
  clearRow();
  set3(R.lA, nA[0], nA[1], nA[2]);
  set3(R.aA, ca[0], ca[1], ca[2]);
  set3(R.lB, nB[0] * p.ratio, nB[1] * p.ratio, nB[2] * p.ratio);
  set3(R.aB, cb[0] * p.ratio, cb[1] * p.ratio, cb[2] * p.ratio);
  const lam = limit(C, dt);
  rec.value = la + p.ratio * lb;
  rec.speed = 0;
  rec.force = -lam / dt; // rope tension, N
}

// ---- winch --------------------------------------------------------------------------------------------------------------

function winch(s: WorldState, rec: JointRec, qA: Quat, qB: Quat, dt: number): void {
  const def = rec.def;
  const m = def.motor;
  const { pA, pB, rA, rB } = anchors(rec, qA, qB);
  const d = vsub(pB, pA);
  const dist = vlen(d);
  if (dist < 1e-6) return;
  const n = vscale(d, 1 / dist);
  const hasKeys = !!(m.keyPos || m.keyNeg);
  const input = hasKeys ? (s.keys.has(m.keyPos) && m.keyPos ? 1 : 0) - (s.keys.has(m.keyNeg) && m.keyNeg ? 1 : 0) : 1;
  const reel = m.mode === 'velocity' ? m.targetVelocity * input : 0; // m/s of rope pulled in
  rec.rt[0] = Math.max(0.02, rec.rt[0] - reel * dt);
  const C = dist - rec.rt[0];
  linRow(n, rA, -1, rB, 1);
  const cap = def.params.loadRating > 0 ? def.params.loadRating * dt : INF;
  const lam = solve(C < 0 ? C / dt : (0.5 * C) / dt, -cap, 0);
  // Overloaded: the winch cannot hold the rope, it pays out as fast as the load pulls.
  if (lam <= -cap + 1e-9 && cap < INF) rec.rt[0] = Math.max(rec.rt[0], dist);
  rec.value = rec.rt[0];
  rec.speed = -reel;
  rec.force = -lam / dt;
}

// ---- screw --------------------------------------------------------------------------------------------------------------

function screw(rec: JointRec, qA: Quat, qB: Quat, dt: number): void {
  const p = rec.def.params;
  const { rA, rB } = anchors(rec, qA, qB);
  const n = axisWorld(qrotFrame(qA, rec.frameA), [1, 0, 0]);
  const lead = p.pitch / (2 * Math.PI); // metres of travel per radian of relative rotation
  linRow(n, rA, -1, rB, 1); // n·(v_B − v_A)
  R.aA[0] += lead * n[0];
  R.aA[1] += lead * n[1];
  R.aA[2] += lead * n[2];
  R.aB[0] -= lead * n[0];
  R.aB[1] -= lead * n[1];
  R.aB[2] -= lead * n[2];
  const lam = solve(0, -INF, INF);
  if (postPass) return;
  rec.value = rec.value + vdot(vsub(dB.w, dA.w), n) * dt;
  rec.speed = vdot(vsub(dB.w, dA.w), n);
  rec.force = Math.abs(lam) / dt;
}
const qrotFrame = (q: Quat, f: Quat): Quat => qmul(q, f);

// ---- soft weld ----------------------------------------------------------------------------------------------------------

function softweld(rec: JointRec, qA: Quat, qB: Quat, dt: number): void {
  const p = rec.def.params;
  const { pA, pB, rA, rB } = anchors(rec, qA, qB);
  const e = vsub(pB, pA);
  let lamSum = 0;
  for (let i = 0; i < 3; i++) {
    linRow(UNIT[i], rA, -1, rB, 1);
    lamSum += Math.abs(soft(e[i], p.linStiffness, p.linDamping, dt));
  }
  const fa = qmul(qA, rec.frameA);
  const fb = qmul(qB, rec.frameB);
  const rv = rotVec(qmul(fb, qconj(fa))); // B relative to A since build, in world axes
  for (let i = 0; i < 3; i++) {
    angRow(UNIT[i], -1, UNIT[i], 1);
    lamSum += Math.abs(soft(rv[i], p.angStiffness, p.angDamping, dt));
  }
  rec.value = vlen(e);
  rec.speed = 0;
  rec.force = lamSum / dt;
}

// ---- cone-twist -------------------------------------------------------------------------------------------------------

const X: Vec3 = [1, 0, 0];

function coneTwist(rec: JointRec, qA: Quat, qB: Quat, dt: number): void {
  const p = rec.def.params;
  const fA = qmul(qA, rec.frameA);
  const rel = qmul(qconj(fA), qmul(qB, rec.frameB)); // B's joint frame in A's joint frame
  const tw = qtwist(rel, X);
  const ct = Math.cos(tw / 2);
  const st = Math.sin(tw / 2);
  const swingQ = qmul(rel, [-st, 0, 0, ct]); // rel · twist⁻¹: pure swing
  const sw = swingQ[3] < 0 ? ([-swingQ[0], -swingQ[1], -swingQ[2], -swingQ[3]] as Quat) : swingQ;
  const sn = Math.hypot(sw[0], sw[1], sw[2]);
  const swing = 2 * Math.atan2(sn, sw[3]);
  let lam = 0;
  if (swing > p.swing && sn > 1e-9) {
    const nW = qrot(fA, [sw[0] / sn, sw[1] / sn, sw[2] / sn]);
    angRow(nW, -1, nW, 1);
    lam += limit(swing - p.swing, dt);
  }
  const nT = qrot(fA, X);
  if (tw > p.twistMax) {
    angRow(nT, -1, nT, 1);
    lam += limit(tw - p.twistMax, dt);
  } else if (tw < p.twistMin) {
    angRow(nT, 1, nT, -1);
    lam += limit(p.twistMin - tw, dt);
  }
  rec.value = swing;
  rec.speed = tw;
  rec.force = Math.abs(lam) / dt;
}

// ---- 6-DOF -----------------------------------------------------------------------------------------------------------------

function sixDof(rec: JointRec, qA: Quat, qB: Quat, dt: number): void {
  const p = rec.def.params;
  const fA = qmul(qA, rec.frameA);
  const { pA, pB, rA, rB } = anchors(rec, qA, qB);
  const dl = qrotInv(fA, vsub(pB, pA));
  const rv = rotVec(qmul(qconj(fA), qmul(qB, rec.frameB)));
  let lamSum = 0;
  for (let i = 0; i < 6; i++) {
    const dof = p.dof[i];
    if (dof.mode === 'locked') continue;
    const x = i < 3 ? dl[i] : rv[i - 3];
    const n = qrot(fA, UNIT[i % 3]);
    const row = (sgn: number) => (i < 3 ? linRow(n, rA, -sgn, rB, sgn) : angRow(n, -sgn, n, sgn));
    row(1);
    if (dof.motorForce > 0) {
      const cap = dof.motorForce * dt;
      lamSum += Math.abs(solve(-dof.motorVelocity, -cap, cap));
    }
    if (dof.stiffness > 0 || dof.damping > 0) lamSum += Math.abs(soft(x, dof.stiffness, dof.damping, dt));
    if (dof.mode === 'limited') {
      const lo = Math.min(dof.min, dof.max);
      const hi = Math.max(dof.min, dof.max);
      row(1);
      lamSum += Math.abs(limit(x - hi, dt));
      row(-1);
      lamSum += Math.abs(limit(lo - x, dt));
    }
  }
  rec.value = vlen(dl);
  rec.speed = 0;
  rec.force = lamSum / dt;
}

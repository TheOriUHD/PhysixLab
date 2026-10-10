/**
 * Joint load estimation (JT-10) and load-driven breakage (JT-11/12).
 *
 * The engine exposes no impulse for rigid joints, so the force and torque a joint transmits is reconstructed from
 * Newton–Euler momentum balance. For a set S of bodies, Σ m·a = Σ F_external + F_joint, so the force the joint exerts
 * on S is  F_joint = Σ (m·a − F_external)  and, about a point P,
 *   M_joint = Σ [ dL/dt + (c − P) × m·a ] − Σ τ_external,P .
 * Per body i that is  Fnet_i = m·a − F_ext  and  Mnet_i = dL/dt − τ_ext  (about its centre of mass); sums over S are
 * transferred to P with  M_P = Mnet + (c − P) × Fnet.  External forces are gravity, the contact manifolds (normal
 * impulses of the last engine step), user forces (thrusters, the mouse grab spring), linear / angular damping and the
 * spring joints. Quadratic drag is applied to the velocity before the measured step, so it cancels.
 *
 * Which S? The joint graph has the dynamic bodies as nodes and the rigid / rope joints as edges; an edge to a static,
 * kinematic or "world" end is a support. Cut the joint J:
 *  - If it disconnects the graph and one side has no support, that side is a free body and the balance on it gives
 *    the load exactly (this holds for every "bridge" joint: a mass hanging from a weld, a lever's hinge, a chain).
 *  - Otherwise (J lies in a loop, or both sides are supported) the problem is statically indeterminate. The shared-load
 *    heuristic balances each end body alone: the wrench the body needs from its joints, minus what the exact joints
 *    already supply, is split among the remaining (indeterminate) joints at that body — equal forces plus the
 *    minimum-norm force couple that supplies the leftover moment (it is carried as torque at a lone joint). The larger
 *    of the two ends' estimates is reported. The result is exact for statically determinate loops and a fair share
 *    otherwise.
 * Friction between bodies is not part of the balance (only normal contact impulses are read), which matters only for
 * joint assemblies that are held up or dragged by sliding friction.
 */
import { qmul, qrot, qrotInv, vadd, vcross, vdot, vlen, vscale, vsub, type Quat, type Vec3 } from '../../core/math';
import { isLoadBreakable, transmitsTorque } from '../../model/breakage';
import { hasIndependentAnchors } from '../../model/jointParams';
import type { JointRec, WorldState, BodyRec } from './state';
import { breakJoint } from './joints';
import { pos, QI, rot, X_AXIS, ZERO } from './util';

const fixedDt = (s: WorldState) => 1 / s.settings.physicsHz;
const engineDt = (s: WorldState) => fixedDt(s) / Math.max(1, Math.round(s.settings.substeps));

/** What the estimator knows about one joint (`JointRec.jl`). */
export interface JointLoad {
  /** Transmitted force (N) and torque (N·m, the part the joint type resists). */
  force: number;
  torque: number;
  /** Load / threshold of the most stressed component (0 when the joint has no threshold). */
  ratio: number;
  /** Accumulated fatigue damage, 0..1. */
  damage: number;
  /** True when the estimate is exact (a bridge of the joint graph), false for the shared-load heuristic. */
  exact: boolean;
}

export function newJointLoad(): JointLoad {
  return { force: 0, torque: 0, ratio: 0, damage: 0, exact: true };
}

/** A load this many times over its threshold fails the joint at once even when fatigue is on. */
export const INSTANT_FAIL_RATIO = 4;

interface Bal {
  rec: BodyRec;
  stamp: number;
  v0: Vec3;
  w0: Vec3;
  q0: Quat;
  c: Vec3;
  fnet: Vec3;
  mnet: Vec3;
}

interface Edge {
  j: JointRec;
  u: number; // node index of side A, -1 = support
  v: number;
  pa: Vec3; // world anchors on each side
  pb: Vec3;
  exact: boolean;
  fOnA: Vec3; // force of the joint on side A (reaction on B is the opposite)
  mOnA: Vec3; // moment on side A about pa
  f: number;
  t: number;
}

export class LoadTracker {
  readonly bals = new Map<BodyRec, Bal>();
  stamp = 0;
  /** Set by the host when something other than breakage wants live loads (inspector readout, stress overlay). */
  watch = false;
  armed = false;
}

/** Joints whose load the estimator tracks: rigid and rope joints that still exist. */
function eligible(j: JointRec): boolean {
  return !j.broken && !!j.joint && j.def.type !== 'spring';
}

/** Called once per fixed step before the engine steps: decide whether loads are needed this step. */
export function prepareLoads(s: WorldState): boolean {
  const t = s.loads;
  let want = t.watch;
  if (!want) for (const j of s.jointOrder) if (!j.broken && isLoadBreakable(j.def)) want = true;
  t.armed = want;
  return want;
}

/** Called before the last engine sub-step: remember the velocities the balance differences against. */
export function captureLoads(s: WorldState): void {
  const t = s.loads;
  t.stamp++;
  for (const j of s.jointOrder) {
    if (!eligible(j)) continue;
    for (const r of [j.A, j.B]) {
      if (!r || r.def.bodyType !== 'dynamic' || r.disabled) continue;
      let b = t.bals.get(r);
      if (!b) {
        b = { rec: r, stamp: 0, v0: ZERO, w0: ZERO, q0: QI, c: ZERO, fnet: ZERO, mnet: ZERO };
        t.bals.set(r, b);
      }
      if (b.stamp === t.stamp) continue;
      b.stamp = t.stamp;
      const v = r.rb.linvel();
      const w = r.rb.angvel();
      b.v0 = [v.x, v.y, v.z];
      b.w0 = [w.x, w.y, w.z];
      b.q0 = rot(r.rb);
    }
  }
}

function angMomentum(rb: BodyRec['rb'], q: Quat, w: Vec3): Vec3 {
  const pf = rb.principalInertiaLocalFrame();
  const frame = qmul(q, [pf.x, pf.y, pf.z, pf.w]);
  const I = rb.principalInertia();
  const wl = qrotInv(frame, w);
  return qrot(frame, [wl[0] * I.x, wl[1] * I.y, wl[2] * I.z]);
}

/** Net external force on the body and its moment about the centre of mass, accumulated into `acc`. */
function externals(s: WorldState, b: Bal, dt: number, acc: { f: Vec3; t: Vec3 }): void {
  const r = b.rec;
  const rb = r.rb;
  const m = r.mass;
  const c = b.c;
  const g = s.world.gravity;
  let f: Vec3 = vscale([g.x, g.y, g.z], m * rb.gravityScale());
  const uf = rb.userForce();
  const ut = rb.userTorque();
  f = vadd(f, [uf.x, uf.y, uf.z]);
  let t: Vec3 = [ut.x, ut.y, ut.z];
  const v = rb.linvel();
  const w = rb.angvel();
  const vm: Vec3 = [(b.v0[0] + v.x) / 2, (b.v0[1] + v.y) / 2, (b.v0[2] + v.z) / 2];
  const wm: Vec3 = [(b.w0[0] + w.x) / 2, (b.w0[1] + w.y) / 2, (b.w0[2] + w.z) / 2];
  f = vadd(f, vscale(vm, -rb.linearDamping() * m));
  const q = rot(rb);
  t = vadd(t, vscale(angMomentum(rb, q, wm), -rb.angularDamping()));
  // Contacts: normal impulse of the last engine step, applied at the solver contact points.
  for (const col of r.cols) {
    s.world.contactPairsWith(col, (c2) => {
      s.world.contactPair(col, c2, (man, flipped) => {
        const ns = man.numSolverContacts();
        if (ns === 0) return;
        const nc = man.numContacts();
        const n = man.normal();
        const sgn = flipped ? 1 : -1; // direction of the force on `col`
        const nrm: Vec3 = [n.x * sgn, n.y * sgn, n.z * sgn];
        let total = 0;
        for (let i = 0; i < nc; i++) total += man.contactImpulse(i);
        for (let i = 0; i < ns; i++) {
          const p = man.solverContactPoint(i);
          if (!p) continue;
          const imp = nc === ns ? man.contactImpulse(i) : total / ns;
          const fc = vscale(nrm, imp / dt);
          f = vadd(f, fc);
          t = vadd(t, vcross(vsub([p.x, p.y, p.z], c), fc));
        }
      });
    });
  }
  // Spring joints are known forces.
  for (const j of s.jointOrder) {
    if (j.def.type !== 'spring' || j.broken || !j.joint) continue;
    const onA = j.A === r;
    const onB = j.B === r;
    if (!onA && !onB) continue;
    const { pa, pb } = anchorsWorld(j);
    const d = vsub(pb, pa);
    const len = vlen(d);
    if (len < 1e-9) continue;
    const dir = vscale(d, 1 / len);
    if (onA) {
      const fs = vscale(dir, j.force);
      f = vadd(f, fs);
      t = vadd(t, vcross(vsub(pa, c), fs));
    }
    if (onB) {
      const fs = vscale(dir, -j.force);
      f = vadd(f, fs);
      t = vadd(t, vcross(vsub(pb, c), fs));
    }
  }
  acc.f = f;
  acc.t = t;
}

function anchorsWorld(j: JointRec): { pa: Vec3; pb: Vec3 } {
  const qa = j.A ? rot(j.A.rb) : QI;
  const qb = j.B ? rot(j.B.rb) : QI;
  return {
    pa: vadd(j.A ? pos(j.A.rb) : ZERO, qrot(qa, j.aA)),
    pb: vadd(j.B ? pos(j.B.rb) : ZERO, qrot(qb, j.aB)),
  };
}

function solve3(m: number[], b: Vec3): Vec3 | null {
  const [a, bb, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  const scale = Math.abs(a) + Math.abs(e) + Math.abs(i);
  if (Math.abs(det) < 1e-9 * scale * scale * scale || scale === 0) return null;
  const x = (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det;
  const y = (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det;
  const z = (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det;
  return [x, y, z];
}

/** Compute every tracked joint's load for the step that just finished; fail joints over their thresholds. */
export function computeLoads(s: WorldState): void {
  const t = s.loads;
  if (!t.armed) return;
  const dtE = engineDt(s);
  const bals: Bal[] = [];
  let anyAwake = false;
  for (const b of t.bals.values()) {
    if (b.stamp !== t.stamp) continue;
    const r = b.rec;
    const rb = r.rb;
    const m = r.mass;
    const v1 = rb.linvel();
    const w1 = rb.angvel();
    const com = rb.worldCom();
    b.c = [com.x, com.y, com.z];
    const a = vscale(vsub([v1.x, v1.y, v1.z], b.v0), 1 / dtE);
    const dL = vscale(vsub(angMomentum(rb, rot(rb), [w1.x, w1.y, w1.z]), angMomentum(rb, b.q0, b.w0)), 1 / dtE);
    const acc = { f: ZERO, t: ZERO };
    externals(s, b, dtE, acc);
    b.fnet = vsub(vscale(a, m), acc.f);
    b.mnet = vsub(dL, acc.t);
    if (!rb.isSleeping()) anyAwake = true;
    bals.push(b);
  }
  if (!anyAwake) return; // everything asleep: keep the previous estimate
  const index = new Map<BodyRec, number>();
  bals.forEach((b, i) => index.set(b.rec, i));

  // ---- graph -----------------------------------------------------------------------------------------------
  const edges: Edge[] = [];
  const adj: number[][] = bals.map(() => []);
  for (const j of s.jointOrder) {
    if (!eligible(j)) continue;
    const u = j.A ? (index.get(j.A) ?? -1) : -1;
    const v = j.B ? (index.get(j.B) ?? -1) : -1;
    if (u < 0 && v < 0) continue;
    const { pa, pb } = anchorsWorld(j);
    const e: Edge = {
      j,
      u,
      v,
      pa,
      pb: hasIndependentAnchors(j.def.type) ? pb : pa,
      exact: false,
      fOnA: ZERO,
      mOnA: ZERO,
      f: 0,
      t: 0,
    };
    const k = edges.push(e) - 1;
    if (u >= 0) adj[u].push(k);
    if (v >= 0 && v !== u) adj[v].push(k);
  }

  /** Bodies reachable from `start` without crossing edge `skip`; also whether a support edge touches them. */
  const reach = (start: number, skip: number): { set: Set<number>; support: boolean } => {
    const set = new Set<number>();
    let support = false;
    if (start < 0) return { set, support: true };
    const stack = [start];
    set.add(start);
    while (stack.length) {
      const n = stack.pop()!;
      for (const k of adj[n]) {
        if (k === skip) continue;
        const e = edges[k];
        if (e.u < 0 || e.v < 0) support = true;
        const o = e.u === n ? e.v : e.u;
        if (o >= 0 && !set.has(o)) {
          set.add(o);
          stack.push(o);
        }
      }
    }
    return { set, support };
  };

  // ---- exact pass: bridges with a free side ----------------------------------------------------------------
  edges.forEach((e, k) => {
    const sides: [number, number, boolean][] = [
      [e.u, e.v, true],
      [e.v, e.u, false],
    ];
    for (const [start, other, isA] of sides) {
      if (start < 0 || start === other) continue;
      const side = reach(start, k);
      if (side.support || (other >= 0 && side.set.has(other))) continue;
      // free body S = side.set: wrench of the joint on S about the anchor
      const P = e.pa;
      let F: Vec3 = ZERO;
      let M: Vec3 = ZERO;
      for (const n of side.set) {
        const b = bals[n];
        F = vadd(F, b.fnet);
        M = vadd(M, vadd(b.mnet, vcross(vsub(b.c, P), b.fnet)));
      }
      e.exact = true;
      e.fOnA = isA ? F : vscale(F, -1);
      e.mOnA = isA ? M : vscale(M, -1);
      return;
    }
  });

  // ---- shared-load heuristic for the rest ------------------------------------------------------------------
  const share = new Map<number, { f: Vec3; t: Vec3 }>(); // edge index -> strongest per-end estimate
  const bestOf = (k: number, f: Vec3, tq: Vec3) => {
    const cur = share.get(k);
    if (!cur || vlen(f) > vlen(cur.f)) share.set(k, { f: f, t: cur && vlen(cur.t) > vlen(tq) ? cur.t : tq });
    else if (vlen(tq) > vlen(cur.t)) cur.t = tq;
  };
  for (let n = 0; n < bals.length; n++) {
    const b = bals[n];
    let rf = b.fnet;
    let rm = b.mnet;
    const unknown: number[] = [];
    for (const k of adj[n]) {
      const e = edges[k];
      if (!e.exact) {
        unknown.push(k);
        continue;
      }
      const onA = e.u === n;
      const f = onA ? e.fOnA : vscale(e.fOnA, -1);
      const mP = onA ? e.mOnA : vscale(e.mOnA, -1);
      rf = vsub(rf, f);
      rm = vsub(rm, vadd(mP, vcross(vsub(e.pa, b.c), f)));
    }
    const kk = unknown.length;
    if (kk === 0) continue;
    const pts = unknown.map((k) => (edges[k].u === n ? edges[k].pa : edges[k].pb));
    const centroid = vscale(
      pts.reduce((acc, p) => vadd(acc, p), ZERO),
      1 / kk,
    );
    const eq = vscale(rf, 1 / kk);
    const left = vsub(rm, vcross(vsub(centroid, b.c), rf));
    const mm = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of pts) {
      const d = vsub(p, centroid);
      const d2 = vdot(d, d);
      mm[0] += d2 - d[0] * d[0];
      mm[1] -= d[0] * d[1];
      mm[2] -= d[0] * d[2];
      mm[3] -= d[1] * d[0];
      mm[4] += d2 - d[1] * d[1];
      mm[5] -= d[1] * d[2];
      mm[6] -= d[2] * d[0];
      mm[7] -= d[2] * d[1];
      mm[8] += d2 - d[2] * d[2];
    }
    const w = kk > 1 ? solve3(mm, left) : null;
    let torqueLeft = left;
    if (w) {
      // forces from the couple carry the moment; nothing is left for joint torque
      torqueLeft = ZERO;
    }
    unknown.forEach((k, i) => {
      const f = w ? vadd(eq, vcross(w, vsub(pts[i], centroid))) : eq;
      bestOf(k, f, vscale(torqueLeft, 1 / kk));
    });
  }
  share.forEach((v, k) => {
    const e = edges[k];
    e.fOnA = v.f;
    e.mOnA = v.t;
    e.exact = false;
  });

  // ---- publish, then break ---------------------------------------------------------------------------------
  const dtF = fixedDt(s);
  for (const e of edges) {
    const j = e.j;
    const jl = (j.jl ??= newJointLoad());
    const type = j.def.type;
    jl.exact = e.exact;
    jl.force = vlen(e.fOnA);
    let tq = 0;
    if (transmitsTorque(type)) {
      if (type === 'hinge') {
        const qa = j.A ? rot(j.A.rb) : QI;
        const ax = qrot(qmul(qa, j.frameA), X_AXIS);
        const along = vdot(e.mOnA, ax);
        tq = vlen(vsub(e.mOnA, vscale(ax, along)));
      } else tq = vlen(e.mOnA);
    }
    jl.torque = tq;
    if (type === 'rope') j.force = jl.force;
    const br = j.def.breakage;
    let ratio = 0;
    if (br && isLoadBreakable(j.def)) {
      if (br.force > 0) ratio = Math.max(ratio, jl.force / br.force);
      if (br.torque > 0 && transmitsTorque(type)) ratio = Math.max(ratio, jl.torque / br.torque);
    }
    jl.ratio = ratio;
    if (!br || ratio === 0) continue;
    if (br.fatigue.enabled) {
      const rate = Math.max(0, (ratio - br.fatigue.start) / (1 - br.fatigue.start));
      jl.damage = Math.min(1, jl.damage + (rate * dtF) / br.fatigue.life);
      if (jl.damage >= 1 || ratio >= INSTANT_FAIL_RATIO) breakJoint(s, j, jl.force, jl.torque);
    } else if (ratio >= 1) breakJoint(s, j, jl.force, jl.torque);
  }
}

/** Forget the load bookkeeping of bodies that left the world. */
export function pruneLoads(s: WorldState): void {
  for (const [r] of s.loads.bals) if (!s.bodies.has(r.id)) s.loads.bals.delete(r);
}

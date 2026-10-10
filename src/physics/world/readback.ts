/**
 * Per-frame readback of the live world into the flat buffers of the frame protocol: body poses (with
 * render interpolation), velocities, net force estimate, sleep state and kinetic energy; joint state;
 * contact points. Soft-body particles are read in `soft.ts` (`readSoft`), which also folds their
 * energy into the totals computed here. These loops run once per frame over every body, so they write
 * into a caller-supplied buffer and avoid per-body allocation where the engine API allows.
 */
import { qslerp } from '../../core/math';
import { BODY_STRIDE, CONTACT_STRIDE, J, JOINT_STRIDE, type SimEvent } from '../protocol';
import { springElasticEnergy } from './energy';
import { engineDt } from './stepping';
import { measureJoint } from './joints';
import type { WorldState } from './state';

export function readPoses(s: WorldState, alpha: number, out?: Float32Array): Float32Array {
  const frameDt = s.simSinceRead;
  s.simSinceRead = 0;
  const n = s.order.length;
  const buf = out && out.length >= n * BODY_STRIDE ? out : new Float32Array(n * BODY_STRIDE);
  const g = s.settings.gravity;
  const energy = s.rigidEnergy;
  energy.reset();
  let awake = 0;
  for (let i = 0; i < n; i++) {
    const r = s.order[i];
    const o = i * BODY_STRIDE;
    const t = r.rb.translation();
    const q = r.rb.rotation();
    let px = t.x,
      py = t.y,
      pz = t.z;
    let qx = q.x,
      qy = q.y,
      qz = q.z,
      qw = q.w;
    if (alpha < 1 && r.hasPrev && !r.disabled) {
      const p = r.prev;
      px = p[0] + (px - p[0]) * alpha;
      py = p[1] + (py - p[1]) * alpha;
      pz = p[2] + (pz - p[2]) * alpha;
      const sl = qslerp([p[3], p[4], p[5], p[6]], [qx, qy, qz, qw], alpha);
      qx = sl[0];
      qy = sl[1];
      qz = sl[2];
      qw = sl[3];
    }
    buf[o] = px;
    buf[o + 1] = py;
    buf[o + 2] = pz;
    buf[o + 3] = qx;
    buf[o + 4] = qy;
    buf[o + 5] = qz;
    buf[o + 6] = qw;
    const isDyn = r.def.bodyType === 'dynamic';
    const lv = r.rb.linvel(),
      av = r.rb.angvel();
    buf[o + 7] = lv.x;
    buf[o + 8] = lv.y;
    buf[o + 9] = lv.z;
    buf[o + 10] = av.x;
    buf[o + 11] = av.y;
    buf[o + 12] = av.z;
    const sleeping = r.disabled ? 2 : isDyn && r.rb.isSleeping() ? 1 : 0;
    buf[o + 16] = sleeping;
    let ke = 0;
    if (isDyn && !r.disabled) {
      if (frameDt > 0 && !sleeping) {
        buf[o + 13] = (r.mass * (lv.x - r.vPrev[0])) / frameDt;
        buf[o + 14] = (r.mass * (lv.y - r.vPrev[1])) / frameDt;
        buf[o + 15] = (r.mass * (lv.z - r.vPrev[2])) / frameDt;
      } else if (sleeping) {
        buf[o + 13] = buf[o + 14] = buf[o + 15] = 0;
      }
      r.vPrev = [lv.x, lv.y, lv.z];
      ke = energy.addBody(r, lv, av, q, g);
      if (!sleeping) awake++;
    } else {
      buf[o + 13] = buf[o + 14] = buf[o + 15] = 0;
    }
    buf[o + 17] = ke;
  }
  s.lastEnergy = energy.finish(springElasticEnergy(s.jointOrder));
  s.awakeCount = awake;
  return buf;
}

export function readJoints(s: WorldState, out?: Float32Array): Float32Array {
  const n = s.jointOrder.length;
  const buf = out && out.length >= n * JOINT_STRIDE ? out : new Float32Array(n * JOINT_STRIDE);
  for (let i = 0; i < n; i++) {
    const j = s.jointOrder[i];
    const o = i * JOINT_STRIDE;
    if (!j.broken && j.joint) measureJoint(j);
    buf[o + J.value] = j.value;
    buf[o + J.speed] = j.speed;
    buf[o + J.force] = j.force;
    buf[o + J.broken] = j.broken ? 1 : 0;
  }
  return buf;
}

/** Contact points (world space) of awake bodies for the contact overlay. */
export function readContacts(s: WorldState, max = 800): Float32Array {
  const out: number[] = [];
  let total = 0;
  // Contact impulses belong to the last engine (sub-)step, so the force estimate divides by its length.
  const dt = engineDt(s);
  for (const r of s.order) {
    if (r.def.bodyType !== 'dynamic' || r.disabled || r.rb.isSleeping()) continue;
    const c = r.col;
    s.world.contactPairsWith(c, (c2) => {
      const other = c2.parent();
      const otherDyn = other ? other.isDynamic() : false;
      if (otherDyn && c2.handle < c.handle) return; // report each dynamic pair once
      s.world.contactPair(c, c2, (m, flipped) => {
        const ns = m.numSolverContacts();
        if (ns === 0) return;
        const nc = m.numContacts();
        let imp = 0;
        for (let i = 0; i < nc; i++) imp += m.contactImpulse(i);
        const force = imp / dt;
        const nrm = m.normal();
        const sgn = flipped ? -1 : 1;
        for (let i = 0; i < ns; i++) {
          total++;
          if (out.length / CONTACT_STRIDE >= max) continue;
          const p = m.solverContactPoint(i);
          if (!p) continue;
          out.push(p.x, p.y, p.z, nrm.x * sgn, nrm.y * sgn, nrm.z * sgn, force / ns);
        }
      });
    });
  }
  s.lastContacts = total;
  return new Float32Array(out);
}

/** Events raised since the last call (e.g. a spring breaking); the queue is emptied. */
export function drainEvents(s: WorldState): SimEvent[] {
  const e = s.events;
  s.events = [];
  return e;
}

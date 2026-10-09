/**
 * Forces applied from outside the constraint solver: thrusters, the mouse grab spring, impulses and
 * explosions. `applyThrusters` / `applyGrab` run before every step; the rest are one-shot ops.
 */
import { qrot, qrotInv, vadd, vcross, vlen, vscale, vsub, type Vec3 } from '../../core/math';
import type { WorldState } from './state';
import { pos, rot, rv } from './util';

/** Grab spring natural frequency (rad/s) and acceleration cap (m/s²). */
const GRAB_OMEGA = 15;
const GRAB_MAX_ACCEL = 400;

/** Body-local thrust force/torque for bodies whose thruster is active (always-on, or its key is held). */
export function applyThrusters(s: WorldState): void {
  for (const r of s.order) {
    if (r.def.bodyType !== 'dynamic' || r.disabled) continue;
    const t = r.def.thrust;
    const active = !!t && (t.mode === 'always' || (!!t.key && s.keys.has(t.key)));
    if (!active && !r.forced) continue;
    r.rb.resetForces(false);
    r.rb.resetTorques(false);
    r.forced = false;
    if (active && t) {
      const q = rot(r.rb);
      r.rb.addForce(rv(qrot(q, t.force)), true);
      r.rb.addTorque(rv(qrot(q, t.torque)), true);
      r.forced = true;
    }
  }
}

export function beginGrab(s: WorldState, id: string, point: Vec3, target: Vec3): void {
  const rec = s.bodies.get(id);
  if (!rec || rec.def.bodyType !== 'dynamic') return;
  const local = qrotInv(rot(rec.rb), vsub(point, pos(rec.rb)));
  rec.rb.wakeUp();
  s.grab = { rec, local, target };
}

/** Critically-damped spring (with gravity compensation and an acceleration cap) at the grab point. */
export function applyGrab(s: WorldState): void {
  const g = s.grab;
  if (!g || g.rec.disabled) return;
  const rb = g.rec.rb;
  const q = rot(rb);
  const p = vadd(pos(rb), qrot(q, g.local));
  const v = rb.velocityAtPoint(rv(p));
  const err = vsub(g.target, p);
  const m = g.rec.mass;
  let acc = vsub(vscale(err, GRAB_OMEGA * GRAB_OMEGA), vscale([v.x, v.y, v.z], 2 * GRAB_OMEGA));
  const al = vlen(acc);
  if (al > GRAB_MAX_ACCEL) acc = vscale(acc, GRAB_MAX_ACCEL / al);
  // Counter gravity so a held body hovers under the cursor, as if carried by hand.
  const grav = vscale(s.settings.gravity, -g.rec.def.gravityScale);
  const f = vscale(vadd(acc, grav), m);
  rb.resetForces(false);
  rb.resetTorques(false);
  rb.addForceAtPoint(rv(f), rv(p), true);
  const w = rb.angvel();
  const inertia = rb.principalInertia();
  const iAvg = (inertia.x + inertia.y + inertia.z) / 3;
  rb.addTorque(rv(vscale([w.x, w.y, w.z], -iAvg * 6)), true);
  g.rec.forced = true;
}

export function impulse(s: WorldState, id: string, imp: Vec3, point: Vec3): void {
  const rec = s.bodies.get(id);
  if (!rec || rec.def.bodyType !== 'dynamic') return;
  rec.rb.applyImpulseAtPoint(rv(imp), rv(point), true);
}

export function explode(s: WorldState, center: Vec3, strength: number, radius: number): void {
  for (const r of s.order) {
    if (r.def.bodyType !== 'dynamic' || r.disabled) continue;
    const com = r.rb.worldCom();
    const d = vsub([com.x, com.y, com.z], center);
    const dist = vlen(d);
    if (dist > radius) continue;
    const falloff = 1 - dist / radius;
    const dir = dist < 1e-6 ? ([0, 1, 0] as Vec3) : vscale(d, 1 / dist);
    // Impulse scales with exposed area (~ mass^(2/3)) so light and heavy objects both react.
    const j = strength * falloff * falloff * Math.pow(Math.max(r.mass, 0.01), 2 / 3);
    r.rb.applyImpulse(rv(vadd(vscale(dir, j), [0, j * 0.25, 0])), true);
    const spin = vcross(dir, [0, 1, 0]);
    r.rb.applyTorqueImpulse(rv(vscale(spin, j * 0.05)), true);
  }
}

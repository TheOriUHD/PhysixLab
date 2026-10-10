/**
 * Forces applied from outside the constraint solver: thrusters, the mouse grab spring, impulses and
 * explosions. `applyThrusters` / `applyGrab` run before every step; the rest are one-shot ops.
 */
import { qrot, qrotInv, vadd, vlen, vscale, vsub, type Vec3 } from '../../core/math';
import type { BlastKind, FalloffKind } from '../protocol';
import { blastImpulse } from './blast';
import type { BodyRec, WorldState } from './state';
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

export function beginGrab(s: WorldState, id: string, point: Vec3, target: Vec3, strength = 1): void {
  const rec = s.bodies.get(id);
  if (!rec || rec.def.bodyType !== 'dynamic') return;
  const local = qrotInv(rot(rec.rb), vsub(point, pos(rec.rb)));
  rec.rb.wakeUp();
  s.grab = { rec, local, target, strength: Math.min(8, Math.max(0.05, strength)), spin: [0, 0, 0] };
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
  const omega = GRAB_OMEGA * Math.sqrt(g.strength);
  const maxAccel = GRAB_MAX_ACCEL * g.strength;
  let acc = vsub(vscale(err, omega * omega), vscale([v.x, v.y, v.z], 2 * omega));
  const al = vlen(acc);
  if (al > maxAccel) acc = vscale(acc, maxAccel / al);
  // Counter gravity so a held body hovers under the cursor, as if carried by hand.
  const grav = vscale(s.settings.gravity, -g.rec.def.gravityScale);
  const f = vscale(vadd(acc, grav), m);
  rb.resetForces(false);
  rb.resetTorques(false);
  rb.addForceAtPoint(rv(f), rv(p), true);
  const w = rb.angvel();
  const inertia = rb.principalInertia();
  const iAvg = (inertia.x + inertia.y + inertia.z) / 3;
  // Damp the spin towards the requested one (zero unless the user is rotating the held body, ED-45).
  rb.addTorque(rv(vscale([w.x - g.spin[0], w.y - g.spin[1], w.z - g.spin[2]], -iAvg * 6)), true);
  g.rec.forced = true;
}

export function impulse(s: WorldState, id: string, imp: Vec3, point: Vec3): void {
  const rec = s.bodies.get(id);
  if (!rec || rec.def.bodyType !== 'dynamic') return;
  rec.rb.applyImpulseAtPoint(rv(imp), rv(point), true);
}

/** Let go of the held body; its velocity is scaled by `throwScale` (1 = keep, the default; 0 = drop it dead). */
export function releaseGrab(s: WorldState, throwScale = 1): void {
  const g = s.grab;
  s.grab = null;
  if (!g || g.rec.disabled || throwScale === 1) return;
  const v = g.rec.rb.linvel();
  g.rec.rb.setLinvel(rv(vscale([v.x, v.y, v.z], throwScale)), true);
  if (throwScale < 1) {
    const w = g.rec.rb.angvel();
    g.rec.rb.setAngvel(rv(vscale([w.x, w.y, w.z], throwScale)), true);
  }
}

/** Freeze a body where it is (axes locked, velocities zeroed) or give it back its own axis locks. Toggles when `frozen` is undefined. */
export function freezeBody(s: WorldState, rec: BodyRec, frozen?: boolean): void {
  const on = frozen ?? !s.frozen.has(rec.id);
  const rb = rec.rb;
  if (on) {
    s.frozen.add(rec.id);
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    rb.setEnabledTranslations(false, false, false, true);
    rb.setEnabledRotations(false, false, false, true);
  } else {
    s.frozen.delete(rec.id);
    const lp = rec.def.lockPosition,
      lr = rec.def.lockRotation;
    rb.setEnabledTranslations(!lp[0], !lp[1], !lp[2], true);
    rb.setEnabledRotations(!lr[0], !lr[1], !lr[2], true);
    rb.wakeUp();
  }
}

export function explode(
  s: WorldState,
  center: Vec3,
  strength: number,
  radius: number,
  kind: BlastKind = 'radial',
  falloff: FalloffKind = 'quadratic',
  dir: Vec3 = [0, 0, -1],
): void {
  const params = { kind, falloff, center, dir, strength, radius };
  for (const r of s.order) {
    if (r.def.bodyType !== 'dynamic' || r.disabled || s.frozen.has(r.id)) continue;
    const com = r.rb.worldCom();
    const e = blastImpulse(params, [com.x, com.y, com.z], r.mass);
    if (!e) continue;
    r.rb.applyImpulse(rv(e.impulse), true);
    if (e.torque[0] || e.torque[1] || e.torque[2]) r.rb.applyTorqueImpulse(rv(e.torque), true);
  }
}

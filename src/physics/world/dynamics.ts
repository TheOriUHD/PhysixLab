/**
 * Per-step body dynamics driven by per-body fields: quadratic drag (applied before every engine step) and the
 * emulated sleep threshold (checked once per fixed step).
 */
import { qmul, qrot, qrotInv, type Quat } from '../../core/math';
import type { WorldState } from './state';

/**
 * Quadratic drag, F = −c·|v|·v and τ = −c_ω·|ω|·ω, integrated implicitly: v ← v / (1 + (c/m)·|v|·dt). The
 * implicit form is unconditionally stable (it can slow a body to rest but never reverse or amplify it) and
 * converges to the analytic terminal speed √(m·g / c) of the explicit force. Angular drag is evaluated per
 * principal axis with that axis' moment of inertia, so non-spherical bodies decelerate anisotropically.
 */
export function applyDrag(s: WorldState, dt: number): void {
  const wind = s.settings.wind;
  const wx = wind ? wind[0] : 0,
    wy = wind ? wind[1] : 0,
    wz = wind ? wind[2] : 0;
  for (const r of s.draggers) {
    if (r.disabled || r.rb.isSleeping()) continue;
    const { linear2, angular2 } = r.def.drag;
    const rb = r.rb;
    if (linear2 > 0 && r.mass > 0) {
      // -- JT-B: drag acts on the velocity relative to the wind --
      const v = rb.linvel();
      const rx = v.x - wx,
        ry = v.y - wy,
        rz = v.z - wz;
      const speed = Math.hypot(rx, ry, rz);
      if (speed > 1e-9) {
        const f = 1 / (1 + (linear2 / r.mass) * speed * dt);
        rb.setLinvel({ x: wx + rx * f, y: wy + ry * f, z: wz + rz * f }, false);
      }
    }
    if (angular2 > 0) {
      const w = rb.angvel();
      const speed = Math.hypot(w.x, w.y, w.z);
      if (speed > 1e-9) {
        const q = rb.rotation();
        const pf = rb.principalInertiaLocalFrame();
        const frame: Quat = qmul([q.x, q.y, q.z, q.w], [pf.x, pf.y, pf.z, pf.w]);
        const I = rb.principalInertia();
        const wl = qrotInv(frame, [w.x, w.y, w.z]);
        const inertia = [I.x, I.y, I.z];
        for (let i = 0; i < 3; i++) if (inertia[i] > 1e-12) wl[i] /= 1 + (angular2 / inertia[i]) * speed * dt;
        const out = qrot(frame, wl);
        rb.setAngvel({ x: out[0], y: out[1], z: out[2] }, false);
      }
    }
  }
}

/** A body must stay below its sleep threshold this long (simulated seconds) before it is put to sleep. */
export const SLEEP_AFTER = 0.5;

/**
 * Bodies with a `sleepThreshold` have the engine's own sleeping switched off (Rapier's bindings expose no
 * per-body threshold) and are put to sleep here instead: once both the linear speed and the surface speed of
 * the rotation (|ω| × bounding radius) have stayed under the threshold for `SLEEP_AFTER` seconds. A touch from
 * an awake body wakes them as usual.
 */
export function emulateSleep(s: WorldState, dt: number): void {
  for (const r of s.sleepers) {
    const sl = r.sleep;
    if (!sl || r.disabled || r.rb.isSleeping()) continue;
    if (s.grab?.rec === r || r.forced) {
      sl.calm = 0;
      continue;
    }
    const v = r.rb.linvel();
    const w = r.rb.angvel();
    const calm = Math.hypot(v.x, v.y, v.z) < sl.threshold && Math.hypot(w.x, w.y, w.z) * sl.radius < sl.threshold;
    sl.calm = calm ? sl.calm + dt : 0;
    if (sl.calm >= SLEEP_AFTER) {
      r.rb.sleep();
      sl.calm = 0;
    }
  }
}

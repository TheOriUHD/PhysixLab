/**
 * Time stepping: fixed-step accumulator with render interpolation, the per-step pre/post hooks
 * (motors, thrusters, grab springs; out-of-bounds culling, hinge-angle and spring measurement) and
 * the manual (paused) stepping used by the "step" button.
 */
import { clamp } from '../../core/math';
import { applyDrag, emulateSleep } from './dynamics';
import { applyGrab, applyThrusters } from './forces';
import { driveMotor, measureJoint, measureSpring } from './joints';
import { applySoftGrab } from './soft';
import type { WorldState } from './state';

/** Bodies that fall below this height are switched off. */
const KILL_Y = -400;

export function fixedDt(s: WorldState): number {
  return 1 / s.settings.physicsHz;
}

/** Engine sub-steps per fixed step (`settings.substeps`, at least 1). */
export function substepCount(s: WorldState): number {
  return Math.max(1, Math.round(s.settings.substeps));
}

/** Length of one engine step: the fixed step divided into `substeps` equal parts. */
export function engineDt(s: WorldState): number {
  return fixedDt(s) / substepCount(s);
}

/** Apply motors, thrusters and the grab springs before a step. */
function preStep(s: WorldState, dt: number): void {
  for (const j of s.jointOrder) if (j.def.motor.mode !== 'off' || j.cache[0] !== 0) driveMotor(s, j, dt);
  applyThrusters(s);
  applySoftGrab(s);
  applyGrab(s);
}

function postStep(s: WorldState, dt: number): void {
  emulateSleep(s, dt);
  for (const r of s.order) {
    if (r.disabled || r.def.bodyType === 'static') continue;
    if (r.rb.translation().y < KILL_Y) {
      r.disabled = true;
      r.rb.setEnabled(false);
    }
  }
  for (const j of s.jointOrder) {
    if (j.broken || !j.joint) continue;
    if (j.def.type === 'spring') measureSpring(s, j);
    else if (j.def.type === 'hinge') measureJoint(j); // keeps the unwrapped angle continuous
  }
}

/**
 * Advance the simulation by exactly one fixed step: the pre-step hooks run once, then the engine takes
 * `settings.substeps` equal steps (its integration `dt` is `engineDt`, see `applySettings`) so stiff
 * contacts and joints converge better without changing the fixed-step bookkeeping or the interpolation.
 */
export function stepOnce(s: WorldState): void {
  const dt = fixedDt(s);
  preStep(s, dt);
  const n = substepCount(s);
  for (let i = n; i > 0; i--) {
    applyDrag(s, dt / n);
    s.world.step();
  }
  s.simTime += dt;
  s.simSinceRead += dt;
  s.stepCount++;
  postStep(s, dt);
}

/**
 * Advance by wall-clock time (scaled), interpolating the remainder. Returns the number of
 * fixed steps taken. `budgetMs` bounds the work done in one call (the sim then falls behind
 * real time instead of freezing the worker).
 */
export function advance(s: WorldState, realDt: number, timeScale: number, budgetMs = 28): number {
  const dt = fixedDt(s);
  s.acc += Math.min(realDt, 0.25) * timeScale;
  const wanted = Math.floor(s.acc / dt);
  let done = 0;
  const t0 = performance.now();
  while (done < wanted) {
    if (done === wanted - 1 || (done >= 1 && performance.now() - t0 > budgetMs)) snapshotPrev(s);
    stepOnce(s);
    done++;
    if (performance.now() - t0 > budgetMs && done < wanted) break;
  }
  s.acc -= done * dt;
  if (done < wanted) s.acc = Math.min(s.acc, dt); // fell behind: drop the backlog
  if (done > 0) {
    const ms = (performance.now() - t0) / done;
    s.stepMsEma = s.stepMsEma === 0 ? ms : s.stepMsEma * 0.9 + ms * 0.1;
  }
  const wantedTime = realDt * timeScale;
  s.rtf = wantedTime > 0 ? clamp((done * dt) / wantedTime, 0, 4) : 1;
  return done;
}

/** Manual stepping (paused): render the exact post-step state. */
export function stepManual(s: WorldState, n: number): void {
  for (let i = 0; i < n; i++) stepOnce(s);
  s.acc = 0;
  for (const r of s.order) r.hasPrev = false;
}

function snapshotPrev(s: WorldState): void {
  for (const r of s.order) {
    if (r.def.bodyType === 'static' || r.disabled) {
      r.hasPrev = false;
      continue;
    }
    const t = r.rb.translation(),
      q = r.rb.rotation();
    const p = r.prev;
    p[0] = t.x;
    p[1] = t.y;
    p[2] = t.z;
    p[3] = q.x;
    p[4] = q.y;
    p[5] = q.z;
    p[6] = q.w;
    r.hasPrev = true;
  }
}

/** Fixed-step interpolation factor for the current accumulator. */
export function alpha(s: WorldState): number {
  return clamp(s.acc / fixedDt(s), 0, 1);
}

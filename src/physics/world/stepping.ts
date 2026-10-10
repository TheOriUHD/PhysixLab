/**
 * Time stepping: fixed-step accumulator with render interpolation, the per-step pre/post hooks
 * (motors, thrusters, grab springs; out-of-bounds culling, hinge-angle and spring measurement) and
 * the manual (paused) stepping used by the "step" button.
 */
import { clamp } from '../../core/math';
import { applyDrag, emulateSleep } from './dynamics';
import { stepCouplings } from './couplings';
import { collectEvents, stepPending } from './events';
import { applySoftWalls, checkBounds } from './bounds'; // -- ZN-34
import { applyGrab, applyThrusters } from './forces';
import { driveMotor, measureJoint, measureSpring } from './joints';
import { applySoftGrab, softPrestep } from './soft';
import { makeHooks, refreshHookCache } from './layers';
import { captureLoads, computeLoads, prepareLoads } from './jointLoad';
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
  softPrestep(s, dt); // -- SF: attachments, pressure leak --
  applyGrab(s);
  applySoftWalls(s, dt); // -- ZN-34: the spring walls of the world bounds
  // Components run after the built-in forces, bodies first, then joints, each owner in array order.
  s.host.prestep(dt);
}

function postStep(s: WorldState, dt: number): void {
  emulateSleep(s, dt);
  stepPending(s);
  s.host.poststep(dt);
  for (const r of s.order) {
    if (r.disabled || r.def.bodyType === 'static') continue;
    if (r.rb.translation().y < KILL_Y) {
      r.disabled = true;
      r.rb.setEnabled(false);
    }
  }
  // -- ZN: delayed respawns and spawn lifetimes, then the world bounds, then the zone state goes out to the page
  s.host.zones.tick();
  checkBounds(s);
  s.host.zones.publishIfDirty();
  for (const j of s.jointOrder) {
    if (j.broken || !j.joint) continue;
    if (j.def.type === 'spring') measureSpring(s, j);
    else if (j.def.type === 'hinge') measureJoint(j); // keeps the unwrapped angle continuous
  }
  computeLoads(s); // JT-10..12: joint load estimate and load-driven failure
}

/**
 * Advance the simulation by exactly one fixed step: the pre-step hooks run once, then the engine takes
 * `settings.substeps` equal steps (its integration `dt` is `engineDt`, see `applySettings`) so stiff
 * contacts and joints converge better without changing the fixed-step bookkeeping or the interpolation.
 */
export function stepOnce(s: WorldState): void {
  const dt = fixedDt(s);
  s.recorder.beforeStep(s); // -- TM: first snapshot, logged inputs of a replay / seek --
  preStep(s, dt);
  const n = substepCount(s);
  const tEnd = s.simTime + dt;
  const track = prepareLoads(s);
  for (let i = n; i > 0; i--) {
    applyDrag(s, dt / n);
    if (track && i === 1) captureLoads(s); // JT-B: before the coupling impulses, so they are part of the measured Δv
    stepCouplings(s, dt / n); // -- JT-A: coupling rows of the pulley / gear / rack / … joints --
    if (s.oneWayCount > 0) refreshHookCache(s); // JT-31: the hook may not read bodies while the engine steps
    s.world.step(s.eventQueue, s.oneWayCount > 0 ? (s.hooks ??= makeHooks(s)) : undefined);
    stepCouplings(s, dt / n, true); // -- JT-A: re-couple gear / belt / rack / screw velocities --
    collectEvents(s, tEnd);
  }
  s.queriesDirty = false; // the step rebuilt the engine's query structures
  s.simTime += dt;
  s.simSinceRead += dt;
  s.stepCount++;
  postStep(s, dt);
  s.recorder.afterStep(s); // -- TM: periodic snapshot, trajectory sample, replay checkpoint --
}

/**
 * Advance by wall-clock time (scaled), interpolating the remainder. Returns the number of
 * fixed steps taken. `budgetMs` bounds the work done in one call (the sim then falls behind
 * real time instead of freezing the worker).
 */
export function advance(s: WorldState, realDt: number, timeScale: number, budgetMs = 28): number {
  const dt = fixedDt(s);
  // -- TM: reverse playback replaces forward stepping; a replay stops at its last step --
  if (s.recorder.mode === 'rewind') return s.recorder.api.rewindAdvance(s, realDt);
  s.acc += Math.min(realDt, 0.25) * timeScale;
  const wanted = s.recorder.stepBudget(s, Math.floor(s.acc / dt));
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
  n = s.recorder.stepBudget(s, n); // -- TM --
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

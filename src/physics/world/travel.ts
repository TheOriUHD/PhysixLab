/**
 * Moving through time: seeking to any recorded step, the real-time rewind driver, and the determinism check.
 * Installed on a world by `installTimeline` (called from the `PhysicsWorld` constructor).
 */
import type { SimOp } from '../protocol';
import { stateHash } from './hash';
import { applyOp } from './ops';
import { restoreSnapshot, takeSnapshot } from './snapshot';
import type { WorldState } from './state';
import { fixedDt, stepOnce } from './stepping';

export function installTimeline(s: WorldState): void {
  s.recorder.api = {
    take: takeSnapshot,
    restore: restoreSnapshot,
    applyOp: (st: WorldState, op: SimOp) => applyOp(st, op),
    hash: stateHash,
    rewindAdvance,
  };
}

/**
 * Bring the world to `target` (a step between the oldest snapshot and the head of the timeline): restore the
 * newest snapshot at or before it, then re-step with the logged inputs. Returns the step reached.
 */
export function seekTo(s: WorldState, target: number): number {
  const r = s.recorder;
  if (r.ring.length === 0) return s.stepCount;
  const t = Math.round(Math.min(Math.max(target, r.first), Math.max(r.head, s.stepCount)));
  if (t === s.stepCount) return t;
  // Going forward with no snapshot in between needs no restore, only stepping.
  const forwardOnly = t > s.stepCount && !r.hasEntryBetween(s.stepCount, t);
  r.seeking = true;
  try {
    if (!forwardOnly) {
      const e = r.entryAtOrBefore(t);
      if (!e) return s.stepCount;
      restoreSnapshot(s, e.snap);
      if (e.grab) {
        const rec = s.bodies.get(e.grab.id);
        if (rec)
          s.grab = {
            rec,
            local: [...e.grab.local],
            target: [...e.grab.target],
            strength: e.grab.strength,
            spin: [...e.grab.spin],
          };
      }
    }
    while (s.stepCount < t) stepOnce(s);
  } finally {
    r.seeking = false;
  }
  s.events = [];
  s.acc = 0;
  for (const b of s.order) b.hasPrev = false;
  r.landed(s);
  return s.stepCount;
}

/** One frame of reverse playback: move `rewindRate`× real time backwards through the ring. */
function rewindAdvance(s: WorldState, realDt: number): number {
  const r = s.recorder;
  r.rewindPos -= (Math.min(realDt, 0.25) * r.rewindRate) / fixedDt(s);
  if (r.rewindPos < r.first) r.rewindPos = r.first;
  seekTo(s, Math.floor(r.rewindPos));
  s.rtf = 1;
  return 0;
}

export function startRewind(s: WorldState, rate: number): void {
  const r = s.recorder;
  r.mode = 'rewind';
  r.rewindRate = Math.min(8, Math.max(0.1, rate));
  r.rewindPos = s.stepCount;
}

export function stopRewind(s: WorldState): void {
  s.recorder.mode = 'live';
}

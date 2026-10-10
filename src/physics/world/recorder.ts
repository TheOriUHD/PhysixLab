/**
 * The simulation recorder (package TM): the data side of time travel.
 *
 *  - a bounded **ring** of full-state snapshots (`WorldSnapshot`: rigid bodies, joints with their break state, soft
 *    bodies, the RNG, and whatever the components save through `saveState`), taken every `interval` fixed steps. The
 *    interval adapts: it grows when taking snapshots would cost more than a fraction of the stepping itself, and the
 *    ring is thinned (every other snapshot dropped, interval doubled) when it outgrows its memory budget;
 *  - the **input log**: every op, key set and axis set that reached the world, stamped with the step it was applied
 *    before. Re-stepping a stretch of the past with its inputs (seeking, replays) reproduces it exactly;
 *  - optionally a **recording** (unbounded input log + base state) that exports as a replay file, and the **replay**
 *    state when such a file is being played back (`followLog`: logged inputs are applied, live ones ignored).
 *
 * This file is data and bookkeeping only; the behaviour that needs the stepper (seeking, rewinding, the determinism
 * check) is in `travel.ts`, which installs itself through `Recorder.api` — that keeps the module graph acyclic.
 */
import type { SimOp, WorldSnapshot } from '../protocol';
import type { WorldState } from './state';
import { TrackSampler } from './track';

export type InputEntry =
  | { step: number; kind: 'op'; op: SimOp }
  | { step: number; kind: 'keys'; keys: string[] }
  | { step: number; kind: 'axes'; axes: Record<string, number> };

export interface RingEntry {
  step: number;
  simTime: number;
  snap: WorldSnapshot;
  bytes: number;
  /** The mouse grab at that moment (the snapshot itself releases it): body id, grab point in body space, target. */
  grab: {
    id: string;
    local: [number, number, number];
    target: [number, number, number];
    strength: number;
    spin: [number, number, number];
  } | null;
}

export interface Recording {
  /** Null when the recording starts at step 0 of a freshly built world with nothing applied (the scene itself is the base). */
  base: WorldSnapshot | null;
  startStep: number;
  entries: InputEntry[];
  /** `[step, hash]` checkpoints (`hashEvery` steps apart) that let a replay prove it is faithful. */
  hashes: [number, string][];
}

export interface ReplayState {
  startStep: number;
  endStep: number;
  hashes: Map<number, string>;
  checked: number;
  /** First checkpoint whose hash differed, or null while everything matched. */
  firstBad: { step: number; expected: string; actual: string } | null;
}

/** What the recorder needs from the stepper and the snapshot code (installed by `travel.ts`). */
export interface RecorderApi {
  take(s: WorldState): WorldSnapshot;
  restore(s: WorldState, snap: WorldSnapshot): void;
  applyOp(s: WorldState, op: SimOp): void;
  hash(s: WorldState): string;
  rewindAdvance(s: WorldState, realDt: number): number;
}

/**
 * Ops that are queries, whole-world replacements or only change what is *reported* (event generation): never part of
 * the input log, and they do not end a branch or a play-through.
 */
const NOT_LOGGED = new Set<SimOp['op']>(['raycast', 'snapshot', 'restore', 'events']);
/** Ops a replay viewer still accepts from the page. */
const ALWAYS_ACCEPTED = new Set<SimOp['op']>(['raycast', 'snapshot', 'events']);

export const HASH_EVERY = 60;
const MIN_INTERVAL = 2;
const MAX_INTERVAL = 240;
const MAX_LOG = 400_000;

export class Recorder {
  enabled = true;
  /** Memory the ring may use, bytes. */
  budgetBytes = 96 * 1024 * 1024;
  maxEntries = 6000;
  /** Steps between snapshots right now: the larger of what time cost and memory allow. */
  interval = 6;
  private baseInterval = 6;
  private timeInterval = 6;
  private memInterval = 0;
  ring: RingEntry[] = [];
  bytes = 0;
  log: InputEntry[] = [];
  /** The furthest step of the current timeline. */
  head = 0;
  /** The world went back in time: the next live input or step starts a new branch (drops the old future). */
  branchPending = false;
  /** Re-stepping the past: due log entries are applied, nothing is captured. */
  seeking = false;
  /** >0 while inputs are being applied from the log (they must not be logged again). */
  applying = 0;
  /** Replay viewer: logged inputs drive the world and live ones are ignored. */
  followLog = false;
  /**
   * Playing forward through the recorded past (loop regions): logged inputs are applied, the page's live inputs are
   * ignored until one of them really changes, and no new snapshots are taken for steps that already have one.
   */
  playThrough = false;
  replay: ReplayState | null = null;
  /** Hashes of a determinism clone's future; the real run is checked against them while nothing is edited. */
  watch: { hashes: Map<number, string>; checked: number; firstBad: { step: number } | null } | null = null;
  recording: Recording | null = null;
  mode: 'live' | 'rewind' = 'live';
  rewindRate = 1;
  /** Fractional step the rewind has reached. */
  rewindPos = 0;
  snapMsEma = 0;
  /** Let the interval grow when snapshots get expensive (tests switch it off for fixed spacing). */
  adaptive = true;
  api!: RecorderApi;
  readonly track = new TrackSampler();
  private rebaseKeys = false;
  private rebaseAxes = false;
  private keysSig: string | null = null;
  private axesSig: string | null = null;
  private lastCapture = -1;

  get first(): number {
    return this.ring.length ? this.ring[0].step : 0;
  }

  // ---- hooks called by the stepper ---------------------------------------------------------

  beforeStep(s: WorldState): void {
    if (!this.enabled) return;
    if (this.playThrough && s.stepCount >= this.head) this.playThrough = false;
    if (!this.seeking && !this.followLog && !this.playThrough) this.branchIfNeeded(s);
    if (this.ring.length === 0 && !this.seeking) this.capture(s);
    if (this.followLog || this.seeking || this.playThrough) this.applyDue(s);
  }

  afterStep(s: WorldState): void {
    if (!this.enabled || this.seeking) return;
    const step = s.stepCount;
    if (this.playThrough && step < this.head) return; // the past is already recorded
    if (step > this.head) this.head = step;
    if (step - this.lastCapture >= this.interval && !this.ring.some((e) => e.step === step)) this.capture(s);
    this.track.sample(s);
    const w = this.watch;
    if (w) {
      const want = w.hashes.get(step);
      if (want !== undefined) {
        w.checked++;
        if (!w.firstBad && this.api.hash(s) !== want) w.firstBad = { step };
      }
    }
    if (step % HASH_EVERY === 0) {
      if (this.recording) this.recording.hashes.push([step, this.api.hash(s)]);
      const rp = this.replay;
      const want = rp?.hashes.get(step);
      if (rp && want !== undefined) {
        rp.checked++;
        if (!rp.firstBad) {
          const got = this.api.hash(s);
          if (got !== want) rp.firstBad = { step, expected: want, actual: got };
        }
      }
    }
  }

  /** In a replay, the number of steps the world may still take (otherwise `wanted`). */
  stepBudget(s: WorldState, wanted: number): number {
    return this.replay ? Math.max(0, Math.min(wanted, this.replay.endStep - s.stepCount)) : wanted;
  }

  /**
   * Called for every op before it is applied. Returns false when the world must ignore it (a replay viewer ignores
   * everything but queries); otherwise logs it.
   */
  onOp(s: WorldState, op: SimOp): boolean {
    if (this.applying > 0) return true;
    if (this.followLog) return ALWAYS_ACCEPTED.has(op.op);
    if (op.op === 'restore') {
      this.reset();
      return true;
    }
    if (!this.enabled || NOT_LOGGED.has(op.op)) return true;
    if (this.playThrough) {
      this.playThrough = false;
      this.branchPending = true;
    }
    this.branchIfNeeded(s);
    this.watch = null; // an edit makes the clone's future differ legitimately
    this.note(s, { step: s.stepCount, kind: 'op', op });
    return true;
  }

  /**
   * Should the page's `keys` / `axes` replace the world's inputs? Not in a replay, and not while playing through the
   * recorded past — unless the player really changed an input, which ends the playback and starts a new branch.
   */
  acceptKeys(s: WorldState, keys: readonly string[]): boolean {
    if (this.followLog) return false;
    if (!this.playThrough) return true;
    const ksig = [...keys].sort().join('|');
    if (this.rebaseKeys) {
      // first sight of the page's keys after the world moved in time: that is the baseline, not an edit
      this.rebaseKeys = false;
      this.keysSig = ksig;
      return false;
    }
    return ksig !== this.keysSig && this.takeOver(s);
  }

  acceptAxes(s: WorldState, axes: Record<string, number>): boolean {
    if (this.followLog) return false;
    if (!this.playThrough) return true;
    const asig = JSON.stringify(axes);
    if (this.rebaseAxes) {
      this.rebaseAxes = false;
      this.axesSig = asig;
      return false;
    }
    return asig !== this.axesSig && this.takeOver(s);
  }

  /** The player changed an input while the recorded past was playing: it ends here and a new branch begins. */
  private takeOver(s: WorldState): boolean {
    this.playThrough = false;
    this.branchPending = true;
    this.branchIfNeeded(s);
    return true;
  }

  /** Keys / axes as supplied with a tick. Only changes are logged. */
  onInputs(s: WorldState, keys: Iterable<string>, axes: Record<string, number>): void {
    if (!this.enabled || this.followLog || this.applying > 0 || this.playThrough) return;
    const k = [...keys].sort();
    const ksig = k.join('|');
    const asig = JSON.stringify(axes);
    if (this.rebaseKeys || this.rebaseAxes) {
      // The world just moved in time: what the page supplies now is the new baseline, not an edit.
      this.rebaseKeys = false;
      this.rebaseAxes = false;
      this.keysSig = ksig;
      this.axesSig = asig;
      return;
    }
    if (ksig === this.keysSig && asig === this.axesSig) return;
    this.watch = null;
    this.branchIfNeeded(s);
    if (ksig !== this.keysSig) this.note(s, { step: s.stepCount, kind: 'keys', keys: k });
    if (asig !== this.axesSig) this.note(s, { step: s.stepCount, kind: 'axes', axes: { ...axes } });
    this.keysSig = ksig;
    this.axesSig = asig;
  }

  private note(s: WorldState, e: InputEntry): void {
    void s;
    this.log.push(e);
    this.recording?.entries.push(e);
    if (this.log.length > MAX_LOG) this.dropOldest();
  }

  /** The log grew too long: forget the oldest snapshots (and the log before the new oldest one). */
  private dropOldest(): void {
    while (this.ring.length > 2 && this.log.length > MAX_LOG * 0.8) {
      this.bytes -= this.ring[0].bytes;
      this.ring.shift();
      const cut = this.ring[0].step;
      let i = 0;
      while (i < this.log.length && this.log[i].step < cut) i++;
      if (i > 0) this.log.splice(0, i);
    }
  }

  // ---- snapshots ----------------------------------------------------------------------------

  capture(s: WorldState): void {
    const t0 = performance.now();
    const snap = this.api.take(s);
    const ms = performance.now() - t0;
    this.snapMsEma = this.snapMsEma === 0 ? ms : this.snapMsEma * 0.8 + ms * 0.2;
    const bytes = snap.rapier.byteLength + 1500 * snap.bodies.length + 400 * snap.joints.length + 4096;
    const g = s.grab;
    this.ring.push({
      step: s.stepCount,
      simTime: s.simTime,
      snap,
      bytes,
      grab: g
        ? {
            id: g.rec.id,
            local: [...g.local] as [number, number, number],
            target: [...g.target] as [number, number, number],
            strength: g.strength,
            spin: [...g.spin] as [number, number, number],
          }
        : null,
    });
    this.bytes += bytes;
    this.lastCapture = s.stepCount;
    this.adapt(s);
    while ((this.bytes > this.budgetBytes || this.ring.length > this.maxEntries) && this.ring.length > 3) this.thin();
  }

  /**
   * Snapshots cost far more than a step, so what matters is their share of the wall-clock time at real-time speed:
   * keep it near 6% (`snapMs × steps per second / interval`). Memory pressure raises the floor separately (`thin`).
   */
  private adapt(s: WorldState): void {
    if (!this.adaptive) return;
    const hz = s.settings.physicsHz;
    this.timeInterval = Math.min(MAX_INTERVAL, Math.max(this.baseInterval, Math.ceil((this.snapMsEma * hz) / 60)));
    this.interval = Math.max(this.timeInterval, this.memInterval);
  }

  /** Drop every other snapshot (keeping the first and the newest) and double the interval. */
  private thin(): void {
    const keep: RingEntry[] = [];
    this.bytes = 0;
    for (let i = 0; i < this.ring.length; i++) {
      if (i === 0 || i === this.ring.length - 1 || i % 2 === 0) {
        keep.push(this.ring[i]);
        this.bytes += this.ring[i].bytes;
      }
    }
    this.ring = keep;
    this.memInterval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, this.interval * 2));
    this.interval = Math.max(this.timeInterval, this.memInterval);
  }

  /** The newest snapshot at or before `step`, or null. */
  entryAtOrBefore(step: number): RingEntry | null {
    let lo = 0;
    let hi = this.ring.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].step <= step) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best < 0 ? null : this.ring[best];
  }

  /** Is there a snapshot with a step in (`after`, `upTo`]? */
  hasEntryBetween(after: number, upTo: number): boolean {
    const e = this.entryAtOrBefore(upTo);
    return !!e && e.step > after;
  }

  // ---- branching ----------------------------------------------------------------------------

  private branchIfNeeded(s: WorldState): void {
    if (!this.branchPending) return;
    this.branchPending = false;
    this.truncateAfter(s.stepCount);
    // the new branch starts with the inputs in force right now
    this.note(s, { step: s.stepCount, kind: 'keys', keys: [...s.keys].sort() });
    this.note(s, { step: s.stepCount, kind: 'axes', axes: { ...s.axes } });
    this.keysSig = [...s.keys].sort().join('|');
    this.axesSig = JSON.stringify(s.axes);
  }

  /** Forget everything after `step`: the timeline continues from here. */
  truncateAfter(step: number): void {
    const kept = this.ring.filter((e) => e.step <= step);
    this.ring = kept;
    this.bytes = kept.reduce((n, e) => n + e.bytes, 0);
    let i = this.log.length;
    while (i > 0 && this.log[i - 1].step >= step) i--;
    this.log.length = i;
    this.head = step;
    this.keysSig = null;
    this.axesSig = null;
    this.lastCapture = kept.length ? kept[kept.length - 1].step : -1;
    this.track.truncateAfter(step);
    const rec = this.recording;
    if (rec) {
      if (step < rec.startStep) this.recording = null;
      else {
        let j = rec.entries.length;
        while (j > 0 && rec.entries[j - 1].step >= step) j--;
        rec.entries.length = j;
        rec.hashes = rec.hashes.filter(([st]) => st <= step);
      }
    }
  }

  /** Called after the world was moved to another point of the timeline. */
  landed(s: WorldState): void {
    this.watch = null;
    this.branchPending = !this.followLog && s.stepCount < this.head;
    this.rebaseKeys = true;
    this.rebaseAxes = true;
  }

  /** Forget the whole history (the world was replaced by something the log does not describe). */
  reset(): void {
    this.ring = [];
    this.bytes = 0;
    this.log = [];
    this.head = 0;
    this.branchPending = false;
    this.keysSig = null;
    this.axesSig = null;
    this.lastCapture = -1;
    this.recording = null;
    this.watch = null;
    this.track.clear();
  }

  // ---- re-applying logged inputs ----------------------------------------------------------

  /** Apply the log entries stamped with the current step (they were applied just before the step that follows). */
  private applyDue(s: WorldState): void {
    const log = this.log;
    let lo = 0;
    let hi = log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (log[mid].step < s.stepCount) lo = mid + 1;
      else hi = mid;
    }
    this.applying++;
    try {
      for (let i = lo; i < log.length && log[i].step === s.stepCount; i++) {
        const e = log[i];
        if (e.kind === 'op') this.api.applyOp(s, e.op);
        else if (e.kind === 'keys') s.keys = new Set(e.keys);
        else s.axes = { ...e.axes };
      }
    } finally {
      this.applying--;
    }
  }

  // ---- recording / replay -------------------------------------------------------------------

  startRecording(s: WorldState): void {
    const fresh = s.stepCount === 0 && this.log.length === 0;
    const base = fresh ? null : this.api.take(s);
    this.recording = { base, startStep: s.stepCount, entries: [], hashes: [] };
    // The live world continues from the very state a replay will start from, so both run through the same restore
    // (restoring is deterministic, but not bit-identical to carrying on for soft bodies — see docs/LIMITATIONS.md).
    if (base) this.api.restore(s, base);
    // The inputs in force right now are part of the recording's start state.
    this.recording.entries.push({ step: s.stepCount, kind: 'keys', keys: [...s.keys].sort() });
    this.recording.entries.push({ step: s.stepCount, kind: 'axes', axes: { ...s.axes } });
  }

  /** Install a replay: the log is the recorded one and the world follows it. Call after restoring the base state. */
  beginReplay(s: WorldState, entries: InputEntry[], endStep: number, hashes: [number, string][]): void {
    this.reset();
    this.log = entries.map((e) => ({ ...e }));
    this.followLog = true;
    this.head = s.stepCount;
    this.replay = {
      startStep: s.stepCount,
      endStep,
      hashes: new Map(hashes),
      checked: 0,
      firstBad: null,
    };
  }

  endReplay(): void {
    this.followLog = false;
    this.replay = null;
    this.reset();
  }
}

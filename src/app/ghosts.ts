/**
 * Runs, ghosts and run comparison (TM-5).
 *
 * The worker keeps the trajectory track of every finished run for a while (`world/track.ts`); this class fetches them
 * when a new run starts, lets the user pick which run is ghost A and which is ghost B (translucent bodies overlaid on
 * the live run), keeps a "personal best" in browser storage per scene, and computes the distance between two runs for
 * the comparison chart.
 */
import { Emitter } from '../core/events';
import { GhostSet } from '../render/ghostViews';
import type { SimEvent } from '../physics/protocol';
import type { TimelineReply, TrackData } from '../physics/timelineTypes';
import type { App } from './app';
import { base64ToBytes, bytesToBase64 } from './replayFile';
import type { TimeTravel } from './timeTravel';
import { compareTracks, thinTrack, type Comparison } from './trackMath';

export interface RunEntry {
  key: string;
  name: string;
  track: TrackData;
  origin: 'previous' | 'live' | 'best' | 'imported';
  /** Race time in seconds, when the run ended with a finish (used to keep the best). */
  time?: number;
}

const BEST_PREFIX = 'physicslab.tm.best.';
const BEST_MAX_FLOATS = 400_000; // ≈1.6 MB of Float32, ≈2.1 MB as base64: still fits localStorage

const keyOf = (t: TrackData): string =>
  `${t.name}|${t.count}|${t.duration.toFixed(3)}|${t.data[t.data.length - 3] ?? 0}`;

interface Events extends Record<string, unknown> {
  change: undefined;
}

export class RunGhosts extends Emitter<Events> {
  runs: RunEntry[] = [];
  a: string | null = null;
  b: string | null = null;
  show = true;
  comparison: Comparison | null = null;
  private setA: GhostSet | null = null;
  private setB: GhostSet | null = null;
  private fetching = 0;
  private pendingLive = false;
  private userPickedA = false;

  constructor(
    private app: App,
    private tt: TimeTravel,
  ) {
    super();
    this.loadBest();
    app.sim.on('mode', (m) => {
      if (m === 'edit') this.clearSets();
    });
  }

  private get sceneKey(): string {
    return BEST_PREFIX + (this.app.store.name || 'scene');
  }

  entry(key: string | null): RunEntry | undefined {
    return key ? this.runs.find((r) => r.key === key) : undefined;
  }

  // ---- collecting runs ----------------------------------------------------------------------------

  /** A new world was built: ask the worker for the runs it still remembers. */
  onRunStart(): void {
    this.app.sim.client.sendCustom('timeline', { cmd: 'runs' });
  }

  onReply(r: TimelineReply): void {
    if (r.kind === 'runs') {
      this.fetching = 0;
      r.runs.forEach((info, i) => {
        const known = this.runs.some(
          (x) => x.origin === 'previous' && x.name === info.name && x.track.count === info.count,
        );
        if (known) return;
        this.fetching++;
        this.app.sim.client.sendCustom('timeline', { cmd: 'trackGet', run: i });
      });
    } else if (r.kind === 'track' && r.track) {
      const track = r.track;
      if (r.run === 'live') {
        this.runs = this.runs.filter((x) => x.origin !== 'live');
        this.runs.push({ key: 'live', name: 'Current run', track, origin: 'live' });
        this.pendingLive = false;
      } else {
        const key = keyOf(track);
        if (!this.runs.some((x) => x.key === key)) this.runs.push({ key, name: track.name, track, origin: 'previous' });
        // the previous run is the default ghost, unless the user chose one
        if (this.tt.options.autoGhost && !this.userPickedA) {
          const prev = this.runs.filter((x) => x.origin === 'previous').slice(-1)[0];
          if (prev) this.a = prev.key;
        }
      }
      this.rebuildSets();
      this.recompute();
      this.emit('change', undefined);
    }
  }

  /** Ask for the track of the run in progress (for A/B comparison). */
  fetchLive(): void {
    if (!this.tt.active) return;
    this.pendingLive = true;
    this.app.sim.client.sendCustom('timeline', { cmd: 'trackGet', run: 'live' });
  }

  clearRuns(): void {
    this.runs = this.runs.filter((r) => r.origin === 'best');
    this.a = this.b = null;
    this.userPickedA = false;
    this.comparison = null;
    this.app.sim.client.sendCustom('timeline', { cmd: 'clearRuns' });
    this.rebuildSets();
    this.emit('change', undefined);
  }

  // ---- choosing --------------------------------------------------------------------------------------

  pick(slot: 'a' | 'b', key: string | null): void {
    if (slot === 'a') {
      this.a = key;
      this.userPickedA = true;
    } else this.b = key;
    this.rebuildSets();
    this.recompute();
    this.emit('change', undefined);
  }

  setShow(on: boolean): void {
    this.show = on;
    this.emit('change', undefined);
  }

  // ---- personal best -----------------------------------------------------------------------------------

  /** Keep a run as this scene's personal best (stored in the browser). */
  makeBest(key: string): boolean {
    const run = this.entry(key);
    if (!run) return false;
    const small = thinTrack(run.track, BEST_MAX_FLOATS);
    try {
      const payload = {
        name: 'Personal best',
        ids: small.ids,
        every: small.every,
        hz: small.hz,
        first: small.first,
        count: small.count,
        duration: small.duration,
        time: run.time ?? null,
        data: bytesToBase64(new Uint8Array(small.data.buffer, small.data.byteOffset, small.data.byteLength)),
      };
      localStorage.setItem(this.sceneKey, JSON.stringify(payload));
    } catch {
      this.app.toast('The browser has no room to keep this run as the personal best.', 'warn');
      return false;
    }
    this.runs = this.runs.filter((r) => r.origin !== 'best');
    this.runs.push({
      key: 'best',
      name: 'Personal best',
      track: { ...small, name: 'Personal best' },
      origin: 'best',
      time: run.time,
    });
    this.app.toast('Saved as the personal best ghost', 'success');
    this.emit('change', undefined);
    return true;
  }

  loadBest(): void {
    try {
      const raw = localStorage.getItem(this.sceneKey);
      if (!raw) return;
      const p = JSON.parse(raw) as {
        ids: string[];
        every: number;
        hz: number;
        first: number;
        count: number;
        duration: number;
        time: number | null;
        data: string;
      };
      const bytes = base64ToBytes(p.data);
      const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      if (data.length !== p.count * p.ids.length * 7) return;
      this.runs.push({
        key: 'best',
        name: 'Personal best',
        origin: 'best',
        time: p.time ?? undefined,
        track: {
          name: 'Personal best',
          ids: p.ids,
          every: p.every,
          hz: p.hz,
          first: p.first,
          count: p.count,
          data: new Float32Array(data),
          duration: p.duration,
        },
      });
    } catch {
      /* a damaged entry is ignored */
    }
  }

  /** A finish / lap / goal event: when it reports a race time that beats the stored best, the run becomes the new best. */
  onGoal(ev: SimEvent): void {
    if (ev.kind !== 'component' || !/^finish/i.test(ev.name)) return;
    const d = ev.data as { time?: unknown } | undefined;
    const time = typeof d?.time === 'number' ? d.time : this.tt.simTime;
    const best = this.entry('best');
    if (best?.time !== undefined && best.time <= time) return;
    this.fetchLive();
    const off = this.on('change', () => {
      const live = this.entry('live');
      if (!live) return;
      live.time = time;
      off();
      this.makeBest('live');
    });
  }

  // ---- ghosts in the viewport ----------------------------------------------------------------------------

  private defOf = (id: string) => this.app.store.body(id) ?? this.app.sim.ephemeral.get(id);

  private rebuildSets(): void {
    const scene = this.app.viewport.scene;
    const make = (cur: GhostSet | null, key: string | null, tint: string): GhostSet | null => {
      const run = this.entry(key);
      if (!run) {
        cur?.dispose();
        return null;
      }
      const set = cur ?? new GhostSet(scene, tint);
      if (set.loaded !== run.track) set.setTrack(run.track, this.defOf);
      return set;
    };
    this.setA = make(this.setA, this.a, '#3ddcff');
    this.setB = make(this.setB, this.b, '#ffb347');
  }

  private clearSets(): void {
    this.setA?.dispose();
    this.setB?.dispose();
    this.setA = this.setB = null;
  }

  /** Per frame: pose the ghosts at the live run's time. */
  update(active: boolean): void {
    if (!this.setA && !this.setB) return;
    const show = active && this.show;
    const t = this.tt.simTime;
    for (const set of [this.setA, this.setB]) {
      if (!set?.loaded) continue;
      set.update(t - set.loaded.first / set.loaded.hz, show);
    }
  }

  // ---- comparison -------------------------------------------------------------------------------------------

  recompute(): void {
    const a = this.entry(this.a)?.track;
    const b = this.entry(this.b)?.track;
    this.comparison = a && b ? compareTracks(a, b) : null;
  }

  /** Compare the run in progress with ghost A (fetches the live track first). */
  compareWithLive(): void {
    this.b = 'live';
    this.fetchLive();
    this.emit('change', undefined);
  }

  get awaitingLive(): boolean {
    return this.pendingLive;
  }
}

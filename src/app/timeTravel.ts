/**
 * TimeTravel (package TM) — the page side of the simulation recorder: where the run is on the timeline, scrubbing,
 * rewinding, stepping both ways, loop regions, bookmarks and event markers, replay recording / export / playback and
 * the determinism check. The recorder itself (the snapshot ring, the input log) lives in the physics worker and is
 * driven through the `timeline` custom channel (`src/physics/timelineChannel.ts`).
 *
 * One instance per `App` (`installTimeTravel`, called from `main.ts`); panels and commands reach it with
 * `timeTravelFor(app)`.
 */
import { Emitter } from '../core/events';
import { LIMITS } from '../model/limits';
import type { SceneDocument } from '../model/types';
import type { SimEvent } from '../physics/protocol';
import type {
  DeterminismReport,
  ReplayPayload,
  TimelineCmd,
  TimelineReply,
  TimelineStatus,
} from '../physics/timelineTypes';
import type { App } from './app';
import {
  REPLAY_EXTENSION,
  decodeReplay,
  encodeReplay,
  replayFromHash,
  replayShareLink,
  type Bookmark,
  type ReplayFile,
} from './replayFile';
import { RunGhosts } from './ghosts';

export type MarkerKind = 'impact' | 'break' | 'goal' | 'event';

export interface Marker {
  step: number;
  kind: MarkerKind;
  label: string;
}

export interface BookmarkItem extends Bookmark {
  id: number;
}

interface TTEvents extends Record<string, unknown> {
  /** Anything the panels show changed (status, markers, bookmarks, recording …). */
  change: undefined;
  determinism: DeterminismReport;
}

const WEIGHTY_IMPACT = 3; // N·s: contacts weaker than this are not marked
const MAX_MARKERS = 1500;
const OPT_KEY = 'physicslab.timeTravel';

interface Options {
  markImpacts: boolean;
  autoSlowmo: boolean;
  /** Impulse (N·s) that triggers the automatic slow motion. */
  slowmoImpulse: number;
  autoGhost: boolean;
}

const DEFAULT_OPTIONS: Options = { markImpacts: true, autoSlowmo: false, slowmoImpulse: 8, autoGhost: true };

const GOAL_NAMES = /^(finish|finished|lap|goal|checkpoint|score|win|won|complete|completed|reached)/i;

const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
};

export class TimeTravel extends Emitter<TTEvents> {
  status: TimelineStatus | null = null;
  markers: Marker[] = [];
  bookmarks: BookmarkItem[] = [];
  loop: { a: number; b: number } | null = null;
  loopOn = false;
  rewinding = false;
  rewindRate = 1;
  options: Options = { ...DEFAULT_OPTIONS };
  determinism: DeterminismReport | null = null;
  determinismRunning = false;
  /** The replay file that is being viewed (null when the simulation is live). */
  replayName: string | null = null;
  lastError: string | null = null;
  readonly ghosts: RunGhosts;

  private nextBookmark = 1;
  private lastPoll = 0;
  private pollPending = false;
  private pendingSeek: number | null = null;
  private scrubbing = false;
  private resumeAfterScrub = false;
  private rewindWasPaused = false;
  private slowUntil = 0;
  private awaiting: 'export' | 'link' | null = null;
  private sceneDoc: SceneDocument | null = null;
  private lastSimStep = 0;
  private playThroughSent = false;

  constructor(private app: App) {
    super();
    try {
      const raw = localStorage.getItem(OPT_KEY);
      if (raw) this.options = { ...DEFAULT_OPTIONS, ...(JSON.parse(raw) as Partial<Options>) };
    } catch {
      /* storage unavailable: defaults */
    }
    this.ghosts = new RunGhosts(app, this);
    app.sim.client.on('custom', (m) => {
      if (m.channel === 'timeline') this.onReply(m.data as TimelineReply);
    });
    app.sim.client.on('event', (ev) => this.onEvent(ev));
    app.sim.on('mode', (m) => this.onMode(m));
    app.sim.on('layout', () => {
      // a new world (or none): the timeline starts over
      if (!app.sim.active) this.resetRun();
    });
    app.on('frame', ({ dt }) => this.onFrame(dt));
    this.installKeys();
  }

  // ---- state ---------------------------------------------------------------------------------

  get active(): boolean {
    return this.app.sim.active && this.app.sim.client.active;
  }
  get hz(): number {
    return this.status?.hz ?? this.app.store.settings.physicsHz;
  }
  /** The step the simulation is at right now (updated every frame, so it is frame-accurate). */
  get step(): number {
    return this.app.sim.client.stats?.stepCount ?? this.status?.step ?? 0;
  }
  get simTime(): number {
    return this.app.sim.client.stats?.simTime ?? 0;
  }
  get head(): number {
    return Math.max(this.status?.head ?? 0, this.step);
  }
  get first(): number {
    return this.status?.first ?? 0;
  }
  get recording(): boolean {
    return !!this.status?.recording;
  }
  get replaying(): boolean {
    return !!this.status?.replay;
  }
  /** True when the simulation is somewhere in the recorded past. */
  get inPast(): boolean {
    return this.step < this.head;
  }

  setOptions(patch: Partial<Options>): void {
    this.options = { ...this.options, ...patch };
    try {
      localStorage.setItem(OPT_KEY, JSON.stringify(this.options));
    } catch {
      /* ignore */
    }
    if (patch.markImpacts !== undefined) this.applyEventConfig();
    this.emit('change', undefined);
  }

  private send(cmd: TimelineCmd): void {
    this.app.sim.client.sendCustom('timeline', cmd);
  }

  private resetRun(): void {
    this.status = null;
    this.markers = [];
    this.loopOn = false;
    this.rewinding = false;
    this.pendingSeek = null;
    this.scrubbing = false;
    this.playThroughSent = false;
    this.replayName = null;
    this.determinism = null;
    this.determinismRunning = false;
    this.restoreSpeed();
    this.emit('change', undefined);
  }

  private onMode(m: 'edit' | 'paused' | 'running'): void {
    if (m === 'edit') {
      this.resetRun();
      return;
    }
    if (this.app.sim.client.active) {
      this.applyEventConfig();
      this.poll(true);
      this.ghosts.onRunStart();
    }
    this.emit('change', undefined);
  }

  private applyEventConfig(): void {
    if (!this.active) return;
    if (this.options.markImpacts || this.options.autoSlowmo) this.app.sim.client.configureEvents({ contacts: true });
  }

  // ---- polling and replies ----------------------------------------------------------------------

  private poll(force = false): void {
    if (!this.active) return;
    const now = performance.now();
    const every = this.rewinding || this.scrubbing ? 50 : 140;
    if (!force && (now - this.lastPoll < every || (this.pollPending && now - this.lastPoll < 600))) return;
    this.lastPoll = now;
    this.pollPending = true;
    this.send({ cmd: 'status' });
  }

  private onReply(r: TimelineReply): void {
    switch (r.kind) {
      case 'status': {
        this.pollPending = false;
        const prevHead = this.status?.head ?? 0;
        this.status = r;
        // A new branch: markers of the discarded future go with it.
        if (r.head < prevHead || r.head < this.markers[this.markers.length - 1]?.step) {
          this.markers = this.markers.filter((m) => m.step <= r.head);
        }
        if (!r.playThrough) this.playThroughSent = false;
        if (this.rewinding && r.step <= r.first) this.rewindStop();
        this.emit('change', undefined);
        break;
      }
      case 'determinism':
        this.determinismRunning = false;
        this.determinism = r;
        this.emit('determinism', r);
        this.emit('change', undefined);
        break;
      case 'recording':
        void this.finishExport(r.payload);
        break;
      case 'track':
      case 'runs':
        this.ghosts.onReply(r);
        break;
      case 'error':
        this.lastError = r.message;
        this.determinismRunning = false;
        this.app.toast(r.message, 'warn');
        this.emit('change', undefined);
        break;
    }
  }

  // ---- per-frame --------------------------------------------------------------------------------

  private onFrame(dt: number): void {
    if (!this.active) {
      this.ghosts.update(false);
      return;
    }
    const sim = this.app.sim;
    // coalesce scrubbing to one seek per frame
    if (this.pendingSeek !== null) {
      this.send({ cmd: 'seek', step: this.pendingSeek });
      // With a loop on, the run goes on through the recorded past from wherever it was put (set before play starts)
      if (this.loopOn) this.send({ cmd: 'playThrough', on: true });
      this.pendingSeek = null;
      this.poll(true);
    }
    // loop region
    if (this.loopOn && this.loop && sim.mode === 'running' && !this.rewinding) {
      const step = this.step;
      if (!this.playThroughSent && step < this.head) {
        this.send({ cmd: 'playThrough', on: true });
        this.playThroughSent = true;
      }
      if (step >= this.loop.b) {
        this.send({ cmd: 'seek', step: this.loop.a });
        this.send({ cmd: 'playThrough', on: true });
        this.playThroughSent = true;
      }
    }
    // ephemeral bodies (projectiles …) exist only between their creation and the moment the world went back before it
    const client = sim.client;
    if (this.step !== this.lastSimStep || this.rewinding) {
      for (const id of sim.ephemeral.keys()) {
        const view = this.app.bodies.get(id);
        if (view) view.mesh.visible = client.bodyIndex.has(id);
      }
      this.lastSimStep = this.step;
    }
    // automatic slow motion after a hard impact
    if (this.slowUntil > 0 && performance.now() > this.slowUntil) this.restoreSpeed();
    this.poll();
    this.ghosts.update(true);
    void dt;
  }

  private restoreSpeed(): void {
    if (this.slowUntil === 0) return;
    this.slowUntil = 0;
    this.app.sim.timeScale = this.app.prefs.value.timeScale;
  }

  private onEvent(ev: SimEvent): void {
    if (!this.active) return;
    const hz = this.hz;
    const step = Math.round(ev.kind === 'jointBroken' ? this.step : ev.t * hz);
    let marker: Marker | null = null;
    if (ev.kind === 'jointBroken') {
      const j = this.app.store.joint(ev.id);
      marker = { step, kind: 'break', label: `${j?.name ?? 'Joint'} broke (${Math.round(ev.force)} N)` };
    } else if (ev.kind === 'contact') {
      if (this.options.autoSlowmo && ev.impulse >= this.options.slowmoImpulse && this.slowUntil === 0) {
        this.slowUntil = performance.now() + 900;
        this.app.sim.timeScale = Math.min(this.app.prefs.value.timeScale, 0.25);
      }
      if (this.options.markImpacts && ev.impulse >= WEIGHTY_IMPACT) {
        const a = this.nameOf(ev.a);
        const b = this.nameOf(ev.b);
        marker = { step, kind: 'impact', label: `${a} hit ${b} (${ev.impulse.toFixed(1)} N·s)` };
      }
    } else if (ev.kind === 'component') {
      const goal = GOAL_NAMES.test(ev.name);
      marker = { step, kind: goal ? 'goal' : 'event', label: `${this.nameOf(ev.owner)}: ${ev.name}` };
      if (goal) this.ghosts.onGoal(ev);
    }
    if (!marker) return;
    const last = this.markers[this.markers.length - 1];
    if (last && last.step === marker.step && last.label === marker.label) return;
    this.markers.push(marker);
    if (this.markers.length > MAX_MARKERS) this.markers.splice(0, this.markers.length - MAX_MARKERS);
    this.emit('change', undefined);
  }

  private nameOf(id: string): string {
    if (id === '$ground') return 'ground';
    return this.app.store.get(id)?.name ?? this.app.sim.ephemeral.get(id)?.name ?? 'object';
  }

  // ---- moving through time ----------------------------------------------------------------------

  /** Go to `step` (clamped to the recorded range). Pauses a running simulation. */
  seek(step: number): void {
    if (!this.active) return;
    if (this.app.sim.mode === 'running' && !this.scrubbing) this.app.sim.pause();
    if (this.rewinding) this.rewindStop();
    this.pendingSeek = Math.round(Math.min(Math.max(step, this.first), this.head));
  }

  /** Dragging the scrubber: pauses while the pointer is down and resumes afterwards if it was running. */
  scrubStart(): void {
    if (!this.active) return;
    this.scrubbing = true;
    this.resumeAfterScrub = this.app.sim.mode === 'running';
    if (this.resumeAfterScrub) this.app.sim.pause();
  }
  scrubTo(step: number): void {
    if (!this.active) return;
    this.pendingSeek = Math.round(Math.min(Math.max(step, this.first), this.head));
  }
  scrubEnd(): void {
    this.scrubbing = false;
    if (this.resumeAfterScrub) {
      this.resumeAfterScrub = false;
      this.app.sim.play();
    }
  }

  stepBack(): void {
    if (!this.active) return;
    if (this.app.sim.mode === 'running') this.app.sim.pause();
    this.pendingSeek = Math.max(this.first, this.step - 1);
  }

  /** One frame forward: through the recorded future if there is one, otherwise a new simulated step. */
  stepForward(): void {
    if (!this.active) {
      this.app.sim.step(1);
      return;
    }
    if (this.app.sim.mode === 'running') this.app.sim.pause();
    if (this.step < this.head) this.pendingSeek = this.step + 1;
    else this.app.sim.step(1);
  }

  toStart(): void {
    this.seek(this.first);
  }
  toHead(): void {
    this.seek(this.head);
  }

  // ---- rewind ------------------------------------------------------------------------------------

  rewindStart(rate = this.rewindRate): void {
    if (!this.active || this.rewinding || this.replaying) return;
    this.rewinding = true;
    this.rewindRate = rate;
    this.rewindWasPaused = this.app.sim.mode === 'paused';
    this.send({ cmd: 'rewind', on: true, rate });
    if (this.app.sim.mode !== 'running') this.app.sim.play();
    this.emit('change', undefined);
  }

  setRewindRate(rate: number): void {
    this.rewindRate = rate;
    if (this.rewinding) this.send({ cmd: 'rewind', on: true, rate });
    this.emit('change', undefined);
  }

  /** Let go: the simulation carries on from where the rewind stopped (a new branch), or stays paused if it was. */
  rewindStop(): void {
    if (!this.rewinding) return;
    this.rewinding = false;
    this.send({ cmd: 'rewind', on: false });
    if (this.rewindWasPaused || (this.status && this.status.step <= this.status.first)) this.app.sim.pause();
    this.poll(true);
    this.emit('change', undefined);
  }

  private installKeys(): void {
    // Hold Backspace during a run to rewind. (R is the rotate tool.)
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Backspace' || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || !this.active) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) this.rewindStart();
      },
      true,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (e.code === 'Backspace' && this.rewinding) this.rewindStop();
      },
      true,
    );
    window.addEventListener('blur', () => this.rewindStop());
  }

  // ---- loop and bookmarks ------------------------------------------------------------------------

  setLoopPoint(which: 'a' | 'b', step = this.step): void {
    const cur = this.loop ?? { a: this.first, b: this.head };
    const next = { ...cur, [which]: step };
    if (next.a > next.b) [next.a, next.b] = [next.b, next.a];
    this.loop = next;
    this.emit('change', undefined);
  }

  clearLoop(): void {
    this.loop = null;
    this.loopOn = false;
    this.send({ cmd: 'playThrough', on: false });
    this.emit('change', undefined);
  }

  toggleLoop(): void {
    if (!this.loop) this.loop = { a: this.first, b: Math.max(this.first + 1, this.head) };
    this.loopOn = !this.loopOn;
    // Armed now, not when play is pressed: the first step after play must already know it is replaying the past.
    this.send({ cmd: 'playThrough', on: this.loopOn });
    this.emit('change', undefined);
  }

  addBookmark(name?: string, step = this.step): BookmarkItem {
    const b: BookmarkItem = { id: this.nextBookmark++, step, name: name ?? `Bookmark ${this.bookmarks.length + 1}` };
    this.bookmarks.push(b);
    this.bookmarks.sort((x, y) => x.step - y.step);
    this.emit('change', undefined);
    return b;
  }
  renameBookmark(id: number, name: string): void {
    const b = this.bookmarks.find((x) => x.id === id);
    if (b) b.name = name.trim().slice(0, LIMITS.maxNameLength) || b.name;
    this.emit('change', undefined);
  }
  removeBookmark(id: number): void {
    this.bookmarks = this.bookmarks.filter((x) => x.id !== id);
    this.emit('change', undefined);
  }
  jumpToBookmark(id: number): void {
    const b = this.bookmarks.find((x) => x.id === id);
    if (b) this.seek(b.step);
  }

  // ---- recording and replays ---------------------------------------------------------------------

  startRecording(): void {
    if (!this.active) {
      this.app.sim.play();
    }
    this.sceneDoc = this.app.sim.builtDoc;
    this.send({ cmd: 'record', on: true });
    this.poll(true);
  }

  cancelRecording(): void {
    this.send({ cmd: 'record', on: false });
    this.poll(true);
  }

  /** Stop recording and save the replay as a file. */
  exportReplay(): void {
    this.awaiting = 'export';
    this.send({ cmd: 'recordGet', stop: true });
  }

  /** Stop recording and copy a link that replays the run. */
  copyReplayLink(): void {
    this.awaiting = 'link';
    this.send({ cmd: 'recordGet', stop: true });
  }

  private async finishExport(payload: ReplayPayload): Promise<void> {
    const mode = this.awaiting;
    this.awaiting = null;
    const scene = this.sceneDoc ?? this.app.store.toDocument();
    const file: ReplayFile = {
      name: scene.name,
      createdAt: Date.now(),
      scene,
      replay: payload,
      bookmarks: this.bookmarks
        .filter((b) => b.step >= payload.startStep && b.step <= payload.endStep)
        .map(({ step, name }) => ({ step, name })),
    };
    try {
      if (mode === 'link') {
        const link = await replayShareLink(file);
        await navigator.clipboard.writeText(link);
        this.app.toast('Replay link copied', 'success');
      } else {
        const bytes = await encodeReplay(file);
        const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${(scene.name || 'scene').replace(/[^\w-]+/g, '_')}${REPLAY_EXTENSION}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        this.app.toast(
          `Replay saved (${Math.round(bytes.length / 1024)} kB, ${payload.entries.length} inputs)`,
          'success',
        );
      }
    } catch (e) {
      this.app.toast((e as Error).message, 'error');
    }
    this.poll(true);
  }

  async importReplay(file: File): Promise<void> {
    try {
      this.loadReplay(await decodeReplay(new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
      this.app.toast((e as Error).message, 'error');
    }
  }

  /** Open a replay in the viewer: the scene it was recorded in replaces the editor's, paused at the start. */
  loadReplay(file: ReplayFile): void {
    const { app } = this;
    app.sim.reset();
    app.loadDocument(file.scene, 'frame');
    app.sim.play();
    // objects the run created along the way (shots, spawned debris) need views from the start
    for (const e of file.replay.entries)
      if (e.kind === 'op' && e.op.op === 'addBody' && e.op.ephemeral) app.sim.ephemeral.set(e.op.body.id, e.op.body);
    app.sim.client.sendCustom('timeline', { cmd: 'replayLoad', payload: file.replay } satisfies TimelineCmd);
    app.sim.pause();
    this.replayName = file.name;
    this.bookmarks = file.bookmarks.map((b) => ({ ...b, id: this.nextBookmark++ }));
    this.markers = [];
    this.poll(true);
    app.toast(`Replay of “${file.name}” opened — press play`, 'success');
    this.emit('change', undefined);
  }

  /** Open the replay a `#replay=` link carries, if the page was opened with one. */
  async openFromHash(hash: string): Promise<boolean> {
    try {
      const file = await replayFromHash(hash);
      if (!file) return false;
      this.loadReplay(file);
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    } catch (e) {
      this.app.toast((e as Error).message, 'error');
      return false;
    }
  }

  exitReplay(): void {
    this.send({ cmd: 'replayExit' });
    this.replayName = null;
    this.app.sim.reset();
  }

  // ---- determinism ---------------------------------------------------------------------------------

  runDeterminism(steps = 240): void {
    if (!this.active) {
      this.app.sim.step(1); // builds the world (paused)
    }
    this.determinismRunning = true;
    this.determinism = null;
    this.send({ cmd: 'determinism', steps, every: 10 });
    this.emit('change', undefined);
  }

  /** The sentence the panels show for the determinism state. */
  determinismSummary(): { ok: boolean | null; text: string } {
    const d = this.determinism;
    const w = this.status?.watch;
    if (this.determinismRunning) return { ok: null, text: 'Checking…' };
    if (!d) return { ok: null, text: 'Not checked yet' };
    if (!d.ok) {
      const f = d.firstDivergence!;
      return {
        ok: false,
        text: `Not deterministic — two identical runs first differ at step ${f.step} (${(f.step / this.hz).toFixed(2)} s)`,
      };
    }
    if (w?.firstBad) return { ok: false, text: `Diverged from its own clone at step ${w.firstBad.step}` };
    const live = w && w.total > 0 ? `; the live run matched ${w.checked}/${w.total} checkpoints` : '';
    return { ok: true, text: `Deterministic — ${d.checkpoints} checkpoints over ${d.steps} steps${live}` };
  }
}

// ---- per-app instance ------------------------------------------------------------------------------

const instances = new WeakMap<App, TimeTravel>();

export function timeTravelFor(app: App): TimeTravel {
  let t = instances.get(app);
  if (!t) instances.set(app, (t = new TimeTravel(app)));
  return t;
}

/** Called once from `main.ts` after the app exists: starts listening, and opens a `#replay=` link. */
export function installTimeTravel(app: App): TimeTravel {
  const t = timeTravelFor(app);
  (app as unknown as { timeTravel: TimeTravel }).timeTravel = t; // debugging / e2e handle: window.physicslab.timeTravel
  if (/replay=/.test(location.hash)) void t.openFromHash(location.hash);
  return t;
}

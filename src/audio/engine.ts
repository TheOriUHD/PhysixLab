/**
 * The audio engine: a lazily started WebAudio graph with category buses, a master volume and mute, voice limiting,
 * and the players for one-shot sounds and sustained loops. Everything it plays is synthesised (`dsp.ts`); there are no
 * sample files.
 *
 *     one-shot voices ─┐                                    ┌→ analyser (the measured output level)
 *     loop voices ─→ spatial chain ─→ bus per category ─→ master ─→ limiter ─→ destination
 *
 * **Autoplay.** Browsers refuse (and log a warning about) an `AudioContext` that is created or resumed before the user
 * has interacted with the page. The engine therefore creates nothing until `unlock()` is called from a user gesture;
 * `arm()` listens for the first qualifying one (a press, a key other than Escape, a touch). Sounds requested before
 * that are dropped, not queued — nothing could have been playing anyway. When muted, disabled or in a hidden tab the
 * context is suspended, so an idle engine costs no CPU.
 *
 * **Voices.** Every playing sound is registered in a `VoicePool`: per-category and total limits, the quietest voice is
 * stolen (with a 20 ms fade) for a louder newcomer, a quieter newcomer is turned away. **Buffers.** One-shots are
 * rendered once per distinct key into an `AudioBuffer` (a bounded LRU cache), a few milliseconds per frame at most;
 * a request whose buffer is not ready waits a frame or two. **Time scale.** `pitch` multiplies the playback rate of
 * everything that sounds (set from the simulation's time scale by the director).
 */
import { Emitter } from '../core/events';
import type { Vec3 } from '../core/math';
import { renderRecipe, type Recipe } from './dsp';
import { soundEvent, type SoundEventParams } from './events';
import { buildOneShot, NoiseBank, ramp, SpatialChain, type OneShot } from './graph';
import { impactRecipe, typicalImpact, type ImpactVoice } from './impact';
import type { LoopVoice } from './loops';
import { clamp, hashString, volumeToGain } from './mapping';
import {
  DEFAULT_SPATIAL_MODEL,
  flatSpatial,
  listenerFromMatrix,
  newListener,
  newSpatialResult,
  spatialize,
  type SpatialModel,
  type SpatialResult,
} from './spatial';
import {
  AUDIO_CATEGORIES,
  AUDIO_CATEGORY_IDS,
  DEFAULT_AUDIO_SETTINGS,
  MAX_TOTAL_VOICES,
  type AudioCategory,
  type AudioSettings,
} from './settings';
import { VoicePool, type PoolVoice } from './voicePool';

export type EngineState = 'idle' | 'running' | 'suspended' | 'unsupported';

/** Time the engine may spend rendering new buffers in one frame, milliseconds (one render is always allowed). */
const RENDER_BUDGET_MS = 5;
/** Cached buffers are evicted (least recently used first) beyond this many / this many bytes. */
const MAX_BUFFERS = 280;
const MAX_BUFFER_BYTES = 40 * 1024 * 1024;
/** A request waiting for its buffer is dropped after this long, seconds. */
const MAX_WAIT = 1;
const MAX_DEFERRED = 24;
/** A voice quieter than this (linear, final) is not worth starting. */
const INAUDIBLE = 0.0012;
/** Fade given to a stolen voice, seconds. */
const STEAL_FADE = 0.02;

export interface OneShotRequest {
  key: string;
  recipe: () => Recipe;
  category: AudioCategory;
  /** Linear gain before spatialisation and the volumes. */
  gain: number;
  /** Playback rate before the Doppler and time-scale factors. */
  rate: number;
  /** Importance when voices compete, multiplies the loudness (default 1). */
  weight?: number;
  /** Spatial state (already computed by the caller). */
  pan: number;
  cutoff: number;
  distanceGain: number;
  dopplerRate: number;
}

interface Playing extends PoolVoice {
  stop(fade: number): void;
  dead: boolean;
}

/** A sustained voice held by the director: parameters are moved with `voice.update`, `spatial` follows the source. */
export class LoopHandle<V extends LoopVoice> implements PoolVoice {
  dead = false;
  /** The next update should jump to its parameters instead of approaching them. */
  fresh = true;

  constructor(
    readonly voice: V,
    readonly chain: SpatialChain,
    readonly category: AudioCategory,
    public priority: number,
    readonly start: number,
    private readonly onKill: (h: LoopHandle<LoopVoice>, fade: number) => void,
  ) {}

  kill(fade: number): void {
    this.onKill(this, fade);
  }
}

export interface EngineStats {
  state: EngineState;
  sampleRate: number;
  voices: number;
  byCategory: Record<AudioCategory, number>;
  buffers: number;
  bufferKB: number;
  renders: number;
  started: number;
  rejected: number;
  stolen: number;
  deferred: number;
  dropped: number;
  /** Common sounds still being prepared in idle frames. */
  warming: number;
  /** Output level (RMS, 0 … 1) measured at the master output over the last block. */
  level: number;
}

/** One sound that started, as the engine heard the request (kept for the status panel and the tests). */
export interface PlayedSound {
  key: string;
  category: AudioCategory;
  /** The request's gain times the distance gain. */
  gain: number;
  /** Playback rate after the Doppler and time-scale factors. */
  rate: number;
  pan: number;
  cutoff: number;
  /** Audio-clock time it started. */
  at: number;
}

const RECENT = 64;

export interface EngineOptions {
  /** Create the real-time context (tests substitute their own). Default: `new AudioContext()`. */
  createContext?: () => AudioContext;
}

export class AudioEngine extends Emitter<{ state: EngineState }> {
  settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS, volume: { ...DEFAULT_AUDIO_SETTINGS.volume } };
  state: EngineState = 'idle';
  /** The camera, as heard: set every frame with `setListener`. */
  readonly listener = newListener();
  spatialModel: SpatialModel = DEFAULT_SPATIAL_MODEL;
  /** Time-scale pitch factor applied to everything that plays (`pitchForTimeScale`). */
  pitch = 1;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Float32Array<ArrayBuffer> | null = null;
  private readonly buses = new Map<AudioCategory, GainNode>();
  private bank: NoiseBank | null = null;
  private readonly pool = new VoicePool<Playing | LoopHandle<LoopVoice>>({
    total: MAX_TOTAL_VOICES,
    perCategory: Object.fromEntries(AUDIO_CATEGORIES.map((c) => [c.id, c.maxVoices])),
  });

  private readonly cache = new Map<string, { buf: AudioBuffer; used: number }>();
  private cacheBytes = 0;
  private clock = 0;
  private renderMs = 0;
  private readonly deferred: { req: OneShotRequest; at: number }[] = [];
  private readonly warm: { key: string; recipe: () => Recipe }[] = [];

  private armed = false;
  private disarm: (() => void) | null = null;
  private userGesture = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private hasListener = false;

  /** The last sounds that started, newest last. */
  readonly recent: PlayedSound[] = [];

  private n = { renders: 0, started: 0, rejected: 0, stolen: 0, dropped: 0 };
  private readonly scratch = newSpatialResult();

  constructor(private readonly opts: EngineOptions = {}) {
    super();
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => {
        this.syncRunning();
      });
  }

  // -- lifecycle -----------------------------------------------------------------------------------------------------

  /** Start the context on the first user gesture. Safe to call more than once. */
  arm(target: Window = window): void {
    if (this.armed) return;
    this.armed = true;
    const types = ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const;
    const handler = (): void => {
      // A page that has never been activated (an Escape key, the start of a touch) cannot start audio yet.
      const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      if (ua && !ua.hasBeenActive) return;
      this.unlock();
    };
    for (const t of types) target.addEventListener(t, handler, { capture: true, passive: true });
    this.disarm = () => {
      for (const t of types) target.removeEventListener(t, handler, { capture: true });
      this.armed = false;
      this.disarm = null;
    };
  }

  /** Call from a user gesture: creates the context (once) and resumes it. */
  unlock(): void {
    this.userGesture = true;
    if (!this.settings.enabled) return;
    if (!this.ctx) this.start();
    else this.syncRunning();
    if (this.ctx?.state === 'running') this.disarm?.();
  }

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Whether a sound would be heard right now (running, enabled, not muted). */
  get audible(): boolean {
    return this.running && this.settings.enabled && !this.settings.muted;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** The audio clock, seconds (0 before the context exists). */
  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  private setState(s: EngineState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  private start(): void {
    if (this.ctx || this.state === 'unsupported') return;
    const Ctor =
      typeof window === 'undefined'
        ? undefined
        : (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!this.opts.createContext && !Ctor) {
      this.setState('unsupported');
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = this.opts.createContext
        ? this.opts.createContext()
        : new (Ctor as typeof AudioContext)({ latencyHint: 'interactive' });
    } catch (e) {
      console.warn('[audio] could not create an AudioContext:', e);
      this.setState('unsupported');
      return;
    }
    this.ctx = ctx;
    this.bank = new NoiseBank(ctx);
    // master → limiter → destination, with an analyser tapped off the limiter for the level meter.
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 10;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.analyserBuf = new Float32Array(this.analyser.fftSize);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.limiter.connect(this.analyser);
    for (const id of AUDIO_CATEGORY_IDS) {
      const bus = ctx.createGain();
      bus.connect(this.master);
      this.buses.set(id, bus);
    }
    this.applyGains(true);
    ctx.addEventListener('statechange', () => this.onContextState());
    this.queueWarmUp();
    this.syncRunning();
    this.onContextState();
  }

  private onContextState(): void {
    const s = this.ctx?.state;
    this.setState(!this.ctx ? 'idle' : s === 'running' ? 'running' : 'suspended');
  }

  /** Resume or suspend the context to match what is wanted: audible and visible. */
  private syncRunning(): void {
    const ctx = this.ctx;
    if (!ctx || !this.userGesture) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const want = this.settings.enabled && !this.settings.muted && !hidden;
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (want) {
      if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    } else if (ctx.state === 'running') {
      // Let the fade to silence finish before the context stops.
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        const stillOff =
          !this.settings.enabled || this.settings.muted || (typeof document !== 'undefined' && document.hidden);
        if (stillOff && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
      }, 250);
    }
  }

  /** Apply new settings (volumes move smoothly; mute and the master switch also stop an idle context). */
  configure(settings: AudioSettings): void {
    const wasEnabled = this.settings.enabled;
    this.settings = settings;
    if (this.ctx) {
      this.applyGains(false);
      if (!settings.enabled || settings.muted) this.stopAll(0.05);
    }
    // Switching the master switch on is itself done by a click: that click may create the context.
    if (settings.enabled && !wasEnabled && this.userGesture && !this.ctx) this.start();
    this.syncRunning();
  }

  private applyGains(immediate: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const s = this.settings;
    const t = ctx.currentTime;
    const tau = immediate ? 0 : 0.03;
    ramp(this.master.gain, s.enabled && !s.muted ? volumeToGain(s.master) : 0, t, tau);
    for (const [id, bus] of this.buses) ramp(bus.gain, volumeToGain(s.volume[id]), t, tau);
  }

  /** Effective linear volume of a category (master × category), 0 when muted or disabled. */
  volumeOf(category: AudioCategory): number {
    const s = this.settings;
    return s.enabled && !s.muted ? volumeToGain(s.master) * volumeToGain(s.volume[category]) : 0;
  }

  // -- the frame ----------------------------------------------------------------------------------------------------

  /** Once per rendered frame: reset the render budget, play requests that were waiting for a buffer, warm the cache. */
  beginFrame(): void {
    this.clock++;
    this.renderMs = 0;
    if (!this.running) return;
    if (this.deferred.length) {
      const waiting = this.deferred.splice(0, this.deferred.length);
      const t = this.now;
      for (const w of waiting) {
        if (t - w.at > MAX_WAIT) this.n.dropped++;
        else this.playOneShot(w.req, w.at);
      }
    }
    // Idle frames prepare the common sounds, as many as fit in half the render budget.
    while (this.warm.length && this.renderMs < RENDER_BUDGET_MS / 2) {
      const w = this.warm.shift() as { key: string; recipe: () => Recipe };
      this.bufferFor(w.key, w.recipe);
    }
  }

  private queueWarmUp(): void {
    for (const preset of ['steel', 'wood', 'rubber', 'plastic', 'concrete', 'glass', 'ground']) {
      const typical = typicalImpact(preset);
      this.warm.push({ key: typical.key, recipe: () => impactRecipe(typical.spec) });
    }
    for (const id of ['ui.select', 'ui.place', 'ui.delete', 'ui.error', 'ui.success', 'ui.toggle']) {
      const def = soundEvent(id);
      if (def) this.warm.push({ key: def.key({}), recipe: () => def.recipe({}) });
    }
    // The event sounds at their usual strength (the explosion is the one expensive render: do it last).
    for (const [id, params] of [
      ['launch', { level: 0.6 }],
      ['spawn', { size: 0.5 }],
      ['snap', { level: 0.5 }],
      ['trampoline', { level: 0.5 }],
      ['explosion', { size: 7, level: 0.5 }],
    ] as [string, SoundEventParams][]) {
      const def = soundEvent(id);
      if (def) this.warm.push({ key: def.key(params), recipe: () => def.recipe(params) });
    }
  }

  /** Set the listener from the camera's world matrix (column-major, three.js `matrixWorld.elements`). */
  setListener(matrix: ArrayLike<number>, dt: number): void {
    const l = this.listener;
    const px = l.x;
    const py = l.y;
    const pz = l.z;
    const had = this.hasListener;
    listenerFromMatrix(matrix, l);
    if (had && dt > 1e-4) {
      // Smooth and bound the velocity: a camera jump (framing the scene) must not become a supersonic Doppler shift.
      const k = 1 - Math.exp(-dt / 0.08);
      const cap = 80;
      l.vx += (clamp((l.x - px) / dt, -cap, cap) - l.vx) * k;
      l.vy += (clamp((l.y - py) / dt, -cap, cap) - l.vy) * k;
      l.vz += (clamp((l.z - pz) / dt, -cap, cap) - l.vz) * k;
    } else l.vx = l.vy = l.vz = 0;
    this.hasListener = true;
  }

  /** Spatial state of a source at a position (centred and full level when spatialisation is off). */
  spatialOf(x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, out: SpatialResult = this.scratch): SpatialResult {
    if (!this.settings.spatial) return flatSpatial(out);
    return spatialize(this.listener, x, y, z, out, this.spatialModel, vx, vy, vz, this.settings.doppler ? 1 : 0);
  }

  // -- buffers ------------------------------------------------------------------------------------------------------

  private bufferFor(key: string, make: () => Recipe): AudioBuffer | null {
    const hit = this.cache.get(key);
    if (hit) {
      hit.used = this.clock;
      return hit.buf;
    }
    const ctx = this.ctx;
    if (!ctx || this.renderMs >= RENDER_BUDGET_MS) return null;
    const t0 = performance.now();
    const data = renderRecipe(make(), ctx.sampleRate, hashString(key));
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    this.renderMs += performance.now() - t0;
    this.n.renders++;
    this.cache.set(key, { buf, used: this.clock });
    this.cacheBytes += data.length * 4;
    if (this.cache.size > MAX_BUFFERS || this.cacheBytes > MAX_BUFFER_BYTES) this.evict();
    return buf;
  }

  /** Drop the least recently used quarter of the cache. */
  private evict(): void {
    const entries = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, e] of entries.slice(0, Math.ceil(entries.length / 4))) {
      this.cache.delete(key);
      this.cacheBytes -= e.buf.length * 4;
    }
  }

  // -- one-shots ----------------------------------------------------------------------------------------------------

  /** Play a prepared request. Returns true when a voice started (or the request is waiting for its buffer). */
  playOneShot(req: OneShotRequest, born = this.now): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.audible) return false;
    const final = req.gain * req.distanceGain * this.volumeOf(req.category);
    if (final < INAUDIBLE) return false;
    const buf = this.bufferFor(req.key, req.recipe);
    if (!buf) {
      if (this.deferred.length < MAX_DEFERRED) this.deferred.push({ req, at: born });
      else this.n.dropped++;
      return true;
    }
    const priority = req.gain * req.distanceGain * (req.weight ?? 1);
    const admission = this.pool.admit(req.category, priority, ctx.currentTime);
    if (!admission.ok) {
      this.n.rejected++;
      return false;
    }
    for (const victim of admission.steals) this.kill(victim, STEAL_FADE);
    this.n.stolen += admission.steals.length;

    const bus = this.buses.get(req.category) as GainNode;
    const rate = clamp(req.rate * req.dopplerRate * (this.settings.pitchWithTimeScale ? this.pitch : 1), 0.1, 8);
    const shot: OneShot = buildOneShot(ctx, bus, buf, {
      gain: req.gain * req.distanceGain,
      rate,
      pan: req.pan,
      cutoff: req.cutoff,
    });
    const voice: Playing = {
      category: req.category,
      priority,
      start: ctx.currentTime,
      dead: false,
      stop: (fade) => shot.stop(fade),
    };
    this.pool.add(voice);
    this.n.started++;
    this.recent.push({
      key: req.key,
      category: req.category,
      gain: req.gain * req.distanceGain,
      rate,
      pan: req.pan,
      cutoff: req.cutoff,
      at: ctx.currentTime,
    });
    if (this.recent.length > RECENT) this.recent.shift();
    shot.source.onended = () => {
      voice.dead = true;
      this.pool.remove(voice);
      shot.dispose();
    };
    return true;
  }

  /** Play a registered sound event at a position (null = not positioned) with optional source velocity. */
  playEvent(id: string, position: Vec3 | null, params: SoundEventParams = {}, velocity?: Vec3): boolean {
    const def = soundEvent(id);
    if (!def || !this.audible) return false;
    if (def.category === 'ui' && !this.settings.uiSounds) return false;
    const sp =
      position && def.spatial
        ? this.spatialOf(position[0], position[1], position[2], velocity?.[0], velocity?.[1], velocity?.[2])
        : flatSpatial(this.scratch);
    return this.playOneShot({
      key: def.key(params),
      recipe: () => def.recipe(params),
      category: def.category,
      gain: def.gain(params),
      rate: def.rate?.(params) ?? 1,
      weight: def.priority,
      pan: sp.pan,
      cutoff: sp.cutoff,
      distanceGain: sp.gain,
      dopplerRate: sp.rate,
    });
  }

  /** Play the voices `planImpact` produced for a contact at a point. Returns how many started. */
  playImpact(voices: readonly ImpactVoice[], point: Vec3, velocity?: Vec3): number {
    if (!voices.length || !this.audible) return 0;
    const sp = this.spatialOf(point[0], point[1], point[2], velocity?.[0], velocity?.[1], velocity?.[2]);
    let n = 0;
    for (const v of voices) {
      const spec = v.spec;
      if (
        this.playOneShot({
          key: v.key,
          recipe: () => impactRecipe(spec),
          category: 'impacts',
          gain: v.gain,
          rate: v.rate,
          pan: sp.pan,
          cutoff: sp.cutoff,
          distanceGain: sp.gain,
          dopplerRate: sp.rate,
        })
      )
        n++;
    }
    return n;
  }

  // -- loops --------------------------------------------------------------------------------------------------------

  /**
   * Open a sustained voice. `make` builds it on the live context; the handle is registered in the voice pool under its
   * category (so a full category steals its quietest voice for a louder one). Returns null when it was not admitted.
   */
  openLoop<V extends LoopVoice>(
    category: AudioCategory,
    priority: number,
    make: (ctx: AudioContext, bank: NoiseBank) => V,
  ): LoopHandle<V> | null {
    const ctx = this.ctx;
    if (!ctx || !this.bank || !this.audible) return null;
    const admission = this.pool.admit(category, priority, ctx.currentTime);
    if (!admission.ok) {
      this.n.rejected++;
      return null;
    }
    for (const victim of admission.steals) this.kill(victim, STEAL_FADE * 2);
    this.n.stolen += admission.steals.length;
    const bus = this.buses.get(category) as GainNode;
    const chain = new SpatialChain(ctx, bus);
    const voice = make(ctx, this.bank);
    voice.out.connect(chain.input);
    const handle = new LoopHandle<V>(voice, chain, category, priority, ctx.currentTime, (h, fade) =>
      this.closeLoop(h, fade),
    );
    this.pool.add(handle);
    this.n.started++;
    return handle;
  }

  closeLoop(handle: LoopHandle<LoopVoice>, fade = 0.1): void {
    if (handle.dead) return;
    handle.dead = true;
    this.pool.remove(handle);
    handle.voice.stop(fade);
    setTimeout(
      () => {
        handle.voice.dispose();
        handle.chain.dispose();
      },
      (fade + 0.1) * 1000,
    );
  }

  private kill(v: Playing | LoopHandle<LoopVoice>, fade: number): void {
    if (v instanceof LoopHandle) {
      this.closeLoop(v, fade);
    } else if (!v.dead) {
      v.dead = true;
      v.stop(fade);
      this.pool.remove(v);
    }
  }

  /** Stop every voice (mute, disable, reset). */
  stopAll(fade = 0.05): void {
    for (const v of [...this.pool.voices]) this.kill(v, fade);
    this.deferred.length = 0;
  }

  /** Keys of the buffers rendered so far (`i|…` impacts, `e|…` events, `u|…` interface sounds). */
  cachedKeys(): string[] {
    return [...this.cache.keys()];
  }

  // -- measurement and status ------------------------------------------------------------------------------------------

  /** RMS level (0 … 1) of the last block at the master output; 0 when the engine is not running. */
  level(): number {
    if (!this.analyser || !this.analyserBuf || !this.running) return 0;
    this.analyser.getFloatTimeDomainData(this.analyserBuf);
    let s = 0;
    for (let i = 0; i < this.analyserBuf.length; i++) s += this.analyserBuf[i] * this.analyserBuf[i];
    return Math.sqrt(s / this.analyserBuf.length);
  }

  get stats(): EngineStats {
    const byCategory = Object.fromEntries(AUDIO_CATEGORY_IDS.map((c) => [c, this.pool.count(c)])) as Record<
      AudioCategory,
      number
    >;
    return {
      state: this.state,
      sampleRate: this.sampleRate,
      voices: this.pool.count(),
      byCategory,
      buffers: this.cache.size,
      bufferKB: Math.round(this.cacheBytes / 1024),
      renders: this.n.renders,
      started: this.n.started,
      rejected: this.n.rejected,
      stolen: this.n.stolen,
      deferred: this.deferred.length,
      dropped: this.n.dropped,
      warming: this.warm.length,
      level: this.level(),
    };
  }

  dispose(): void {
    this.disarm?.();
    this.stopAll(0.01);
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.setState('idle');
  }
}

/**
 * AudioDirector — connects the sound system (`src/audio`) to the application.
 *
 *   contact events      → impact sounds by material, size and energy (the strongest few per frame), trampoline boings
 *   body poses          → rolling rumble and sliding scrape from the ground contact and slip (`render/fx/slip.ts`)
 *   motorised joints and components that publish a speed → engine / motor voices (the loudest few)
 *   the followed body   → wind; a quiet air bed while the simulation runs
 *   explosions, launches, spawns, broken joints, component events → one-shot event sounds
 *   selection, adding and removing, toasts → the subtle interface sounds
 *   preferences         → volumes, mute, spatialisation (`Prefs.audio`); time scale → pitch
 *
 * It owns the `AudioEngine` (`app.audio`) and runs once per frame from the frame loop. The engine is created at once
 * but makes no sound and no `AudioContext` until the first user gesture (see `engine.ts`). Every decision that can be
 * made without the app lives in a pure module with its own tests: the materials and impact plan (`audio/impact.ts`),
 * the rolling / motor / wind mappings, the motor source discovery (`motorSources.ts`), the interface-sound gate.
 */
import type { Vec3 } from '../../core/math';
import { AudioEngine, type EngineStats, type LoopHandle } from '../../audio/engine';
import { soundEvent } from '../../audio/events';
import { planImpact } from '../../audio/impact';
import { soundProfileFor } from '../../audio/materials';
import { MotorVoice, RollingVoice, BedVoice, WindVoice } from '../../audio/loops';
import { clamp01, pitchForTimeScale } from '../../audio/mapping';
import {
  MOTOR_AUDIBLE,
  MOTOR_KINDS,
  motorParams,
  newMotorParams,
  type MotorKind,
  type MotorParams,
} from '../../audio/motor';
import {
  airDensityForGravity,
  bedParams,
  newWindParams,
  windParams,
  type BedParams,
  type WindParams,
} from '../../audio/ambience';
import { patchAudioSettings, type AudioSettings } from '../../audio/settings';
import { newRollParams, ROLL_AUDIBLE, rollParams, type RollParams } from '../../audio/rolling';
import { distanceGain, newSpatialResult } from '../../audio/spatial';
import { B, BODY_STRIDE, GROUND_ID, J, JOINT_STRIDE, type ContactEvent, type SimEvent } from '../../physics/protocol';
import { groundContact, newGroundContact } from '../../render/fx/slip';
import { TopN } from '../../audio/voicePool';
import type { App } from '../app';
import type { SimMode } from '../simController';
import { ContactQueue } from '../fx/contactQueue';
import { audioBodyInfo, type AudioBodyInfo } from './bodyAudio';
import { LoopSet, type HandleLike } from './loopSet';
import { scanSources, readSource, type MotorReading, type MotorSource } from './motorSources';
import { UiSoundGate, type UiSoundKind } from './uiGate';

/** A contact counts as touching the ground when the lowest point is within this of the floor, metres. */
const CONTACT_TOLERANCE = 0.06;
/** Impact sounds handled per rendered frame (the strongest contacts win). */
const IMPACTS_PER_FRAME = 8;
/** Rate of the sustained-voice updates, seconds between them. */
const LOOP_STEP = 1 / 30;
const MAX_ROLLING = 6;
const MAX_MOTORS = 4;

export type SettingsPatch = Partial<Omit<AudioSettings, 'volume'>> & { volume?: Partial<AudioSettings['volume']> };

export type SoundPreview =
  'steel' | 'wood' | 'glass' | 'rubber' | 'stone' | 'explosion' | 'engine' | 'wind' | 'rolling';

/** A scripted demonstration of a sustained sound (the Sound panel's test buttons): which, and when it started. */
interface Demo {
  kind: 'engine' | 'wind' | 'rolling';
  t0: number;
  duration: number;
}

type RollHandle = LoopHandle<RollingVoice>;
type MotorHandle = LoopHandle<MotorVoice>;

export interface AudioDirectorStats extends EngineStats {
  rolling: number;
  motors: number;
  wind: boolean;
  contactsWatched: boolean;
  sources: number;
}

export class AudioDirector {
  readonly engine: AudioEngine;
  private readonly queue = new ContactQueue(160);
  private release: (() => void) | null = null;
  private readonly infos = new Map<string, AudioBodyInfo>();
  private indexed: (AudioBodyInfo | null)[] = [];
  private indexedLayout = -1;
  private indexedRev = -1;
  private rev = 0;
  private sources: MotorSource[] | null = null;
  private readonly gate = new UiSoundGate();
  private readonly seenSpawn = new Set<string>();
  private clock = 0;
  private loopAcc = 0;
  private airSpeed = 0;
  /** Magnitude of the scene's gravity, m/s² (read once per loop update). */
  private gravity = 9.81;
  private demo: Demo | null = null;

  private readonly rolling: LoopSet<RollHandle>;
  private readonly motors: LoopSet<MotorHandle>;
  private readonly wind: LoopSet<LoopHandle<WindVoice>>;
  private readonly bed: LoopSet<LoopHandle<BedVoice>>;

  // Reused scratch (the loop update runs 30 times a second and must not allocate).
  private readonly contact = newGroundContact();
  private readonly roll: RollParams = newRollParams();
  private readonly motor: MotorParams = newMotorParams();
  private readonly windP: WindParams = newWindParams();
  private readonly bedP: BedParams = { gain: 0, cutoff: 700 };
  private readonly reading: MotorReading = { rpm: 0, load: 0 };
  private readonly sp = newSpatialResult();
  private readonly topRoll = new TopN<number>(MAX_ROLLING);
  private readonly topMotor = new TopN<number>(MAX_MOTORS);

  constructor(private readonly app: App) {
    this.engine = new AudioEngine();
    this.engine.configure(app.prefs.value.audio);
    this.engine.arm();
    const e = this.engine;
    this.rolling = new LoopSet((priority) =>
      e.openLoop('rolling', priority, (ctx, bank) => new RollingVoice(ctx, bank)),
    );
    this.motors = new LoopSet();
    this.wind = new LoopSet((priority) => e.openLoop('ambience', priority, (ctx, bank) => new WindVoice(ctx, bank)));
    this.bed = new LoopSet((priority) => e.openLoop('ambience', priority, (ctx, bank) => new BedVoice(ctx, bank)));
    for (const kind of MOTOR_KINDS)
      this.motorOpeners[kind] = (priority) =>
        e.openLoop('engines', priority, (ctx, bank) => new MotorVoice(ctx, bank, kind));

    app.prefs.on('change', (keys) => {
      if (keys.includes('audio')) this.applySettings();
    });
    app.sim.on('mode', (m) => this.onMode(m));
    app.sim.on('layout', () => this.onLayout());
    app.sim.on('broken', ({ id, force }) => this.onJointBroken(id, force));
    app.sim.client.on('event', (ev) => this.onEvent(ev));
    app.store.on('change', (c) => {
      this.rev++;
      this.infos.clear();
      this.sources = null;
      if (c.type === 'add') this.onAdded(c.ids);
      else if (c.type === 'remove') this.ui('delete');
      else if (c.type === 'reset') this.reset();
    });
    app.store.on('selection', (ids) => {
      if (ids.length) this.ui('select');
    });
    app.on('toast', ({ kind }) => {
      if (kind === 'error') this.ui('error');
      else if (kind === 'success') this.ui('success');
    });
    this.applySettings();
  }

  /** Opens a motor voice of each kind (one closure per kind, made once). */
  private readonly motorOpeners = {} as Record<MotorKind, (priority: number) => MotorHandle | null>;

  // -- settings and lifecycle ----------------------------------------------------------------------------------------

  private applySettings(): void {
    const s = this.app.prefs.value.audio;
    this.engine.configure(s);
    const want = s.enabled && !s.muted;
    if (want && !this.release) {
      this.release = this.app.contacts.acquire(
        'audio',
        { minImpulse: 0.02, pairInterval: 0.05, maxPerFrame: 48 },
        (ev) => this.queue.push(ev),
      );
    } else if (!want && this.release) {
      this.release();
      this.release = null;
      this.queue.clear();
    }
    if (!want) this.closeLoops(0.05);
  }

  /** Change settings (stored in the preferences; `applySettings` follows from the change event). */
  setSettings(patch: SettingsPatch): void {
    this.app.prefs.set({ audio: patchAudioSettings(this.app.prefs.value.audio, patch) });
  }

  private onMode(mode: SimMode): void {
    if (mode === 'edit') this.reset();
  }

  /** Reset or a new scene: nothing keeps sounding and nothing waits. */
  private reset(): void {
    this.queue.clear();
    this.seenSpawn.clear();
    this.closeLoops(0.06);
    this.engine.stopAll(0.06);
  }

  private closeLoops(fade: number): void {
    this.rolling.closeAll(fade);
    this.motors.closeAll(fade);
    this.wind.closeAll(fade);
    this.bed.closeAll(fade);
  }

  // -- body information -----------------------------------------------------------------------------------------------

  private infoFor(id: string): AudioBodyInfo | null {
    const cached = this.infos.get(id);
    if (cached) return cached;
    const def = this.app.store.body(id) ?? this.app.sim.ephemeral.get(id);
    if (!def) return null;
    const info = audioBodyInfo(def);
    this.infos.set(id, info);
    return info;
  }

  private indexedInfos(): (AudioBodyInfo | null)[] {
    const client = this.app.sim.client;
    if (this.indexedLayout !== client.layoutNo || this.indexedRev !== this.rev) {
      this.indexedLayout = client.layoutNo;
      this.indexedRev = this.rev;
      this.indexed = client.bodyIds.map((id) => this.infoFor(id));
    }
    return this.indexed;
  }

  private positionOf(id: string): Vec3 | null {
    const p = this.app.sim.client.poseOf(id);
    if (p) return [p[B.px], p[B.py], p[B.pz]];
    const def = this.app.store.body(id) ?? this.app.sim.ephemeral.get(id);
    if (def) return def.position;
    const joint = this.app.store.joint(id);
    const anchor = joint ? (joint.bodyA ?? joint.bodyB) : null;
    return anchor ? this.positionOf(anchor) : null;
  }

  // -- events ---------------------------------------------------------------------------------------------------------

  private onJointBroken(id: string, force: number): void {
    const at = this.positionOf(id);
    if (!at) return;
    this.engine.playEvent('snap', at, { level: clamp01(Math.log10(Math.max(10, force) / 10) / 3) });
  }

  private onEvent(ev: SimEvent): void {
    if (ev.kind !== 'component') return;
    const at = this.positionOf(ev.owner);
    if (!at) return;
    const data = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.name) {
      case 'ignite':
        this.engine.playEvent('launch', at, { level: 0.7 });
        break;
      case 'bounce':
        this.engine.playEvent('trampoline', at, { level: clamp01(Number(data.speed ?? 8) / 14) });
        break;
      case 'sound':
        // Any component can ask for a registered sound: ctx.emit('sound', { id: 'explosion', params: { size: 5 } }).
        if (typeof data.id === 'string' && soundEvent(data.id)) this.engine.playEvent(data.id, at, data.params ?? {});
        break;
      default:
        break;
    }
  }

  /** Something was added to the document: a spawn in a running simulation, the "place" tick while editing. */
  private onAdded(ids: string[]): void {
    const { app } = this;
    if (app.sim.active) {
      let n = 0;
      for (const id of ids) {
        const def = app.store.body(id);
        if (!def || n >= 3) continue;
        n++;
        this.engine.playEvent('spawn', def.position, { size: audioBodyInfo(def).size });
      }
    } else this.ui('place');
  }

  /** Bodies spawned straight into the running world (projectiles aside, which have their launch sound). */
  private onLayout(): void {
    const { app } = this;
    for (const id of this.seenSpawn) if (!app.sim.ephemeral.has(id)) this.seenSpawn.delete(id);
    for (const [id, def] of app.sim.ephemeral) {
      if (this.seenSpawn.has(id)) continue;
      this.seenSpawn.add(id);
      if (def.tags.includes('projectile') || def.tags.includes('fx-debris')) continue;
      this.engine.playEvent('spawn', def.position, { size: audioBodyInfo(def).size });
    }
  }

  /** The Blast tool (and anything else that sets off an explosion): `strength` is the blast tool's impulse scale. */
  explosion(at: Vec3, radius: number, strength: number): void {
    this.engine.playEvent('explosion', at, { size: radius, level: clamp01(strength / 120) });
  }

  /** A projectile leaves the barrel. */
  launch(at: Vec3, speed: number, size: number): void {
    this.engine.playEvent('launch', at, { size, level: clamp01(speed / 45) });
  }

  /** A subtle interface sound, if the settings and the gate allow it. */
  ui(kind: UiSoundKind): void {
    if (!this.engine.audible || !this.app.prefs.value.audio.uiSounds) return;
    if (!this.gate.request(kind, this.clock)) return;
    this.engine.playEvent(`ui.${kind}`, null);
  }

  // -- the frame ------------------------------------------------------------------------------------------------------

  update(dt: number): void {
    const { app, engine } = this;
    this.clock += dt;
    engine.beginFrame();
    if (!engine.audible) {
      this.queue.clear();
      return;
    }
    engine.pitch = pitchForTimeScale(app.sim.timeScale);
    engine.setListener(app.camera.matrixWorld.elements, dt);
    const client = app.sim.client;
    const live = app.sim.mode === 'running' && client.active && client.frameNo > 0;

    if (this.queue.size) this.queue.drain(IMPACTS_PER_FRAME, (ev) => this.onContact(ev));
    this.loopAcc += dt;
    if (this.loopAcc >= LOOP_STEP) {
      const step = this.loopAcc;
      this.loopAcc = 0;
      if (live) this.updateLoops(step);
      else {
        this.rolling.closeAll(0.15);
        this.motors.closeAll(0.15);
        this.wind.closeAll(0.3);
        this.bed.closeAll(0.4);
      }
      if (this.demo) this.updateDemo();
    }
  }

  private onContact(ev: ContactEvent): boolean {
    const { app, engine } = this;
    const client = app.sim.client;
    const ground = ev.b === GROUND_ID;
    const a = this.infoFor(ev.a);
    const b = ground ? null : this.infoFor(ev.b);
    if (!a && !b) return false;
    if (a?.fragment || b?.fragment) return false;
    const voices = planImpact({
      speed: ev.speed,
      impulse: ev.impulse,
      matA: ev.matA,
      matB: ground ? 'ground' : ev.matB,
      sizeA: a?.size ?? 0.5,
      sizeB: ground ? 99 : (b?.size ?? 0.5),
      massA: client.info.mass[ev.a] ?? 0,
      massB: ground ? 0 : (client.info.mass[ev.b] ?? 0),
    });
    let played = voices.length > 0 && engine.playImpact(voices, ev.point, this.velocityOf(ev.a)) > 0;
    // A brittle body hit hard breaks: the fragments are the `break` event, in the material's own voice.
    for (const v of voices) {
      if (!v.spec.shatter) continue;
      const size = v.role === 'b' ? (b?.size ?? 0.5) : (a?.size ?? 0.5);
      played =
        engine.playEvent('break', ev.point, { material: soundProfileFor(v.spec.preset).cls, size, level: v.level }) ||
        played;
    }
    if ((a?.trampoline || b?.trampoline) && ev.speed >= 1.2)
      played = engine.playEvent('trampoline', ev.point, { level: clamp01(ev.speed / 14) }) || played;
    return played;
  }

  /** Velocity of a body (for Doppler); only looked up when Doppler is on. */
  private velocityOf(id: string): Vec3 | undefined {
    if (!this.app.prefs.value.audio.doppler) return undefined;
    const p = this.app.sim.client.poseOf(id);
    return p ? [p[B.vx], p[B.vy], p[B.vz]] : undefined;
  }

  // -- sustained voices -------------------------------------------------------------------------------------------------

  private updateLoops(step: number): void {
    const g = this.app.store.settings.gravity;
    this.gravity = Math.hypot(g[0], g[1], g[2]);
    this.scanRolling();
    this.scanMotors();
    this.updateAmbience(step);
  }

  /** Gain of distance for a source at a point (1 when spatialisation is off). */
  private nearness(x: number, y: number, z: number): number {
    if (!this.app.prefs.value.audio.spatial) return 1;
    const l = this.engine.listener;
    return distanceGain(Math.hypot(x - l.x, y - l.y, z - l.z), this.engine.spatialModel);
  }

  private floorY(): number {
    const g = this.app.store.settings.ground;
    return g.enabled ? 0 : -Infinity;
  }

  private groundOf(i: number, floorY: number, info: AudioBodyInfo): boolean {
    const poses = this.app.sim.client.poses;
    const o = i * BODY_STRIDE;
    if (poses[o + B.state] !== 0) return false;
    groundContact(
      info.spec,
      poses[o + B.px],
      poses[o + B.py],
      poses[o + B.pz],
      poses[o + B.qx],
      poses[o + B.qy],
      poses[o + B.qz],
      poses[o + B.qw],
      poses[o + B.vx],
      poses[o + B.vy],
      poses[o + B.vz],
      poses[o + B.wx],
      poses[o + B.wy],
      poses[o + B.wz],
      floorY,
      CONTACT_TOLERANCE,
      this.contact,
    );
    return this.contact.touching;
  }

  private rollOf(info: AudioBodyInfo): RollParams {
    const c = this.contact;
    const mass = this.app.sim.client.info.mass[info.id] ?? 0;
    return rollParams(
      {
        cls: info.cls,
        speed: c.speed,
        slip: c.slip,
        load: mass * this.gravity,
        size: info.size,
        rounded: info.rounded,
      },
      this.roll,
    );
  }

  /** Rolling and sliding: the loudest few bodies on the ground each get a voice. */
  private scanRolling(): void {
    const { app, engine } = this;
    const floorY = this.floorY();
    const client = app.sim.client;
    const top = this.topRoll;
    top.clear();
    if (floorY !== -Infinity) {
      const infos = this.indexedInfos();
      const n = Math.min(infos.length, Math.floor(client.poses.length / BODY_STRIDE));
      for (let i = 0; i < n; i++) {
        const info = infos[i];
        if (!info?.rolls || !this.groundOf(i, floorY, info)) continue;
        const loudness = this.rollOf(info).loudness;
        if (loudness < ROLL_AUDIBLE) continue;
        const c = this.contact;
        top.offer(i, loudness * this.nearness(c.x, c.y, c.z));
      }
    }
    this.rolling.begin();
    const t = engine.now;
    const sp = this.sp;
    for (let k = 0; k < top.size; k++) {
      const i = top.items[k] as number;
      const info = this.indexedInfos()[i];
      if (!info || !this.groundOf(i, floorY, info)) continue;
      const params = this.rollOf(info);
      const h = this.rolling.touch(info.id, top.scores[k]);
      if (!h) continue;
      const o = i * BODY_STRIDE;
      const poses = client.poses;
      const c = this.contact;
      engine.spatialOf(c.x, c.y, c.z, poses[o + B.vx], poses[o + B.vy], poses[o + B.vz], sp);
      if (h.fresh) h.chain.set(sp, t);
      else h.chain.apply(sp, t);
      h.voice.update(params, t, engine.pitch * sp.rate, h.fresh);
      h.fresh = false;
    }
    this.rolling.finish(0.15);
  }

  private sourceList(): MotorSource[] {
    if (!this.sources) {
      const { store, sim } = this.app;
      this.sources = scanSources([...store.bodies(), ...store.joints(), ...sim.ephemeral.values()]);
    }
    return this.sources;
  }

  private readMotor(s: MotorSource): MotorReading | null {
    const client = this.app.sim.client;
    let jointSpeed = NaN;
    if (s.joint) {
      const ji = client.jointIndex.get(s.joint.id);
      if (ji !== undefined && (ji + 1) * JOINT_STRIDE <= client.joints.length)
        jointSpeed = client.joints[ji * JOINT_STRIDE + J.speed];
    }
    const state = s.component ? client.stateOf(s.component.id) : null;
    return readSource(s, jointSpeed, state, this.app.sim.keys, this.reading);
  }

  /** Engines and motors: the loudest few sources each get a voice. */
  private scanMotors(): void {
    const { app, engine } = this;
    const client = app.sim.client;
    const sources = this.sourceList();
    const top = this.topMotor;
    top.clear();
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const bi = s.bodyId ? client.bodyIndex.get(s.bodyId) : undefined;
      const r = bi === undefined ? null : this.readMotor(s);
      if (!r || bi === undefined) continue;
      const m = motorParams(s.kind, r.rpm, r.load, this.motor);
      if (m.gain < MOTOR_AUDIBLE) continue;
      const o = bi * BODY_STRIDE;
      top.offer(i, m.gain * this.nearness(client.poses[o + B.px], client.poses[o + B.py], client.poses[o + B.pz]));
    }
    this.motors.begin();
    const t = engine.now;
    const sp = this.sp;
    for (let k = 0; k < top.size; k++) {
      const s = sources[top.items[k] as number];
      const bi = s.bodyId ? (client.bodyIndex.get(s.bodyId) as number) : 0;
      const r = this.readMotor(s);
      if (!r) continue;
      const m = motorParams(s.kind, r.rpm, r.load, this.motor);
      const h = this.motors.touch(`${s.kind}:${s.key}`, top.scores[k], this.motorOpeners[s.kind]);
      if (!h) continue;
      const o = bi * BODY_STRIDE;
      const poses = client.poses;
      engine.spatialOf(
        poses[o + B.px],
        poses[o + B.py],
        poses[o + B.pz],
        poses[o + B.vx],
        poses[o + B.vy],
        poses[o + B.vz],
        sp,
      );
      if (h.fresh) h.chain.set(sp, t);
      else h.chain.apply(sp, t);
      h.voice.update(m, t, engine.pitch * sp.rate, h.fresh);
      h.fresh = false;
    }
    this.motors.finish(0.2);
  }

  /** Wind from the followed body's speed; the air bed while the simulation runs. */
  private updateAmbience(step: number): void {
    const { app, engine } = this;
    const prefs = app.prefs.value;
    let target = 0;
    if (prefs.followSelection) {
      const id = app.store.selection.find((s) => app.store.body(s));
      const v = id ? app.sim.velocityOf(id) : null;
      if (v) target = Math.hypot(v.linear[0], v.linear[1], v.linear[2]);
    }
    this.airSpeed += (target - this.airSpeed) * (1 - Math.exp(-step / 0.35));
    const density = airDensityForGravity(this.gravity);
    this.driveAmbience(this.airSpeed, density, engine.now);
  }

  private driveAmbience(airSpeed: number, density: number, t: number): void {
    const wp = windParams(airSpeed, density, this.windP);
    this.wind.begin();
    if (wp.gain > 0.004) {
      const h = this.wind.touch('wind', wp.gain);
      if (h) {
        if (h.fresh) h.chain.set({ gain: 1, pan: 0, cutoff: 20000 }, t);
        h.voice.update(wp, t, h.fresh);
        h.fresh = false;
      }
    }
    this.wind.finish(0.4);
    const bp = bedParams(density, this.bedP);
    this.bed.begin();
    if (bp.gain > 0.004) {
      const h = this.bed.touch('bed', bp.gain);
      if (h) {
        if (h.fresh) h.chain.set({ gain: 1, pan: 0, cutoff: 20000 }, t);
        h.voice.update(bp, t, h.fresh);
        h.fresh = false;
      }
    }
    this.bed.finish(0.6);
  }

  // -- test sounds (the Sound panel) ----------------------------------------------------------------------------------

  /** A point 4 m in front of the camera: where test sounds play, so they are at full level and centred. */
  private frontOfCamera(): Vec3 {
    const l = this.engine.listener;
    return [l.x + l.fx * 4, l.y + l.fy * 4, l.z + l.fz * 4];
  }

  /** Play a sample of a sound so the volumes can be judged. Returns false when sound is off or muted. */
  preview(kind: SoundPreview): boolean {
    const { engine } = this;
    if (!engine.audible) return false;
    const at = this.frontOfCamera();
    switch (kind) {
      case 'steel':
      case 'wood':
      case 'glass':
      case 'rubber':
      case 'stone':
        engine.playImpact(
          planImpact({
            speed: 9,
            impulse: 900,
            matA: kind === 'stone' ? 'concrete' : kind,
            matB: 'ground',
            sizeA: 0.4,
            sizeB: 99,
            massA: 20,
            massB: 0,
          }),
          at,
        );
        break;
      case 'explosion':
        engine.playEvent('explosion', at, { size: 6, level: 0.6 });
        break;
      case 'engine':
      case 'wind':
      case 'rolling':
        this.demo = { kind, t0: this.clock, duration: kind === 'engine' ? 3.4 : 3 };
        break;
    }
    return true;
  }

  /** The sustained-sound demos sweep their inputs through the very same voices a simulation uses. */
  private updateDemo(): void {
    const d = this.demo;
    if (!d) return;
    const { engine } = this;
    const x = (this.clock - d.t0) / d.duration;
    const t = engine.now;
    if (x >= 1 || !engine.audible) {
      this.demo = null;
      this.motors.closeAll(0.2);
      this.wind.closeAll(0.3);
      this.rolling.closeAll(0.2);
      return;
    }
    const swell = Math.sin(Math.PI * x); // 0 → 1 → 0
    if (d.kind === 'engine') {
      this.motors.begin();
      const h = this.motors.touch('demo', 1, this.motorOpeners.combustion);
      if (h) {
        const m = motorParams('combustion', 900 + 4200 * swell, 0.25 + 0.6 * swell, this.motor);
        h.chain.set({ gain: 1, pan: 0, cutoff: 20000 }, t);
        h.voice.update(m, t, engine.pitch, h.fresh);
        h.fresh = false;
      }
      this.motors.finish(0.2);
    } else if (d.kind === 'wind') {
      this.wind.begin();
      const wp = windParams(8 + 38 * swell, 1, this.windP);
      const h = this.wind.touch('demo', 1);
      if (h) {
        h.chain.set({ gain: 1, pan: 0, cutoff: 20000 }, t);
        h.voice.update(wp, t, h.fresh);
        h.fresh = false;
      }
      this.wind.finish(0.3);
    } else {
      // Rolling up to speed, then braking into a slide: rumble first, scrape after.
      this.rolling.begin();
      const speed = 9 * swell;
      const slip = x > 0.55 ? speed * 0.9 : 0;
      const params = rollParams({ cls: 'metal', speed, slip, load: 1500, size: 0.5, rounded: true }, this.roll);
      const h = this.rolling.touch('demo', 1);
      if (h) {
        h.chain.set({ gain: 1, pan: 0, cutoff: 20000 }, t);
        h.voice.update(params, t, engine.pitch, h.fresh);
        h.fresh = false;
      }
      this.rolling.finish(0.2);
    }
  }

  /** The live parameters of every sustained voice, keyed by what it follows (for the status panel and the tests). */
  describeLoops(): {
    rolling: Record<string, Record<string, number>>;
    motors: Record<string, Record<string, number>>;
    wind: Record<string, number> | null;
    bed: Record<string, number> | null;
  } {
    const dump = <H extends HandleLike & { voice: { inspect(): Record<string, number> } }>(set: LoopSet<H>) =>
      Object.fromEntries([...set.handles].map(([k, h]) => [k, h.voice.inspect()]));
    return {
      rolling: dump(this.rolling),
      motors: dump(this.motors),
      wind: this.wind.handles.get('wind')?.voice.inspect() ?? null,
      bed: this.bed.handles.get('bed')?.voice.inspect() ?? null,
    };
  }

  get stats(): AudioDirectorStats {
    return {
      ...this.engine.stats,
      rolling: this.rolling.size,
      motors: this.motors.size,
      wind: this.wind.size > 0,
      contactsWatched: this.release !== null,
      sources: this.sources?.length ?? 0,
    };
  }
}

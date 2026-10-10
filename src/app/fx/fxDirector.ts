/**
 * FxDirector — connects the visual-effects system (`render/fx`) to the application.
 *
 *   contact events  → impact effects: sparks, dust, chips, shards, scuffs, debris (and projectile hits)
 *   body poses      → ground contact and slip per wheel / sliding body → tyre smoke, dust trails, sparks, skid marks
 *   the blast tool  → explosion
 *   preferences     → quality tier, master switch, per-effect switches (`Prefs.fx`)
 *   simulation      → effects time (pause, slow motion), reset (clear everything), the scene seed (determinism)
 *
 * It owns the `Fx` instance (`app.fx`), the contact-feed subscription and the physical-debris manager, and runs once
 * per frame from the frame loop. All decisions that can be made without the app — the material recipes, the slip
 * estimate, the trail plan, the wheel detection — live in pure modules with their own tests.
 */
import type { Vector3 } from 'three';
import type { Vec3 } from '../../core/math';
import { hexToLinear } from '../../render/fx/particleTypes';
import { Fx, sanitizeFxSettings, type EmitOptions, type FxSettings, type FxStats } from '../../render/fx';
import { groundContact, newGroundContact } from '../../render/fx/slip';
import { impactIntensity, surfaceFor, type FxSurface } from '../../render/fx/surfaces';
import { newTrailPlan, planTrail } from '../../render/fx/trails';
import type { SceneSettings } from '../../model/types';
import { B, BODY_STRIDE, GROUND_ID, type ContactEvent } from '../../physics/protocol';
import type { App } from '../app';
import type { SimMode } from '../simController';
import { bodyFxInfo, hingedBodies, type BodyFxInfo } from './bodyFx';
import { ContactQueue } from './contactQueue';
import { FxClock } from './fxClock';
import { onReducedMotionChange, prefersReducedMotion } from './motion';
import { PhysicalDebris } from './physicalDebris';

export type FxPreview = 'sparks' | 'dust' | 'glass' | 'explosion' | 'tyre';

/** A ground contact counts when the lowest point is within this of the floor, metres. */
const CONTACT_TOLERANCE = 0.06;
const MAX_QUEUE = 256;

export class FxDirector {
  readonly fx: Fx;
  readonly debris: PhysicalDebris;
  private readonly clock = new FxClock();
  private readonly queue = new ContactQueue(MAX_QUEUE);
  private release: (() => void) | null = null;
  private lastMode: SimMode = 'edit';
  private lastSettings: SceneSettings | null = null;
  private groundSurface: FxSurface = surfaceFor('ground', '#2b3038');

  // Per-body info, cached by id and indexed by the simulation's body order for the per-frame scan.
  private readonly infos = new Map<string, BodyFxInfo>();
  private readonly skidKeys = new Map<string, number>();
  private hinged: Set<string> | null = null;
  private indexed: (BodyFxInfo | null)[] = [];
  private indexedLayout = -1;
  private indexedRev = -1;
  private rev = 0;

  private readonly contact = newGroundContact();
  private readonly plan = newTrailPlan();
  // Reused emit options: the scan runs every frame and must not allocate.
  private readonly smokeOpts: EmitOptions = { direction: [0, 1, 0] };
  private readonly dustOpts: EmitOptions = { direction: [0, 1, 0], color: [0.3, 0.3, 0.3] };
  private readonly sparkOpts: EmitOptions = { spread: 0.7, speed: 0.8, scale: 0.8 };
  private scratchPos: [number, number, number] = [0, 0, 0];
  private scratchDir: [number, number, number] = [0, 1, 0];
  private scratchVel: [number, number, number] = [0, 0, 0];

  constructor(private readonly app: App) {
    this.fx = new Fx(app.viewport.helpers, app.prefs.value.quality);
    this.debris = new PhysicalDebris(app.sim);

    app.sim.on('mode', (m) => this.onMode(m));
    app.store.on('change', (c) => {
      this.invalidate();
      if (c.type === 'reset') this.clearAll();
    });
    app.prefs.on('change', (keys) => {
      if (keys.includes('fx') || keys.includes('quality')) this.applySettings();
    });
    onReducedMotionChange(() => this.fx.setFlashScale(prefersReducedMotion() ? 0.3 : 1));
    this.fx.setFlashScale(prefersReducedMotion() ? 0.3 : 1);
    this.syncEnvironment();
    this.applySettings();
  }

  // -- settings ----------------------------------------------------------------------------------------------------

  get settings(): FxSettings {
    return this.fx.settings;
  }

  /** Change settings (stored in the preferences; `applySettings` follows from the change event). */
  setSettings(patch: Partial<FxSettings>): void {
    this.app.prefs.set({ fx: sanitizeFxSettings({ ...this.app.prefs.value.fx, ...patch }, this.app.prefs.value.fx) });
  }

  private applySettings(): void {
    const { app, fx } = this;
    const s = app.prefs.value.fx;
    const wasOn = fx.settings.enabled;
    fx.configure(s, app.prefs.value.quality);
    this.debris.cap = fx.tier.physicalDebrisCap;
    if (!s.enabled && wasOn) this.clearAll();
    // Contact events only while something needs them.
    const wantContacts = s.enabled && (s.impacts || s.debris || s.physicalDebris);
    if (wantContacts && !this.release) {
      this.release = app.contacts.acquire('fx', { minImpulse: 0.1, pairInterval: 0.08, maxPerFrame: 48 }, (ev) =>
        this.queue.push(ev),
      );
    } else if (!wantContacts && this.release) {
      this.release();
      this.release = null;
      this.queue.clear();
    }
  }

  // -- lifecycle ---------------------------------------------------------------------------------------------------

  private onMode(mode: SimMode): void {
    if (mode === 'edit') this.clearAll();
    else if (this.lastMode === 'edit') this.newWorld();
    this.lastMode = mode;
  }

  /** A simulation was built: restart the random streams and the clock from the scene seed. */
  private newWorld(): void {
    const seed = this.app.store.settings.seed;
    this.fx.reseed(seed);
    this.debris.reseed(seed);
    this.clock.reset();
    this.queue.clear();
  }

  /** Reset or a new scene: no particles, marks, fragments or pending events survive. */
  clearAll(): void {
    this.skidKeys.clear();
    this.fx.clear();
    this.debris.clear();
    this.clock.reset();
    this.queue.clear();
  }

  private invalidate(): void {
    this.infos.clear();
    this.hinged = null;
    this.rev++;
  }

  private syncEnvironment(): void {
    const s = this.app.store.settings;
    if (s === this.lastSettings) return;
    this.lastSettings = s;
    const g = s.ground;
    const color = hexToLinear(g.color) ?? [0.03, 0.03, 0.04];
    this.groundSurface = surfaceFor('ground', g.color);
    this.dustOpts.color = [
      Math.min(1, color[0] * 1.8 + 0.12),
      Math.min(1, color[1] * 1.8 + 0.11),
      Math.min(1, color[2] * 1.8 + 0.1),
    ];
    this.fx.setEnvironment({
      gravity: s.gravity,
      floorY: g.enabled ? 0 : -Infinity,
      groundColor: color,
    });
  }

  // -- body information --------------------------------------------------------------------------------------------

  private infoFor(id: string): BodyFxInfo | null {
    const cached = this.infos.get(id);
    if (cached) return cached;
    const { store, sim } = this.app;
    const def = store.body(id) ?? sim.ephemeral.get(id);
    if (!def) return null;
    this.hinged ??= hingedBodies(store.joints());
    let key = this.skidKeys.get(id);
    if (key === undefined) this.skidKeys.set(id, (key = this.skidKeys.size + 1));
    const info = bodyFxInfo(def, this.hinged, key);
    this.infos.set(id, info);
    return info;
  }

  /** `infos` in the order of the simulation's bodies (rebuilt when the layout or the document changed). */
  private indexedInfos(): (BodyFxInfo | null)[] {
    const client = this.app.sim.client;
    if (this.indexedLayout !== client.layoutNo || this.indexedRev !== this.rev) {
      this.indexedLayout = client.layoutNo;
      this.indexedRev = this.rev;
      this.indexed = client.bodyIds.map((id) => this.infoFor(id));
    }
    return this.indexed;
  }

  // -- frame -------------------------------------------------------------------------------------------------------

  update(dt: number): void {
    const { app, fx } = this;
    const sim = app.sim;
    const client = sim.client;
    this.syncEnvironment();
    const fxDt = this.clock.step(dt, {
      active: sim.active,
      running: sim.mode === 'running',
      timeScale: sim.timeScale,
      realtimeFactor: client.stats?.realtimeFactor,
      simTime: client.stats?.simTime,
    });
    if (fx.settings.enabled) {
      if (this.queue.size) this.processContacts();
      if (fxDt > 0 && client.active && client.frameNo > 0) this.scanBodies(fxDt);
      this.debris.update(fxDt);
    }
    fx.update(fxDt, app.camera);
  }

  // -- impacts -----------------------------------------------------------------------------------------------------

  private processContacts(): void {
    this.queue.drain(this.fx.tier.burstsPerFrame, (ev) => this.onContact(ev));
  }

  private onContact(ev: ContactEvent): boolean {
    const { app, fx } = this;
    const aInfo = this.infoFor(ev.a);
    const bGround = ev.b === GROUND_ID;
    const bInfo = bGround ? null : this.infoFor(ev.b);
    if (aInfo?.fragment || bInfo?.fragment) return false;
    if (!aInfo && !bInfo) return false; // both gone (removed since the event)
    const a = aInfo?.surface ?? surfaceFor(ev.matA);
    const b = bGround ? this.groundSurface : (bInfo?.surface ?? surfaceFor(ev.matB));
    const size = Math.min(aInfo?.size ?? 1, bGround ? 99 : (bInfo?.size ?? 1));
    const bursts = fx.impact({
      position: ev.point,
      normal: ev.normal,
      speed: ev.speed,
      impulse: ev.impulse,
      a,
      b,
      bIsGround: bGround,
      size,
    });
    // A projectile hitting something at speed: a small blast on top of the material effects.
    let flashed = false;
    if ((aInfo?.projectile || bInfo?.projectile) && ev.speed >= 6) {
      const level = impactIntensity(ev.speed, ev.impulse);
      flashed = fx.explosion(ev.point, { radius: 0.6 + 1.8 * level, energy: 0.5 + level, kind: 'impact' });
    }
    if (fx.settings.physicalDebris && fx.settings.enabled) {
      for (const burst of bursts) {
        if (!burst.physical) continue;
        const source = burst.from === 'a' ? aInfo : bInfo;
        const def = source ? (app.store.body(source.id) ?? app.sim.ephemeral.get(source.id)) : undefined;
        if (!def) continue;
        const dir = ev.normal;
        this.debris.spawn(burst, def.material.preset, def.material.color, ev.point, dir);
      }
    }
    return bursts.length > 0 || flashed;
  }

  // -- trails ------------------------------------------------------------------------------------------------------

  private scanBodies(dt: number): void {
    const { fx } = this;
    const s = fx.settings;
    if (!s.trails && !s.skidMarks) return;
    const client = this.app.sim.client;
    const floorY = fx.env.floorY;
    if (floorY === -Infinity) return;
    const infos = this.indexedInfos();
    const poses = client.poses;
    const n = Math.min(infos.length, Math.floor(poses.length / BODY_STRIDE));
    const c = this.contact;
    const plan = this.plan;
    let emitted = 0;
    const emitCap = fx.tier.burstsPerFrame * 3;
    fx.beginScan();
    for (let i = 0; i < n; i++) {
      const info = infos[i];
      if (!info || !info.trails) continue;
      const o = i * BODY_STRIDE;
      if (poses[o + B.state] !== 0) continue; // asleep or switched off
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
        c,
      );
      if (!c.touching) continue;
      planTrail(c, info, plan);
      if (s.skidMarks && plan.skid > 0) fx.skid(info.skidKey, c.x, c.z, info.width, plan.skid, plan.tone);
      if (!s.trails || emitted >= emitCap) continue;

      const pos = this.scratchPos;
      pos[0] = c.x;
      pos[1] = c.y + 0.05;
      pos[2] = c.z;
      if (plan.smoke > 0) {
        const vel = this.scratchVel;
        vel[0] = poses[o + B.vx];
        vel[1] = 0;
        vel[2] = poses[o + B.vz];
        const o2 = this.smokeOpts;
        o2.count = plan.smoke * dt;
        o2.scale = 0.6 + info.size * 0.9;
        o2.velocity = vel;
        fx.emit('smoke.tyre', pos, o2);
        emitted++;
      }
      if (plan.dust > 0) {
        const o2 = this.dustOpts;
        o2.count = plan.dust * dt;
        o2.scale = 0.6 + info.size * 0.7;
        fx.emit('dust.trail', pos, o2);
        emitted++;
      }
      if (plan.sparks > 0 && c.slip > 0) {
        // Thrown back against the direction the surface slides.
        const d = this.scratchDir;
        d[0] = (-c.slipX / c.slip) * 0.8;
        d[1] = 0.6;
        d[2] = (-c.slipZ / c.slip) * 0.8;
        const o2 = this.sparkOpts;
        o2.count = plan.sparks * dt;
        o2.direction = d;
        fx.emit('spark', pos, o2);
        emitted++;
      }
    }
    fx.endScan();
  }

  // -- explosions and previews -----------------------------------------------------------------------------------

  /** The blast tool: returns true when the particle explosion took over, false when effects are off (the caller then draws its fallback). */
  blast(at: Vector3, radius: number, strength: number): boolean {
    return this.fx.explosion([at.x, at.y, at.z], { radius, energy: Math.min(3, Math.max(0.3, strength / 60)) });
  }

  /**
   * Show an effect at the point the camera looks at — for trying the settings out (the Effects panel). Returns false
   * when effects are switched off.
   */
  preview(kind: FxPreview): boolean {
    const { fx, app } = this;
    if (!fx.settings.enabled) return false;
    const t = app.viewport.controls.target;
    const floor = fx.env.floorY === -Infinity ? t.y : fx.env.floorY;
    const at: Vec3 = [t.x, floor + 0.02, t.z];
    const up: Vec3 = [0, 1, 0];
    // Previews show the effect even when its own switch is off (that is what a preview is for); the master switch rules.
    const impact = (a: string, speed: number, impulse: number, size = 0.5) =>
      fx.impact(
        {
          position: at,
          normal: up,
          speed,
          impulse,
          a: surfaceFor(a),
          b: this.groundSurface,
          bIsGround: true,
          size,
        },
        true,
      );
    switch (kind) {
      case 'sparks':
        impact('steel', 10, 3000);
        break;
      case 'dust':
        impact('concrete', 6, 2500, 1);
        break;
      case 'glass':
        impact('glass', 9, 800);
        break;
      case 'tyre':
        fx.emit('smoke.tyre', [at[0], at[1] + 0.1, at[2]], { count: 40, radius: 0.5, scale: 1.4 });
        break;
      case 'explosion':
        fx.explosion([at[0], floor + 1.2, at[2]], { radius: 5 }, true);
        break;
    }
    return true;
  }

  get stats(): FxStats & { fragments: number; contactsWatched: boolean } {
    return { ...this.fx.stats, fragments: this.debris.count, contactsWatched: this.release !== null };
  }
}

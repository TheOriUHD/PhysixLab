/**
 * The zone system: the one object per world that zone components and the world bounds share (ZN-1 … ZN-3, ZN-34).
 *
 * A zone component only knows about itself. Everything that needs the whole picture lives here:
 *
 *  - the **registry of running zones** (for race specs, gravity arbitration and the published list),
 *  - the **race book** (laps, splits, best lap, penalties — `race.ts`) and the **score**,
 *  - the **loss / respawn machinery** shared by kill zones and the world bounds: respawn points, delayed respawns,
 *    penalties, per-unit respawn limits, and moving a whole *unit* (one body, or every body of its group) rigidly,
 *  - **spawning** simulation-only bodies and removing them again,
 *  - **teleport immunity** (so a pair of teleporters cannot ping-pong a body) and switching **components on and off**.
 *
 * It is created by the component host, saved in snapshots (`save` / `load`, key `@zones`) and publishes its state as
 * JSON under `ZONES_STATE_ID`, so time travel restores the standings and the page never has to reduce events to know
 * them. Everything here is deterministic: no wall clock, no `Math.random`.
 *
 * A *unit* is what a zone acts on: the body that entered, or — when the zone is set to "whole group" — every body that
 * shares its `parent` group, so a vehicle built from a chassis and four wheels is lost, respawned, teleported and
 * counted as one racer.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { qconj, qmul, qnorm, qrot, vadd, vsub, type Quat, type Vec3 } from '../../core/math';
import { ZONES_STATE_ID, emptyZonesState, type ZonesPublic } from '../../model/zones';
import type { BodyEntity } from '../../model/types';
import type { ComponentContext } from '../components/context';
import type { ComponentHost } from '../components/host';
import { addBody } from '../world/bodies';
import { removeEntities, setVelocity, teleport } from '../world/edits';
import type { BodyRec, WorldState } from '../world/state';
import { pos, rot } from '../world/util';
import { RaceBook, type RaceSpec } from './race';

/** A zone component that is running: what the system needs to know about it. */
export interface ZoneRec {
  readonly componentId: string;
  readonly ownerId: string;
  /** The component's live parameters (`ctx.str('action')` …). */
  readonly ctx: ComponentContext;
  /** Bodies inside that passed the zone's filter → the simulation time they entered. */
  readonly inside: Map<string, number>;
}

/** Who raised an event: a zone component, or the world bounds. */
export interface EventSource {
  owner: string;
  /** Component id ('' for the bounds). */
  component: string;
  type: 'zone' | 'bounds';
  /** The zone's label (or its body's name), for the page's log. */
  zone: string;
}

export interface LossOptions {
  mode: 'remove' | 'respawn';
  to: 'start' | 'checkpoint';
  /** Seconds the body stays out of the world before it comes back. */
  delay: number;
  /** Seconds added to the racer's times. */
  penalty: number;
  /** Points taken off the score. */
  penaltyPoints: number;
  /** Respawns allowed per unit before it is removed for good (0 = unlimited). */
  max: number;
  /** Why ("zone", "bounds", "drowned" …) — reported in the events. */
  cause: string;
  /** Act on the whole group of the body. */
  group: boolean;
  source: EventSource;
}

interface Pose {
  id: string;
  position: Vec3;
  rotation: Quat;
  /** Velocities to restore (the authored ones for a respawn at the start, zero otherwise). */
  linvel: Vec3;
  angvel: Vec3;
}

interface PendingRespawn {
  at: number;
  poses: Pose[];
  source: EventSource;
  body: string;
  unit: string;
  to: 'start' | 'checkpoint';
  cause: string;
  count: number;
}

interface SpawnedRec {
  born: number;
  lifetime: number;
  source: string;
}

const MAX_EVENTS = 4096;
const ZERO: Vec3 = [0, 0, 0];

export class ZoneSystem {
  readonly zones = new Map<string, ZoneRec>();
  readonly races = new RaceBook();
  score = { total: 0, byRacer: {} as Record<string, number> };
  private message: ZonesPublic['message'] = null;
  private messageId = 0;
  /** Poses to come back to, per body (set by checkpoints and respawn points). */
  private respawnPoints = new Map<string, Pose>();
  private respawnCounts = new Map<string, number>();
  /** Body → simulation time until which teleporters ignore it. */
  private immune = new Map<string, number>();
  private pending: PendingRespawn[] = [];
  private bornAt = new Map<string, number>();
  private spawned = new Map<string, SpawnedRec>();
  private dirty = false;
  private rev = 0;
  private published = false;

  constructor(
    private readonly s: WorldState,
    readonly host: ComponentHost,
  ) {}

  // ---- registry ----------------------------------------------------------------------------

  register(rec: ZoneRec): void {
    this.zones.set(rec.componentId, rec);
    this.dirty = true;
  }

  unregister(componentId: string): void {
    if (this.zones.delete(componentId)) this.dirty = true;
  }

  /** Race specs derived from the zones that are running now. */
  raceSpec(race: string): RaceSpec {
    return this.raceSpecs().get(race) ?? { checkpoints: [], hasStart: false, laps: 1 };
  }

  raceSpecs(): Map<string, RaceSpec> {
    const out = new Map<string, RaceSpec>();
    for (const z of this.zones.values()) {
      const action = z.ctx.str('action');
      if (action !== 'checkpoint' && action !== 'start' && action !== 'finish') continue;
      const race = z.ctx.str('race');
      let spec = out.get(race);
      if (!spec) out.set(race, (spec = { checkpoints: [], hasStart: false, laps: 1 }));
      if (action === 'checkpoint') {
        const i = Math.round(z.ctx.num('index'));
        if (!spec.checkpoints.includes(i)) spec.checkpoints.push(i);
      } else if (action === 'start') spec.hasStart = true;
      else {
        if (z.ctx.bool('startsClock')) spec.hasStart = true;
        spec.laps = Math.max(spec.laps, Math.round(z.ctx.num('laps')));
      }
    }
    for (const spec of out.values()) spec.checkpoints.sort((a, b) => a - b);
    return out;
  }

  /** Mark the published state stale (it is written at the end of the step). */
  touch(): void {
    this.dirty = true;
  }

  // ---- bodies ------------------------------------------------------------------------------

  rec(bodyId: string): BodyRec | undefined {
    return this.s.bodies.get(bodyId);
  }

  /** The body exists and is part of the simulation (not switched off). */
  isActive(bodyId: string): boolean {
    const r = this.s.bodies.get(bodyId);
    return !!r && !r.disabled;
  }

  get time(): number {
    return this.s.simTime;
  }

  get gravity(): Vec3 {
    return this.s.settings.gravity;
  }

  /** The unit a body belongs to: its group (when `group` is set and it has one) or itself. */
  unitOf(bodyId: string, group: boolean): string {
    const r = this.s.bodies.get(bodyId);
    return group && r?.def.parent ? r.def.parent : bodyId;
  }

  /** Every body of the unit (just the body itself unless `group` is set and it belongs to a group). */
  membersOf(bodyId: string, group: boolean): BodyRec[] {
    const r = this.s.bodies.get(bodyId);
    if (!r) return [];
    const parent = r.def.parent;
    if (!group || !parent) return [r];
    return this.s.order.filter((o) => o.def.parent === parent);
  }

  /** When the clock of a racer would start without a start line: 0 for the scene's bodies, the spawn time for others. */
  born(unit: string): number {
    return this.bornAt.get(unit) ?? 0;
  }

  // ---- events ------------------------------------------------------------------------------

  /** `t` is the simulation time stamped on the event: the end of the current step unless the engine event gave one. */
  emit(src: EventSource, name: string, data?: unknown, t?: number): void {
    if (this.s.events.length > MAX_EVENTS) return; // a runaway zone must not grow the queue without bound
    this.s.events.push({
      kind: 'component',
      t: t ?? this.s.simTime,
      owner: src.owner,
      component: src.component,
      type: src.type,
      name,
      ...(data !== undefined ? { data } : {}),
    });
  }

  // ---- score and messages ------------------------------------------------------------------

  addScore(points: number, racer: string): void {
    if (!points) return;
    this.score.total += points;
    this.score.byRacer[racer] = (this.score.byRacer[racer] ?? 0) + points;
    this.dirty = true;
  }

  flash(text: string): void {
    if (!text) return;
    this.message = { text, id: ++this.messageId, t: this.s.simTime };
    this.dirty = true;
  }

  // ---- respawn points ----------------------------------------------------------------------

  /** Remember where every body of the unit is now as the place to come back to. */
  captureRespawn(bodyId: string, group: boolean): void {
    for (const m of this.membersOf(bodyId, group)) {
      this.respawnPoints.set(m.id, { id: m.id, position: pos(m.rb), rotation: rot(m.rb), linvel: ZERO, angvel: ZERO });
    }
  }

  /** Set the respawn point of one body to a given pose. */
  setRespawn(bodyId: string, position: Vec3, rotation: Quat): void {
    this.respawnPoints.set(bodyId, { id: bodyId, position, rotation, linvel: ZERO, angvel: ZERO });
  }

  hasRespawn(bodyId: string): boolean {
    return this.respawnPoints.has(bodyId);
  }

  private startPose(m: BodyRec): Pose {
    return {
      id: m.id,
      position: [...m.def.position],
      rotation: [...m.def.rotation],
      linvel: [...m.def.velocity],
      angvel: [...m.def.angularVelocity],
    };
  }

  // ---- losing and bringing back ------------------------------------------------------------

  /**
   * A unit is lost: it is removed, or sent back (at once, or after `delay`) to its starting pose or to the last
   * checkpoint, with the penalties applied. Does nothing if the body is already out of the world.
   */
  lose(bodyId: string, o: LossOptions): void {
    const rec = this.s.bodies.get(bodyId);
    if (!rec || rec.disabled) return;
    const unit = this.unitOf(bodyId, o.group);
    const members = this.membersOf(bodyId, o.group).filter((m) => !m.disabled);
    if (!members.length) return;
    if (o.penalty > 0) {
      for (const racer of new Set([bodyId, unit])) this.races.penalise(racer, o.penalty);
      this.dirty = true;
    }
    if (o.penaltyPoints) this.addScore(-o.penaltyPoints, unit);
    let mode = o.mode;
    let count = this.respawnCounts.get(unit) ?? 0;
    if (mode === 'respawn') {
      count++;
      if (o.max > 0 && count > o.max) mode = 'remove';
    }
    this.emit(o.source, 'kill', { body: bodyId, unit, zone: o.source.zone, mode, cause: o.cause, penalty: o.penalty });
    if (mode === 'remove') {
      for (const m of members) this.removeBody(m.id, 'kill');
      return;
    }
    this.respawnCounts.set(unit, count);
    // The checkpoint pose is used only when every body of the unit has one (a half-restored vehicle would tear its joints).
    const useCheckpoint = o.to === 'checkpoint' && members.every((m) => this.respawnPoints.has(m.id));
    const poses = members.map((m) => (useCheckpoint ? this.respawnPoints.get(m.id)! : this.startPose(m)));
    const to = useCheckpoint ? 'checkpoint' : 'start';
    if (o.delay <= 0) {
      this.restore(poses);
      this.emit(o.source, 'respawn', {
        body: bodyId,
        unit,
        zone: o.source.zone,
        to,
        position: poses.find((p) => p.id === bodyId)?.position ?? poses[0].position,
        cause: o.cause,
        count,
      });
      return;
    }
    for (const m of members) this.holdOut(m);
    this.pending.push({
      at: this.s.simTime + o.delay,
      poses,
      source: o.source,
      body: bodyId,
      unit,
      to,
      cause: o.cause,
      count,
    });
  }

  /** Switch a body off for a while (hidden, no collisions): it will be put back by a delayed respawn. */
  private holdOut(m: BodyRec): void {
    m.disabled = true;
    m.rb.setEnabled(false);
    this.s.queriesDirty = true;
  }

  private restore(poses: Pose[]): void {
    for (const p of poses) {
      if (!this.s.bodies.has(p.id)) continue;
      teleport(this.s, p.id, p.position, p.rotation, false);
      setVelocity(this.s, p.id, p.linvel, p.angvel);
    }
  }

  /**
   * Take a body out of the simulation for good. A simulation-only body (a projectile, a spawned copy) is really
   * removed — the page is told with a `despawn` event; a body of the scene is switched off (it vanishes from the
   * viewport and stops colliding, and Reset brings it back).
   */
  removeBody(bodyId: string, reason: 'lifetime' | 'kill'): void {
    const rec = this.s.bodies.get(bodyId);
    if (!rec) return;
    if (rec.ephemeral) {
      removeEntities(this.s, [bodyId]);
      this.spawned.delete(bodyId);
      this.emit({ owner: bodyId, component: '', type: 'zone', zone: '' }, 'despawn', { body: bodyId, reason });
      return;
    }
    rec.disabled = true;
    rec.rb.setEnabled(false);
    this.s.queriesDirty = true;
  }

  // ---- spawning ----------------------------------------------------------------------------

  /** Add a simulation-only body to the world and track it (for `lifetime` and the page). */
  spawnBody(def: BodyEntity, source: string, lifetime: number): BodyRec {
    const rec = addBody(this.s, def, true);
    this.bornAt.set(def.id, this.s.simTime);
    this.spawned.set(def.id, { born: this.s.simTime, lifetime, source });
    return rec;
  }

  isSpawned(bodyId: string): boolean {
    return this.spawned.has(bodyId);
  }

  // ---- moving units ------------------------------------------------------------------------

  /** Teleport immunity: `bodyId` is ignored by teleporters until `until` (simulation seconds). */
  setImmune(bodyId: string, until: number): void {
    this.immune.set(bodyId, until);
  }

  isImmune(bodyId: string): boolean {
    const until = this.immune.get(bodyId);
    return until !== undefined && this.s.simTime < until;
  }

  /**
   * The poses the bodies of a unit would have if the body `bodyId` stood at (`position`, `rotation`) and the others kept
   * their place relative to it (a rigid transform). Also returns that rotation.
   */
  private unitPoses(bodyId: string, group: boolean, position: Vec3, rotation: Quat): { poses: Pose[]; R: Quat } {
    const pivot = this.s.bodies.get(bodyId);
    if (!pivot) return { poses: [], R: [0, 0, 0, 1] };
    const p0 = pos(pivot.rb);
    const R: Quat = qnorm(qmul(rotation, qconj(rot(pivot.rb))));
    const poses = this.membersOf(bodyId, group).map((m) => {
      const lin = m.rb.linvel();
      const ang = m.rb.angvel();
      return {
        id: m.id,
        position: m.id === bodyId ? position : vadd(position, qrot(R, vsub(pos(m.rb), p0))),
        rotation: m.id === bodyId ? rotation : qnorm(qmul(R, rot(m.rb))),
        linvel: [lin.x, lin.y, lin.z] as Vec3,
        angvel: [ang.x, ang.y, ang.z] as Vec3,
      };
    });
    return { poses, R };
  }

  /**
   * Move a unit rigidly so that the body `bodyId` ends at (`position`, `rotation`): every other body of the unit keeps
   * its place relative to it. `velocity` says what happens to the velocities: kept, turned (by `turn`, by default the
   * rotation the move applied), or stopped. Returns the rigid rotation that was applied.
   */
  moveUnit(
    bodyId: string,
    group: boolean,
    position: Vec3,
    rotation: Quat,
    velocity: 'keep' | 'rotate' | 'stop',
    turn?: Quat,
  ): Quat {
    const { poses, R } = this.unitPoses(bodyId, group, position, rotation);
    const V = turn ?? R;
    for (const p of poses) {
      teleport(this.s, p.id, p.position, p.rotation, true);
      if (velocity === 'keep') continue;
      if (velocity === 'stop') setVelocity(this.s, p.id, ZERO, ZERO);
      else setVelocity(this.s, p.id, qrot(V, p.linvel), qrot(V, p.angvel));
    }
    return R;
  }

  /** Make (`position`, `rotation`) the place the body `bodyId` — and the rest of its unit around it — comes back to. */
  setRespawnUnit(bodyId: string, group: boolean, position: Vec3, rotation: Quat): void {
    for (const p of this.unitPoses(bodyId, group, position, rotation).poses) {
      this.respawnPoints.set(p.id, { ...p, linvel: ZERO, angvel: ZERO });
    }
  }

  // ---- sensors -----------------------------------------------------------------------------

  /**
   * Let the sensors of a zone body also see kinematic bodies and kinematic zones see static ones. By default the
   * engine pairs a sensor only with dynamic bodies; this opts the zone's colliders into the rest (never fixed–fixed:
   * the ground and walls are not "entering" anything).
   */
  armSensors(ownerId: string): void {
    const rec = this.s.bodies.get(ownerId);
    if (!rec) return;
    const T = RAPIER.ActiveCollisionTypes;
    const types = T.DYNAMIC_DYNAMIC | T.DYNAMIC_KINEMATIC | T.DYNAMIC_FIXED | T.KINEMATIC_KINEMATIC | T.KINEMATIC_FIXED;
    for (const c of rec.cols) if (c.isSensor()) c.setActiveCollisionTypes(types);
  }

  /** The bodies whose colliders overlap the zone body's sensors right now, with the number of overlapping collider pairs. */
  overlapping(ownerId: string): Map<string, number> {
    const out = new Map<string, number>();
    const rec = this.s.bodies.get(ownerId);
    if (!rec) return out;
    for (const c of rec.cols) {
      if (!c.isSensor()) continue;
      this.s.world.intersectionPairsWith(c, (c2) => {
        const o = this.s.owners.get(c2.handle);
        if (o?.rec && o.id !== ownerId && !o.sensor) out.set(o.id, (out.get(o.id) ?? 0) + 1);
      });
    }
    return out;
  }

  // ---- switching components ----------------------------------------------------------------

  /**
   * Switch the components of `targetId` on or off for the running simulation (the document is untouched; Reset
   * restores it). `type` '' means every component except zones (name `zone` to switch those); returns how many
   * components changed.
   */
  setComponentsEnabled(targetId: string, type: string, enabled: boolean): number {
    const rec = this.s.bodies.get(targetId);
    if (!rec) return 0;
    let changed = 0;
    const next = rec.def.components.map((c) => {
      const selected = type === '' ? c.type !== 'zone' : c.type === type;
      if (!selected || c.enabled === enabled) return c;
      changed++;
      return { ...c, enabled };
    });
    if (!changed) return 0;
    rec.def = { ...rec.def, components: next };
    this.host.sync('body', targetId, next);
    return changed;
  }

  // ---- gravity arbitration -----------------------------------------------------------------

  /** The gravity-override zone that rules `bodyId` (highest priority; the newer body wins a tie), or null. */
  gravityWinner(bodyId: string): string | null {
    let best: string | null = null;
    let bestPriority = -Infinity;
    let bestSeq = -1;
    for (const z of this.zones.values()) {
      if (!z.inside.has(bodyId) || z.ctx.str('action') !== 'gravity') continue;
      const priority = z.ctx.num('priority');
      const seq = this.s.bodies.get(z.ownerId)?.seq ?? 0;
      if (priority > bestPriority || (priority === bestPriority && seq > bestSeq)) {
        best = z.componentId;
        bestPriority = priority;
        bestSeq = seq;
      }
    }
    return best;
  }

  // ---- per step ----------------------------------------------------------------------------

  /** Called once per fixed step, after the components: delayed respawns and spawn lifetimes. */
  tick(): void {
    const t = this.s.simTime;
    if (this.pending.length) {
      const due = this.pending.filter((p) => p.at <= t + 1e-9);
      if (due.length) {
        this.pending = this.pending.filter((p) => p.at > t + 1e-9);
        for (const p of due) {
          this.restore(p.poses);
          this.emit(p.source, 'respawn', {
            body: p.body,
            unit: p.unit,
            zone: p.source.zone,
            to: p.to,
            position: p.poses.find((q) => q.id === p.body)?.position ?? p.poses[0].position,
            cause: p.cause,
            count: p.count,
          });
        }
      }
    }
    if (this.spawned.size) {
      for (const [id, r] of [...this.spawned]) {
        if (!this.s.bodies.has(id)) this.spawned.delete(id);
        else if (r.lifetime > 0 && t - r.born >= r.lifetime) this.removeBody(id, 'lifetime');
      }
    }
  }

  /** Write the state for the page if anything changed since the last step. */
  publishIfDirty(): void {
    if (this.dirty) this.publish();
  }

  /** Spawned bodies of one spawner that are still in the world. */
  aliveFrom(source: string): number {
    let n = 0;
    for (const [id, r] of this.spawned) if (r.source === source && this.s.bodies.has(id)) n++;
    return n;
  }

  // ---- publishing --------------------------------------------------------------------------

  /** The state as the page sees it. */
  snapshot(): ZonesPublic {
    return {
      rev: this.rev,
      score: { total: this.score.total, byRacer: { ...this.score.byRacer } },
      message: this.message ? { ...this.message } : null,
      races: this.races.toPublic(this.raceSpecs()),
    };
  }

  private publish(bump = true): void {
    this.dirty = false;
    const quiet =
      !this.published &&
      !this.score.total &&
      !this.message &&
      !this.races.raceNames.length &&
      !Object.keys(this.score.byRacer).length;
    if (quiet) return; // a scene without races or scores never creates the entry
    if (bump) this.rev++;
    this.published = true;
    const json = this.snapshot();
    let rec = this.s.componentState.get(ZONES_STATE_ID);
    if (!rec) {
      rec = { entry: { owner: '', type: 'zones', values: null }, version: 0, sent: -1 };
      this.s.componentState.set(ZONES_STATE_ID, rec);
    }
    rec.entry.json = json;
    rec.version++;
  }

  // ---- lifecycle and snapshots -------------------------------------------------------------

  /** The world is being rebuilt or replaced: forget everything. */
  clear(): void {
    this.zones.clear();
    this.races.clear();
    this.score = { total: 0, byRacer: {} };
    this.message = null;
    this.respawnPoints.clear();
    this.respawnCounts.clear();
    this.immune.clear();
    this.pending = [];
    this.bornAt.clear();
    this.spawned.clear();
    if (this.published) {
      this.s.componentStateRemoved.push(ZONES_STATE_ID);
      this.s.componentState.delete(ZONES_STATE_ID);
    }
    this.published = false;
    this.dirty = false;
    this.rev = 0;
    this.messageId = 0;
  }

  /** Is there anything worth saving in a snapshot? (A scene without races, scores or respawn points saves nothing.) */
  hasState(): boolean {
    return (
      this.races.raceNames.length > 0 ||
      this.score.total !== 0 ||
      this.message !== null ||
      this.respawnPoints.size > 0 ||
      this.respawnCounts.size > 0 ||
      this.immune.size > 0 ||
      this.pending.length > 0 ||
      this.spawned.size > 0 ||
      this.bornAt.size > 0
    );
  }

  save(): unknown {
    return {
      races: this.races.save(),
      score: this.score,
      message: this.message,
      messageId: this.messageId,
      rev: this.rev,
      respawnPoints: [...this.respawnPoints.values()],
      respawnCounts: [...this.respawnCounts],
      immune: [...this.immune],
      pending: this.pending,
      bornAt: [...this.bornAt],
      spawned: [...this.spawned],
    };
  }

  load(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    this.races.load(d.races);
    const score = d.score as { total?: number; byRacer?: Record<string, number> } | undefined;
    this.score = { total: score?.total ?? 0, byRacer: { ...(score?.byRacer ?? {}) } };
    this.message = (d.message as ZonesPublic['message']) ?? null;
    this.messageId = typeof d.messageId === 'number' ? d.messageId : 0;
    this.rev = typeof d.rev === 'number' ? d.rev : 0;
    this.respawnPoints = new Map(((d.respawnPoints as Pose[]) ?? []).map((p) => [p.id, p]));
    this.respawnCounts = new Map((d.respawnCounts as [string, number][]) ?? []);
    this.immune = new Map((d.immune as [string, number][]) ?? []);
    this.pending = (d.pending as PendingRespawn[]) ?? [];
    this.bornAt = new Map((d.bornAt as [string, number][]) ?? []);
    this.spawned = new Map((d.spawned as [string, SpawnedRec][]) ?? []);
    // The page dropped the old entry when the world was rebuilt: write the restored one now, not after the next step.
    this.dirty = true;
    this.publish(false); // same revision as when it was saved: a replay publishes exactly what the first run did
  }

  /** Empty published state (used by the page before the first frame). */
  static empty(): ZonesPublic {
    return emptyZonesState();
  }
}

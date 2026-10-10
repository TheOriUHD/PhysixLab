/**
 * PhysicsWorld — the simulation core (façade).
 *
 * Wraps a Rapier (WASM) world and knows how to build it from a SceneDocument, apply live
 * edits, advance it with a fixed timestep + interpolation, and report poses, joint state and
 * energy. It has no DOM / worker dependencies, so it runs identically inside the physics
 * worker and in Node (the unit tests drive it directly).
 *
 * This class is deliberately thin: it owns one `WorldState` and delegates every method to the module
 * that implements the concern (see the table in `index.ts`). The public API is the contract used by
 * the worker and the tests; the modules are free to change behind it.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Quat, Vec3 } from '../../core/math';
import { pathCurveOf } from '../../model/path';
import type { BodyEntity, JointEntity, SceneDocument, SceneSettings, SoftEntity } from '../../model/types';
import '../components'; // registers the built-in component runtimes
import { ComponentHost } from '../components/host';
import { dispatchCustom } from '../custom';
import type {
  BuiltInfo,
  ComponentStateEntry,
  EventConfig,
  RayHit,
  RaycastOptions,
  RaycastResult,
  SimEvent,
  SimOp,
  SimStats,
  SoftLayoutEntry,
  WorldSnapshot,
} from '../protocol';
import { addBody } from './bodies';
import { removeEntities, setVelocity, teleport, updateBody } from './edits';
import { configureEvents } from './events';
import { addJoint, updateJoint } from './joints';
import { applyOp } from './ops';
import { raycast } from './queries';
import { initRapier } from './rapier';
import { drainEvents, readContacts, readJoints, readPoses } from './readback';
import { restoreSnapshot, takeSnapshot } from './snapshot';
import { applySettings } from './settings';
import { addSoft, readSoft } from './soft';
import { WorldState, type BodyRec, type JointRec } from './state';
import { advance, alpha, fixedDt, stepManual, stepOnce } from './stepping';
import { builtInfo, getJointRec, getPose, stats } from './stats';
import { rv } from './util';

export class PhysicsWorld {
  private readonly s: WorldState;

  static async create(doc: SceneDocument): Promise<PhysicsWorld> {
    await initRapier();
    return new PhysicsWorld(doc);
  }

  /** Requires initRapier() to have resolved. */
  constructor(doc: SceneDocument) {
    const world = new RAPIER.World(rv(doc.settings.gravity));
    const worldBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.s = new WorldState(world, worldBody, doc.settings);
    this.s.eventQueue = new RAPIER.EventQueue(true);
    this.s.host = new ComponentHost(this.s);
    this.s.rng.seed(doc.settings.seed);
    applySettings(this.s, doc.settings, true);
    for (const e of doc.entities) if (e.kind === 'path') this.s.paths.set(e.id, { def: e, curve: pathCurveOf(e) });
    for (const e of doc.entities) if (e.kind === 'body') addBody(this.s, e, false);
    for (const e of doc.entities) if (e.kind === 'joint') addJoint(this.s, e);
    for (const e of doc.entities) if (e.kind === 'soft') addSoft(this.s, e);
    this.s.layoutVersion++;
  }

  dispose(): void {
    this.s.host.disposeAll();
    this.s.eventQueue.free();
    this.s.world.free();
  }

  /** The underlying Rapier world. */
  get world(): RAPIER.World {
    return this.s.world;
  }
  get settings(): SceneSettings {
    return this.s.settings;
  }
  set settings(v: SceneSettings) {
    this.s.settings = v;
  }
  get simTime(): number {
    return this.s.simTime;
  }
  set simTime(v: number) {
    this.s.simTime = v;
  }
  get stepCount(): number {
    return this.s.stepCount;
  }
  set stepCount(v: number) {
    this.s.stepCount = v;
  }
  /** Bumped whenever the set of bodies / joints / soft bodies changes (the worker announces new id lists). */
  get layoutVersion(): number {
    return this.s.layoutVersion;
  }
  set layoutVersion(v: number) {
    this.s.layoutVersion = v;
  }
  get fixedDt(): number {
    return fixedDt(this.s);
  }
  /** Fixed-step interpolation factor for the current accumulator. */
  get alpha(): number {
    return alpha(this.s);
  }
  get bodyIds(): string[] {
    return this.s.order.map((r) => r.id);
  }
  get jointIds(): string[] {
    return this.s.jointOrder.map((r) => r.id);
  }

  // construction and live edits ---------------------------------------------------------------

  addBody(def: BodyEntity, ephemeral: boolean): BodyRec {
    return addBody(this.s, def, ephemeral);
  }
  addJoint(def: JointEntity): JointRec | null {
    return addJoint(this.s, def);
  }
  addSoft(def: SoftEntity): void {
    addSoft(this.s, def);
  }
  removeEntities(ids: string[]): void {
    removeEntities(this.s, ids);
  }
  updateBody(next: BodyEntity): void {
    updateBody(this.s, next);
  }
  updateJoint(next: JointEntity): void {
    updateJoint(this.s, next);
  }
  applySettings(next: SceneSettings, initial = false): void {
    applySettings(this.s, next, initial);
  }
  teleport(id: string, position: Vec3, rotation: Quat, keepVelocity = false): void {
    teleport(this.s, id, position, rotation, keepVelocity);
  }
  setVelocity(id: string, lin: Vec3, ang: Vec3): void {
    setVelocity(this.s, id, lin, ang);
  }
  applyOp(op: SimOp): void {
    applyOp(this.s, op);
  }

  // stepping ----------------------------------------------------------------------------------

  setKeys(keys: Iterable<string>): void {
    this.s.keys = new Set(keys);
  }
  /** Analog inputs by name (replaces the previous set). */
  setAxes(axes: Record<string, number>): void {
    this.s.axes = axes;
  }
  /** Advance the simulation by exactly one fixed step. */
  stepOnce(): void {
    stepOnce(this.s);
  }
  /**
   * Advance by wall-clock time (scaled), interpolating the remainder. Returns the number of
   * fixed steps taken. `budgetMs` bounds the work done in one call (the sim then falls behind
   * real time instead of freezing the worker).
   */
  advance(realDt: number, timeScale: number, budgetMs = 28): number {
    return advance(this.s, realDt, timeScale, budgetMs);
  }
  /** Manual stepping (paused): render the exact post-step state. */
  stepManual(n: number): void {
    stepManual(this.s, n);
  }

  // readout -----------------------------------------------------------------------------------

  readPoses(alphaValue: number, out?: Float32Array): Float32Array {
    return readPoses(this.s, alphaValue, out);
  }
  readJoints(out?: Float32Array): Float32Array {
    return readJoints(this.s, out);
  }
  /**
   * Snapshot of every soft body's particles. `layout` is returned only when the topology changed
   * (spawn, removal, tearing); positions are always returned.
   */
  readSoft(): { layout?: SoftLayoutEntry[]; positions: Float32Array } {
    return readSoft(this.s);
  }
  /** Contact points (world space) of awake bodies for the contact overlay. */
  readContacts(max = 800): Float32Array {
    return readContacts(this.s, max);
  }
  drainEvents(): SimEvent[] {
    return drainEvents(this.s);
  }
  // protocol v2 --------------------------------------------------------------------------------

  /** Uniform [0, 1) from the world's seeded generator (`settings.seed`, `setSeed`). */
  random(): number {
    return this.s.rng.next();
  }
  setSeed(seed: number): void {
    this.s.rng.seed(seed);
  }
  /** The generator state, for tests and snapshots. */
  get rngState(): number {
    return this.s.rng.state;
  }
  raycast(origin: Vec3, dir: Vec3, maxDist: number, options?: RaycastOptions): RayHit | null {
    return raycast(this.s, origin, dir, maxDist, options);
  }
  configureEvents(patch: Partial<EventConfig>): void {
    configureEvents(this.s, patch);
  }
  /** Capture the complete simulation state (see `WorldSnapshot`). */
  snapshot(): WorldSnapshot {
    return takeSnapshot(this.s);
  }
  /** Replace the world's contents by a snapshot. */
  restore(snapshot: WorldSnapshot): void {
    restoreSnapshot(this.s, snapshot);
  }
  /** Run the handler of a custom channel; returns its replies. */
  custom(channel: string, data: unknown): { channel: string; data: unknown }[] {
    return dispatchCustom(this, channel, data);
  }
  /** Ids of the components that exist in the world (running or not), per owner. */
  componentsOf(ownerId: string): string[] {
    return this.s.host.componentsOf(ownerId);
  }
  isComponentRunning(componentId: string): boolean {
    return this.s.host.isRunning(componentId);
  }
  /** The component state published since the last call, and the ids of components that went away. */
  drainComponentState(): { changed: Record<string, ComponentStateEntry>; removed: string[] } {
    return this.s.host.drainState();
  }
  /** Answers to `raycast` ops and `snapshot` ops since the last call. */
  drainReplies(): { raycasts: RaycastResult[]; snapshots: { id: number; snapshot: WorldSnapshot }[] } {
    const r = { raycasts: this.s.raycasts, snapshots: this.s.snapshots };
    this.s.raycasts = [];
    this.s.snapshots = [];
    return r;
  }
  /** Component ids that have a definition in the model but no runtime in this worker (should be empty). */
  missingRuntimes(): string[] {
    return this.s.host.missingRuntimes();
  }

  builtInfo(): BuiltInfo {
    return builtInfo(this.s);
  }
  stats(): SimStats {
    return stats(this.s);
  }
  /** Test helper: pose of a body in the live world. */
  getPose(id: string): { position: Vec3; rotation: Quat; linvel: Vec3; angvel: Vec3 } | null {
    return getPose(this.s, id);
  }
  getJointRec(id: string): { value: number; speed: number; force: number; broken: boolean } | null {
    return getJointRec(this.s, id);
  }
}

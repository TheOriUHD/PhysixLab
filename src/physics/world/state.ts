/**
 * The mutable state of one simulated world, shared by every world module.
 *
 * `PhysicsWorld` (the façade) owns exactly one `WorldState`; the other modules are collections of
 * functions that take it as their first argument. Keeping the data in one plain class (instead of
 * spreading it over a class hierarchy) keeps the hot loops monomorphic and lets each concern live in
 * its own file without exposing its internals through the public API.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Quat, Vec3 } from '../../core/math';
import { Rng } from '../../core/rng';
import type { PathCurve } from '../../model/path';
import type {
  BodyEntity,
  ColliderPart,
  JointEntity,
  PathEntity,
  SceneSettings,
  SoftAttachment,
  SoftEntity,
} from '../../model/types';
import type { ComponentHost } from '../components/host';
import {
  DEFAULT_EVENT_CONFIG,
  type ComponentStateEntry,
  type EnergyStats,
  type EventConfig,
  type RaycastResult,
  type SimEvent,
  type WorldSnapshot,
} from '../protocol';
import { RigidEnergy } from './energy';
// -- TM: the recorder (snapshot ring, input log, tracks) --
import { Recorder } from './recorder';
import { LoadTracker, type JointLoad } from './jointLoad';

export interface BodyRec {
  id: string;
  /** Creation order (deterministic ordering of events and components). */
  seq: number;
  def: BodyEntity;
  rb: RAPIER.RigidBody;
  /** The first collider (every body has at least one). */
  col: RAPIER.Collider;
  /** All colliders of the body: several for compound shapes. */
  cols: RAPIER.Collider[];
  /** The compound-body part each collider came from (null for a body without parts), parallel to `cols`. */
  colParts: (ColliderPart | null)[];
  mass: number;
  ephemeral: boolean;
  disabled: boolean;
  /** Pose before the most recent step, for render interpolation. */
  prev: Float64Array; // px py pz qx qy qz qw
  hasPrev: boolean;
  vPrev: Vec3;
  force: Vec3;
  forced: boolean;
  /** Quadratic drag is active (dynamic body with a non-zero drag coefficient). */
  dragged: boolean;
  /** JT-31: this body is a one-way platform (the contact hook consults it). */
  oneWay?: boolean;
  /** Emulated sleep threshold (see dynamics.ts); null = the engine's own sleeping applies. */
  sleep: { threshold: number; radius: number; calm: number } | null;
}

/** Who owns an engine collider: a body (and the compound part it came from), or the ground slab. */
export interface ColliderOwner {
  /** Body id, or `GROUND_ID`. */
  id: string;
  part: string | undefined;
  /** The live record (null for the ground, and for a collider whose body was just removed). */
  rec: BodyRec | null;
  /** Detects overlaps instead of colliding: its events are `sensor` events. */
  sensor: boolean;
}

/** A path the components can follow, evaluated in world space. */
export interface PathRec {
  def: PathEntity;
  curve: PathCurve;
}

/** A contact that started and is waiting to be reported (strongest values seen so far). */
export interface PendingContact {
  h1: number;
  h2: number;
  o1: ColliderOwner;
  o2: ColliderOwner;
  t: number;
  count: number;
  impulse: number;
  speed: number;
  point: Vec3;
  /** Unit normal pointing out of collider 2 toward collider 1. */
  normal: Vec3;
}

/** What a component last published (`ctx.state`); `version` counts changes, `sent` the last one the page got. */
export interface StateRec {
  entry: ComponentStateEntry;
  version: number;
  sent: number;
}

export interface SoftRec {
  id: string;
  def: SoftEntity;
  root: RAPIER.SoftBody;
  // -- SF: attachment bookkeeping and runtime pressure --
  /** World positions of the particles right after construction (null after a snapshot restore: current positions are used). */
  rest: Float32Array | null;
  /** Resolved attachments: which engine particles are fastened to which rigid body. */
  attached: SoftAttached[];
  /** Attachment ids already released (broken joint, removed body, tool) — never re-fastened until the body is rebuilt. */
  released: Set<string>;
  /** Current target volume factor (decays with `def.leakRate`). */
  volumeFactor: number;
  /** Cached rest lengths per engine soft body (handle:topologyVersion) for the elastic energy. */
  restLen: Map<number, SoftEdgeCache>;
}

import type { SoftEdgeCache } from './energy';

export interface SoftAttached {
  att: SoftAttachment;
  particles: number[];
  /** Engine handle of the rigid body the particles were attached to (detects a rebuilt body). */
  bodyHandle: number;
}

export interface JointRec {
  id: string;
  def: JointEntity;
  joint: RAPIER.ImpulseJoint | null;
  A: BodyRec | null;
  B: BodyRec | null;
  /** Local anchors actually used (B's derived for rigid joints). */
  aA: Vec3;
  aB: Vec3;
  frameA: Quat;
  frameB: Quat;
  broken: boolean;
  angle: number; // unwrapped hinge angle
  lastTwist: number;
  value: number;
  speed: number;
  force: number;
  motorTarget: number; // slewed position-motor target
  cache: [number, number, number]; // last (mode-specific) motor parameters sent to the engine
  // -- JT-A: per-type runtime values of the coupling constraints (couplings.ts): rope length, unwrapped angle, … --
  rt: number[];
  // -- JT-B: estimated load / fatigue (created by the estimator) --
  jl?: JointLoad;
}

export class WorldState {
  /** Replaced wholesale by `restoreSnapshot`. */
  world: RAPIER.World;
  /** Fixed, immovable body that joints attach to when one side is "the world". */
  worldBody: RAPIER.RigidBody;
  settings: SceneSettings;
  simTime = 0;
  stepCount = 0;
  layoutVersion = 0;

  bodies = new Map<string, BodyRec>();
  order: BodyRec[] = [];
  /** Bodies with quadratic drag / an emulated sleep threshold: the per-step loops visit only these. */
  draggers: BodyRec[] = [];
  sleepers: BodyRec[] = [];
  joints = new Map<string, JointRec>();
  jointOrder: JointRec[] = [];
  ground: { body: RAPIER.RigidBody; col: RAPIER.Collider } | null = null;
  softs = new Map<string, SoftRec>();
  softOrder: SoftRec[] = [];
  softBlocks: RAPIER.SoftBody[][] = [];
  softSig = '';
  softGrab: { body: RAPIER.SoftBody; local: number; target: Vec3; strength: number } | null = null;
  softParticles = 0;
  /** Unconsumed wall-clock time (scaled), in seconds, for the fixed-step accumulator. */
  acc = 0;
  keys = new Set<string>();
  /** Analog inputs by name (supplied with every tick). */
  axes: Record<string, number> = {};
  /** The world's seeded random number generator (`settings.seed`). */
  readonly rng = new Rng(1);
  /** Time travel: snapshot ring, input log, recordings, tracks (package TM). */
  readonly recorder = new Recorder();
  bodySeq = 0;
  /** Collider handle → owner, for events, ray casts and contact queries. */
  owners = new Map<number, ColliderOwner>();
  /** Owners of colliders removed since the last drain, so their final `exit` events can still name them. */
  retired = new Map<number, ColliderOwner>();
  paths = new Map<string, PathRec>();
  eventQueue!: RAPIER.EventQueue;
  eventCfg: EventConfig = { ...DEFAULT_EVENT_CONFIG };
  /** Components that asked for contact events (`ctx.watchContacts`). */
  contactWatchers = 0;
  pendingContacts = new Map<string, PendingContact>();
  /** Contacts that started in the current fixed step (offered to watching components at its end). */
  freshContacts: PendingContact[] = [];
  /** Simulation time of the last event reported for a collider pair. */
  lastContactAt = new Map<string, number>();
  /** Bodies were added / removed / moved since the last step: the engine's query structures are stale. */
  queriesDirty = false;
  raycasts: RaycastResult[] = [];
  snapshots: { id: number; snapshot: WorldSnapshot }[] = [];
  /** Component state published since the last frame, by component id. */
  componentState = new Map<string, StateRec>();
  componentStateRemoved: string[] = [];
  /** Component runtimes (created by `PhysicsWorld`). */
  host!: ComponentHost;
  // -- ED-B: grab strength, spin, frozen bodies --
  grab: { rec: BodyRec; local: Vec3; target: Vec3; strength: number; spin: Vec3 } | null = null;
  /** Bodies frozen in place with the grab tool (F while holding); cleared when the world is rebuilt. */
  frozen = new Set<string>();
  events: SimEvent[] = [];
  stepMsEma = 0;
  rtf = 1;
  lastEnergy: EnergyStats = { kinetic: 0, rotational: 0, potential: 0, elastic: 0, momentum: [0, 0, 0] };
  lastContacts = 0;
  awakeCount = 0;
  /** Scratch accumulator reused by every readPoses pass. */
  readonly rigidEnergy = new RigidEnergy();
  /** Simulated seconds since the last readPoses (the force estimate divides by it). */
  simSinceRead = 0;
  // -- JT-B: joint load estimation / breakage state --
  readonly loads = new LoadTracker();
  /** JT-31: how many one-way platforms exist (the engine only gets the hook while there are some). */
  oneWayCount = 0;
  hooks: RAPIER.PhysicsHooks | null = null;

  constructor(world: RAPIER.World, worldBody: RAPIER.RigidBody, settings: SceneSettings) {
    this.world = world;
    this.worldBody = worldBody;
    this.settings = settings;
  }
}

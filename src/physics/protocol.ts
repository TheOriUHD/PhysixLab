/**
 * Messages exchanged between the main thread (SimClient) and the physics worker.
 * The worker owns the Rapier world; the main thread owns the scene document.
 *
 * Protocol v2 (`PROTOCOL_VERSION`) — what a package can rely on:
 *
 *  - **Inputs**: every `tick` carries the pressed `keys` and the analog `axes` (`Record<name, number>`, usually −1 … 1;
 *    `SimClient.setAxis`). Components read them through `ctx.input`.
 *  - **Events** (`SimEvent`, delivered in `frame.events` and re-emitted by `SimClient` as `'event'`):
 *      `contact`  two bodies (or a body and the ground) started touching — ids, point, normal, impulse, estimated
 *                 approach speed and the materials involved. Off by default (`SimOp 'events'` switches it on);
 *                 aggregated per pair and rate-limited, see `EventConfig`.
 *      `sensor`   a body entered / left a sensor collider (a compound part with `sensor`, or a ghost body). Always on.
 *      `component` a component's own notification (`ctx.emit`). Zones raise them with `type: 'zone'` (enter, exit, stay,
 *                 checkpoint, lap, finish, kill, respawn, teleport, launch, spawn, sound, score … — names and payloads in
 *                 `model/zones.ts`), the world bounds with `type: 'bounds'` (kill, respawn); the race standings and the score
 *                 are published as component state `@zones`.
 *      `jointBroken` a breakable joint failed.
 *  - **Component state**: a component publishes numbers (`ctx.state.set`) or JSON (`ctx.state.setJson`) that the
 *    page reads by component id (`SimClient.stateOf`) — gauges, sensors, readouts. Only changes are sent.
 *  - **Queries**: `SimOp 'raycast'` is a request answered in a later frame (`SimClient.raycast` wraps it in a Promise).
 *  - **Determinism**: the world owns a seeded RNG (`SceneSettings.seed`, `SimOp 'setSeed'`); `SimOp 'snapshot'` /
 *    `'restore'` capture and bring back the complete simulation state (rigid bodies, joints, soft bodies, RNG,
 *    component state) for time travel and replays.
 *  - **Custom channel**: `{ type: 'custom', channel, data }` in both directions for packages that need a private
 *    conversation with the worker (handlers: `src/physics/custom.ts`).
 */
import type { Quat, Vec3 } from '../core/math';
import type { BodyEntity, JointEntity, PathEntity, SceneDocument, SceneSettings, SoftEntity } from '../model/types';

/** Bumped when a message changes shape incompatibly; the worker announces it in `ready`. */
export const PROTOCOL_VERSION = 2;

/** The id contact events use for the ground slab (it is not an entity). */
export const GROUND_ID = '$ground';

/** Floats per body in the pose buffer. */
export const BODY_STRIDE = 18;
/** Offsets inside one body record. */
export const B = {
  px: 0,
  py: 1,
  pz: 2,
  qx: 3,
  qy: 4,
  qz: 5,
  qw: 6,
  vx: 7,
  vy: 8,
  vz: 9,
  wx: 10,
  wy: 11,
  wz: 12,
  fx: 13,
  fy: 14,
  fz: 15, // average net force over the last frame (N): m·Δv/Δt
  state: 16, // 0 awake, 1 sleeping, 2 disabled (fell out of the world)
  ke: 17, // kinetic energy (J), linear + rotational
} as const;

/** Floats per joint in the joint-state buffer. */
export const JOINT_STRIDE = 4;
export const J = {
  value: 0, // hinge: angle (rad) · slider: position (m) · spring/rope: length (m)
  speed: 1, // matching rate of change
  force: 2, // spring: force along the spring (N, + = tension); rope: tension estimate (N)
  broken: 3, // 1 once the joint has failed
} as const;

/** Floats per contact point in the contact buffer. */
export const CONTACT_STRIDE = 7; // x y z nx ny nz force

export type SimOp =
  | { op: 'addBody'; body: BodyEntity; ephemeral?: boolean }
  | { op: 'addJoint'; joint: JointEntity }
  | { op: 'remove'; ids: string[] }
  | { op: 'updateBody'; body: BodyEntity }
  | { op: 'updateJoint'; joint: JointEntity }
  | { op: 'settings'; settings: SceneSettings }
  | { op: 'teleport'; id: string; position: Vec3; rotation: Quat; keepVelocity?: boolean }
  | { op: 'setVelocity'; id: string; linvel: Vec3; angvel: Vec3 }
  | { op: 'grab'; id: string; point: Vec3; target: Vec3 }
  | { op: 'grabMove'; target: Vec3 }
  | { op: 'release' }
  | { op: 'impulse'; id: string; impulse: Vec3; point: Vec3 }
  | { op: 'explode'; center: Vec3; strength: number; radius: number }
  | { op: 'addSoft'; soft: SoftEntity }
  | { op: 'updateSoft'; soft: SoftEntity }
  | { op: 'grabSoft'; id: string; index: number; target: Vec3 }
  | { op: 'wakeAll' }
  // ── protocol v2 ──
  /** Re-seed the world's random number generator. */
  | { op: 'setSeed'; seed: number }
  /** Cast a ray; the answer arrives in `frame.raycasts` with the same `id` (see `SimClient.raycast`). */
  | { op: 'raycast'; id: number; origin: Vec3; dir: Vec3; maxDist: number; options?: RaycastOptions }
  /** Capture the world state; the answer arrives in `frame.snapshots` with the same `id`. */
  | { op: 'snapshot'; id: number }
  /** Replace the world state by a snapshot taken from this scene (see `WorldSnapshot`). */
  | { op: 'restore'; snapshot: WorldSnapshot }
  /** Change how contact events are generated (`EventConfig`). */
  | { op: 'events'; config: Partial<EventConfig> }
  /** Add or replace a path the components can follow (`ctx.path`). Removal goes through `remove`. */
  | { op: 'setPath'; path: PathEntity };

export type ToWorker =
  | { type: 'build'; doc: SceneDocument }
  | { type: 'ops'; ops: SimOp[] }
  | {
      type: 'tick';
      /** Wall-clock seconds since the previous tick. */
      dt: number;
      timeScale: number;
      running: boolean;
      /** Single-step this many fixed steps regardless of `running`. */
      stepCount: number;
      keys: string[];
      /** Analog inputs by name (protocol v2). */
      axes: Record<string, number>;
      wantContacts: boolean;
    }
  /** A package-defined message for a handler registered with `registerCustomChannel` (protocol v2). */
  | { type: 'custom'; channel: string; data: unknown }
  | { type: 'dispose' };

export interface EnergyStats {
  kinetic: number;
  rotational: number;
  potential: number;
  elastic: number;
  momentum: Vec3;
}

/** Triangle (jelly, balloon, cloth) or line-segment (cable) topology of one soft body. */
export interface SoftLayoutEntry {
  id: string;
  mode: 'tri' | 'line';
  /** Total particles (all pieces after tearing); positions are concatenated in this order. */
  count: number;
  indices: Uint32Array;
}

export interface SimStats {
  simTime: number;
  stepCount: number;
  /** Average milliseconds of physics time per fixed step (smoothed). */
  stepMs: number;
  bodies: number;
  awake: number;
  /** Soft-body particle count (all soft bodies). */
  particles: number;
  contacts: number;
  /** Simulated seconds advanced per wall-clock second divided by the requested time scale. */
  realtimeFactor: number;
  energy: EnergyStats;
}

export interface BuiltInfo {
  /** Mass (kg) per body id; 0 for static / kinematic. */
  mass: Record<string, number>;
  /** Centre of mass offset (local) per body id. */
  com: Record<string, Vec3>;
}

export type FromWorker =
  | { type: 'ready'; protocol: number }
  | { type: 'built'; info: BuiltInfo }
  | {
      type: 'frame';
      poses: Float32Array;
      /** Present only when the set of simulated bodies / joints changed. */
      bodyIds?: string[];
      jointIds?: string[];
      joints: Float32Array;
      /** Present when a soft body was added / removed / torn. */
      softLayout?: SoftLayoutEntry[];
      /** xyz per particle, entities concatenated in `softLayout` order. */
      softPositions?: Float32Array;
      contacts?: Float32Array;
      stats: SimStats;
      events: SimEvent[];
      info?: BuiltInfo;
      /** Component state that changed since the previous frame, by component id (protocol v2). */
      componentState?: Record<string, ComponentStateEntry>;
      /** Components that no longer exist (their state entries should be dropped). */
      componentStateRemoved?: string[];
      /** Answers to `raycast` ops (protocol v2). */
      raycasts?: RaycastResult[];
      /** Answers to `snapshot` ops (protocol v2). */
      snapshots?: { id: number; snapshot: WorldSnapshot }[];
    }
  /** Reply of a custom-channel handler (protocol v2). */
  | { type: 'custom'; channel: string; data: unknown }
  | { type: 'error'; message: string };

// ── events ──────────────────────────────────────────────────────────────────────────────────────────

/** Two bodies (or a body and the ground) started touching. */
export interface ContactEvent {
  kind: 'contact';
  /** Simulation time of the step in which the contact started. */
  t: number;
  /** The pair, ordered: the ground (`GROUND_ID`) is always `b`; otherwise `a` is the older body. */
  a: string;
  b: string;
  /** Contact point, world space. */
  point: Vec3;
  /** Unit normal pointing out of `b` toward `a` (the direction `b` pushes `a`). */
  normal: Vec3;
  /** Total normal impulse of the contact, N·s (the largest seen while the event was pending). */
  impulse: number;
  /**
   * Approach speed along the normal, m/s, estimated from the impulse and the pair's effective mass and
   * restitution (`J / (m_eff · (1 + e))`): exact for a central impact, approximate when the contact point is
   * off-centre or the bodies spin fast.
   */
  speed: number;
  /** Material preset names of the two bodies (`'ground'` for the ground slab). */
  matA: string;
  matB: string;
  /** How many raw contacts were merged into this event (aggregation within one frame). */
  count: number;
}

/** A body entered or left a sensor collider. */
export interface SensorEvent {
  kind: 'sensor';
  phase: 'enter' | 'exit';
  t: number;
  /** The body that owns the sensor collider, and the compound part it belongs to (if any). */
  sensor: string;
  part?: string;
  /** The body that entered / left. */
  other: string;
}

/** A notification a component raised with `ctx.emit`. */
export interface ComponentEvent {
  kind: 'component';
  t: number;
  /** Id of the body or joint that owns the component, the component's id and type. */
  owner: string;
  component: string;
  type: string;
  /** Event name the component chose ("triggered", "lap" …) and its JSON-serialisable payload. */
  name: string;
  data?: unknown;
}

export type SimEvent = { kind: 'jointBroken'; id: string; force: number } | ContactEvent | SensorEvent | ComponentEvent;

/**
 * Contact-event generation. Contact events cost a little per new contact, so they are off until something asks:
 * `{ op: 'events', config: { contacts: true } }`, or a component calling `ctx.watchContacts()`. Events are
 * aggregated per body pair within a frame (the strongest impulse wins, `count` says how many were merged), a pair
 * reports at most once per `pairInterval` simulated seconds, contacts weaker than `minImpulse` are ignored, and at
 * most `maxPerFrame` events leave the worker per frame (the strongest ones).
 */
export interface EventConfig {
  contacts: boolean;
  /** Smallest normal impulse (N·s) that is reported. */
  minImpulse: number;
  /** Minimum simulated time between two events of the same pair, seconds. */
  pairInterval: number;
  maxPerFrame: number;
}

export const DEFAULT_EVENT_CONFIG: EventConfig = {
  contacts: false,
  minImpulse: 0.02,
  pairInterval: 0.1,
  maxPerFrame: 64,
};

// ── queries ─────────────────────────────────────────────────────────────────────────────────────────

export interface RaycastOptions {
  /** Bodies the ray passes through. */
  ignore?: string[];
  /** Also hit sensor colliders (default: no). */
  sensors?: boolean;
  /** Hit a collider the ray starts inside at distance 0 (default: yes). */
  solid?: boolean;
}

export interface RayHit {
  /** The body that was hit (`GROUND_ID` for the ground) and its compound part, if any. */
  id: string;
  part?: string;
  /** Distance from the origin along the (normalised) direction, metres. */
  distance: number;
  point: Vec3;
  /** Surface normal at the hit, unit length, facing the ray origin. */
  normal: Vec3;
}

export interface RaycastResult {
  id: number;
  /** Null when nothing was hit within `maxDist`. */
  hit: RayHit | null;
}

// ── component state ─────────────────────────────────────────────────────────────────────────────────

/** The latest values a component published (`ctx.state`). */
export interface ComponentStateEntry {
  owner: string;
  type: string;
  /** Numbers set with `ctx.state.set` (null if the component only publishes JSON). */
  values: Float32Array | null;
  /** The value set with `ctx.state.setJson`. */
  json?: unknown;
}

// ── snapshots ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The complete state of a simulated world — enough to bring it back exactly (`SimOp 'restore'`). It is plain
 * data (a byte array and JSON), so it survives `postMessage` and can be stored.
 *
 * What is captured: the physics engine's own state (`rapier`: every rigid body, collider, joint, the contact caches
 * and — because the engine serialises them — the soft bodies), the bookkeeping that maps ids to those engine handles
 * (`bodies`, `joints`, `softs`), the clock, the RNG state, the paths, and the state components choose to save.
 * What is not: the mouse grab (released), pending events, key / axis input (supplied again by the next tick).
 * Restoring a snapshot into a world built from a *different* scene replaces that world's contents by the snapshot's.
 */
export interface WorldSnapshot {
  version: 1;
  rapier: Uint8Array;
  simTime: number;
  stepCount: number;
  acc: number;
  rng: number;
  settings: SceneSettings;
  bodies: BodySnapshot[];
  joints: JointSnapshot[];
  softs: { def: SoftEntity; root: number }[];
  paths: PathEntity[];
  /** Engine handle of the fixed body world-anchored joints attach to, and of the ground slab (if enabled). */
  worldBody: number;
  ground: { body: number; collider: number } | null;
  /** State saved by components (`saveState`), by component id. */
  components: Record<string, unknown>;
}

export interface BodySnapshot {
  def: BodyEntity;
  ephemeral: boolean;
  disabled: boolean;
  /** Engine handles of the rigid body and its colliders (parallel to the colliders the definition builds). */
  rb: number;
  cols: number[];
  /** Id of the compound part each collider came from (null for the body's own shape), parallel to `cols`. */
  colParts: (string | null)[];
  mass: number;
  prev: number[];
  hasPrev: boolean;
  vPrev: Vec3;
  forced: boolean;
  /** Emulated sleep state (`calm` seconds below the threshold), or null. */
  sleepCalm: number | null;
}

export interface JointSnapshot {
  def: JointEntity;
  /** Engine handle, or null once the joint broke. */
  handle: number | null;
  aA: Vec3;
  aB: Vec3;
  frameA: Quat;
  frameB: Quat;
  broken: boolean;
  angle: number;
  lastTwist: number;
  value: number;
  speed: number;
  force: number;
  motorTarget: number;
  /** -- JT-A: runtime values of the coupling constraints (absent in older snapshots). -- */
  rt?: number[];
  cache: [number, number, number];
}

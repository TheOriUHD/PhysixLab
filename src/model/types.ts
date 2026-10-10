/**
 * The PhysicsLab scene document.
 *
 * The document is the single source of truth for what the user has built. It is plain,
 * JSON-serializable data. The physics worker builds a Rapier world from it, the renderer
 * mirrors it, and the UI edits it through SceneStore (which keeps it immutable + undoable).
 */
import type { Quat, Vec3 } from '../core/math';

export type { Quat, Vec3 };

/** Id of a shape registered in `shapeRegistry.ts` ('box', 'sphere', …). Unknown ids are repaired on load. */
export type ShapeType = string;

/** Value of one shape parameter: ints / floats are numbers, flags are booleans, enums are strings. */
export type ParamValue = number | boolean | string;
export type ShapeParams = Record<string, ParamValue>;

/**
 * Shapes are parameterised by a bounding size [x, y, z] in metres (full extents) plus the optional,
 * shape-specific `params` declared by the shape's registry entry (e.g. the prism's `sides`). What the size
 * axes mean is up to the shape — for the built-in ones:
 *  - box / wedge: width, height, depth
 *  - sphere: diameter = x (y, z follow)
 *  - cylinder / cone: diameter = x (= z), height = y
 *  - capsule: diameter = x (= z), total height = y
 *  - prism: regular N-gon in the XZ plane (diameter x, z), height y, `sides` sides
 *  - icosahedron: ellipsoid-scaled regular icosahedron
 */
export interface ShapeSpec {
  type: ShapeType;
  size: Vec3;
  /** Parameters from the shape's schema; shapes without a schema have none. */
  params?: ShapeParams;
}

export type BodyType = 'dynamic' | 'static' | 'kinematic';

export interface MaterialSpec {
  /** Name of the preset this was derived from ('custom' when edited by hand). */
  preset: string;
  /** kg / m³ */
  density: number;
  friction: number;
  restitution: number;
  color: string;
  metalness: number;
  roughness: number;
  opacity: number;
}

/** A constant force/torque (expressed in the body's local frame) — thrusters, rockets, fans. */
export interface ThrustSpec {
  force: Vec3;
  torque: Vec3;
  /** 'always' applies every step; 'key' only while `key` (KeyboardEvent.code) is held. */
  mode: 'always' | 'key';
  key: string;
}

export interface BodyEntity {
  kind: 'body';
  id: string;
  name: string;
  shape: ShapeSpec;
  position: Vec3;
  rotation: Quat;
  bodyType: BodyType;
  material: MaterialSpec;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  ccd: boolean;
  canSleep: boolean;
  /** Initial linear velocity (dynamic) or constant velocity (kinematic), world space, m/s. */
  velocity: Vec3;
  /** Initial angular velocity (dynamic) or constant spin (kinematic), world space, rad/s. */
  angularVelocity: Vec3;
  /** Axis locks in world space (dynamic bodies only). */
  lockPosition: [boolean, boolean, boolean];
  lockRotation: [boolean, boolean, boolean];
  thrust: ThrustSpec | null;
  /** Ghost bodies keep their mass but pass through everything (no collisions). */
  ghost: boolean;
  /** Editor-only flags. */
  locked: boolean;
  hidden: boolean;

  // ── FB-5: collision filtering, drag, mass overrides, organisation ──────────────────────────────
  /** Which bodies this one collides with. */
  collision: CollisionSpec;
  /** Quadratic (v²) air / fluid resistance, applied every engine step. */
  drag: DragSpec;
  /** Total mass in kg, replacing density × volume (the mass distribution keeps the shape's proportions). */
  massOverride?: number;
  /** Centre of mass in the body's local frame, replacing the computed one (the inertia tensor is kept). */
  comOverride?: Vec3;
  /** Multiplies the principal moments of inertia: < 1 spins up easily, > 1 resists rotation. */
  inertiaScale: number;
  /** Speed (m/s) below which the body may fall asleep. Unset = the engine's default. */
  sleepThreshold?: number;
  /** Free-form labels for later features (zones, scripts, selection sets). */
  tags: string[];
  /** Named layer for editor visibility / selection filters. */
  layer: string;
  /** Id of the entity this one is grouped under. */
  parent?: string;
}

/**
 * Collision filter. A body is a member of exactly one of 16 groups (`group`, 0–15) and collides only with
 * bodies whose group is set in its `mask` (16-bit set), and vice versa. The default — group 0, every group
 * in the mask — collides with everything. The ground slab is a member of group 0.
 */
export interface CollisionSpec {
  group: number;
  mask: number;
}

/** F = −c·|v|·v and τ = −c·|ω|·ω: `linear2` in N·s²/m², `angular2` in N·m·s². */
export interface DragSpec {
  linear2: number;
  angular2: number;
}

export type JointType = 'fixed' | 'hinge' | 'slider' | 'ball' | 'spring' | 'rope';

export type MotorMode = 'off' | 'velocity' | 'position';

export interface MotorSpec {
  mode: MotorMode;
  /** rad/s (hinge) or m/s (slider) at full input. */
  targetVelocity: number;
  /** rad (hinge) or m (slider). With a key bound it is the deflection at full input. */
  targetPosition: number;
  /** N/m or N·m/rad — position mode spring gain. */
  stiffness: number;
  /** N·s/m or N·m·s/rad — velocity-mode gain / position-mode damping. */
  damping: number;
  /** Max force (N) or torque (N·m) the motor can deliver. */
  maxForce: number;
  /** KeyboardEvent.code that drives the motor in the + / − direction. Empty = none. */
  keyPos: string;
  keyNeg: string;
  /** Position mode with keys: how quickly the target slews (units / s). */
  slewRate: number;
  /** Velocity mode with keys: hold the joint (brake) when no key is down. */
  brake: boolean;
}

export interface LimitSpec {
  enabled: boolean;
  /** rad (hinge) or m (slider), relative to the pose at build time. */
  min: number;
  max: number;
}

export interface SpringSpec {
  restLength: number;
  /** N/m */
  stiffness: number;
  /** N·s/m */
  damping: number;
  /** Breaks when the spring force exceeds this many newtons (0 = unbreakable). */
  breakForce: number;
}

export interface JointEntity {
  kind: 'joint';
  id: string;
  name: string;
  type: JointType;
  /** Body ids; null attaches that side to the (immovable) world. */
  bodyA: string | null;
  bodyB: string | null;
  /** Anchor in A's local frame (world frame if bodyA is null). */
  anchorA: Vec3;
  /** Anchor in B's local frame (world frame if bodyB is null). Only used by springs and ropes;
   *  for rigid joints B's anchor is derived from A's at build time. */
  anchorB: Vec3;
  /** Joint axis in A's local frame (world frame if bodyA is null). Hinge / slider only. */
  axis: Vec3;
  limit: LimitSpec;
  motor: MotorSpec;
  spring: SpringSpec;
  /** Rope length (max distance), metres. */
  ropeLength: number;
  /** Collide the two connected bodies with each other. */
  collideConnected: boolean;
  hidden: boolean;
}

/**
 * Deformable bodies (engine soft-body solver): jelly lattices, balloons, cloth and cables.
 * Particles live in the physics worker; the document only stores the recipe.
 */
export type SoftType = 'jelly' | 'balloon' | 'cloth' | 'cable';
export type SoftPin = 'none' | 'edge' | 'corners' | 'corners4' | 'one-end' | 'ends';

export interface SoftEntity {
  kind: 'soft';
  id: string;
  name: string;
  type: SoftType;
  position: Vec3;
  rotation: Quat;
  /**
   * jelly: box extents · balloon: diameter (x) · cloth: width (x) × depth (z) · cable: length (x).
   * Cloth lies in its local XZ plane, cables run along local X.
   */
  size: Vec3;
  /** Lattice density: particles per side (jelly), subdivisions (balloon), per side (cloth) or per cable. */
  resolution: number;
  /** Total mass in kg. */
  mass: number;
  /** Material stiffness as a natural frequency (Hz): higher = stiffer. */
  stiffness: number;
  /** Damping ratio of the material (0 = bouncy, 1 = heavily damped). */
  damping: number;
  pin: SoftPin;
  /** Edges tear beyond this strain (0 = cannot tear). */
  tearStrain: number;
  selfCollide: boolean;
  gravityScale: number;
  linearDamping: number;
  color: string;
  roughness: number;
  opacity: number;
  locked: boolean;
  hidden: boolean;
}

export type Entity = BodyEntity | JointEntity | SoftEntity;
export interface GroundSettings {
  enabled: boolean;
  friction: number;
  restitution: number;
  /** Half extent of the square ground slab in metres. */
  halfSize: number;
  color: string;
}

export interface SceneSettings {
  gravity: Vec3;
  ground: GroundSettings;
  /** Simulation rate in Hz (fixed step = 1 / hz). */
  physicsHz: number;
  solverIterations: number;
  /** Global linear air resistance (adds to every body's own damping), 1/s. */
  airDrag: number;

  // ── FB-11: seed, substeps, environment, bounds, units ──────────────────────────────────────────
  /** Seed of the world's random number generator (unsigned 32-bit). Stored now; stochastic features use it. */
  seed: number;
  /** Engine sub-steps per fixed step (1–16): the fixed step is divided into this many equal engine steps. */
  substeps: number;
  /** Sky / light / fog look of the scene — storage only, the renderer applies it in a later package. */
  environment: EnvironmentSettings;
  /** World bounds and what happens to bodies that leave them — storage only. */
  bounds: BoundsSettings;
  /** Display units — storage only (the engine always works in m, kg, s, rad). */
  units: UnitsSettings;
}

export type SkyPreset = 'studio' | 'day' | 'sunset' | 'night' | 'overcast';

export interface EnvironmentSettings {
  sky: SkyPreset;
  /** Solar time in hours, 0–24. */
  timeOfDay: number;
  fog: { enabled: boolean; color: string; /** Exponential density, 1/m. */ density: number };
  /** Tone-mapping exposure multiplier. */
  exposure: number;
}

export type BoundsPolicy = 'kill' | 'respawn';

export interface BoundsSettings {
  enabled: boolean;
  /** Opposite corners of the allowed box, world space. */
  min: Vec3;
  max: Vec3;
  /** 'kill' switches a body that leaves the box off; 'respawn' returns it to its starting pose. */
  policy: BoundsPolicy;
}

export type LengthUnit = 'm' | 'cm' | 'ft' | 'in';
export type MassUnit = 'kg' | 'g' | 'lb';
export type AngleUnit = 'deg' | 'rad';

export interface UnitsSettings {
  length: LengthUnit;
  mass: MassUnit;
  angle: AngleUnit;
}

// ── FB-4: asset store ───────────────────────────────────────────────────────────────────────────────
// Large binary payloads (meshes, textures, heightmaps, audio, opaque blobs) live once in `doc.assets`
// and are referenced by id. Typed arrays are stored as base64 strings so the document stays plain JSON.

export type AssetKind = 'mesh' | 'texture' | 'heightmap' | 'audio' | 'blob';

interface AssetBase {
  id: string;
  kind: AssetKind;
  /** Display name (file name, "Imported mesh", …). */
  name: string;
  /** Content hash of the payload — equal hashes mean identical content (used to dedupe). */
  hash: string;
  /** Decoded payload size in bytes (counts towards the asset size caps). */
  bytes: number;
}

export interface MeshMaterialSlot {
  name: string;
  color: string;
  metalness: number;
  roughness: number;
  opacity: number;
}

/** A run of triangles that uses one entry of `MeshAsset.materials`. */
export interface MeshGroup {
  /** First index in `indices`. */
  start: number;
  /** Number of indices (a multiple of 3). */
  count: number;
  materialIndex: number;
}

export interface MeshAsset extends AssetBase {
  kind: 'mesh';
  vertexCount: number;
  indexCount: number;
  /** base64 Float32Array, xyz per vertex. */
  positions: string;
  /** base64 Uint32Array, three vertex indices per triangle. */
  indices: string;
  /** base64 Float32Array, xyz per vertex. */
  normals?: string;
  /** base64 Float32Array, uv per vertex. */
  uvs?: string;
  materials?: MeshMaterialSlot[];
  groups?: MeshGroup[];
}

export interface TextureAsset extends AssetBase {
  kind: 'texture';
  /** `data:image/png|jpeg|webp|gif;base64,…` */
  dataUrl: string;
  width: number;
  height: number;
}

export interface HeightmapAsset extends AssetBase {
  kind: 'heightmap';
  /** Samples along x and z. */
  width: number;
  height: number;
  /** base64 Float32Array, `width × height` heights in 0–1, row-major along x. */
  heights: string;
  /** World size of the terrain: x extent, height of sample value 1, z extent (metres). */
  scale: Vec3;
}

export interface AudioAsset extends AssetBase {
  kind: 'audio';
  sampleRate: number;
  channels: number;
  /** base64 Float32Array, interleaved samples in −1…1. */
  samples: string;
}

export interface BlobAsset extends AssetBase {
  kind: 'blob';
  mime: string;
  /** base64 bytes. */
  data: string;
}

export type Asset = MeshAsset | TextureAsset | HeightmapAsset | AudioAsset | BlobAsset;

/** What callers hand to `SceneStore.addAsset`: the store assigns `id`, `hash` and `bytes`. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type AssetInput = DistributiveOmit<Asset, 'id' | 'hash' | 'bytes'>;

export interface SceneDocument {
  format: 'physicslab-scene';
  version: number;
  name: string;
  settings: SceneSettings;
  entities: Entity[];
  /** Binary payloads referenced by entities (see the asset store section above). */
  assets: Record<string, Asset>;
}

export const isBody = (e: Entity | undefined | null): e is BodyEntity => !!e && e.kind === 'body';
export const isJoint = (e: Entity | undefined | null): e is JointEntity => !!e && e.kind === 'joint';
export const isSoft = (e: Entity | undefined | null): e is SoftEntity => !!e && e.kind === 'soft';

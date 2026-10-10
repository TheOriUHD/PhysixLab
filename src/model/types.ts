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

/** A visual skin on a body: the registry id of a skin (`render/skins/registry.ts`) and its parameters. */
export interface SkinSpec {
  id: string;
  params?: Record<string, number | string | boolean>;
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

  // -- VZ-B: visual skin (VZ-42) --
  /** Render-only model drawn in place of the body's own shape (src/render/skins); the physics is unaffected. */
  skin?: SkinSpec;

  // ── FB-3: compound bodies ──────────────────────────────────────────────────────────────────────
  /**
   * Colliders of a compound body. When present they replace the body's own `shape` as colliders and as the
   * rendered geometry; `shape` stays the primary / bounding shape the editor sizes and the gizmo scales.
   * One rigid body is built with a collider per part (and per collider of a part's own shape): mass, centre
   * of mass and inertia come from all of them.
   */
  parts?: ColliderPart[];
  /** Id of a mesh in `doc.assets` that is this body's visual (collision comes from the shape or the parts). */
  meshId?: string;

  // ── FB-7: components ───────────────────────────────────────────────────────────────────────────
  /** Behaviours attached to the body (forces, movers, sensors …), run by the physics worker in array order. */
  components: ComponentSpec[];
}

// ── FB-7: component system ─────────────────────────────────────────────────────────────────────────────
// A component is a registered behaviour (`model/componentRegistry.ts`) attached to a body or joint: its `type`
// names the registry entry, `params` are the values of that entry's declared fields. The physics worker runs the
// matching runtime (`physics/components/`) every fixed step.

/** One component parameter: a number / flag / string (enum, key, entity id …), a vec3, or a list of [x, y] points. */
export type ComponentValue = number | boolean | string | number[] | number[][];
export type ComponentParams = Record<string, ComponentValue>;

export interface ComponentSpec {
  /** Unique across the whole scene (live readouts and events are addressed by it). */
  id: string;
  /** Id of a registered component type. */
  type: string;
  /** A disabled component keeps its parameters but does nothing. */
  enabled: boolean;
  params: ComponentParams;
}

/** Surface overrides of one collider part; anything left out is inherited from the body's material. */
export type PartMaterial = Partial<
  Pick<MaterialSpec, 'density' | 'friction' | 'restitution' | 'color' | 'metalness' | 'roughness' | 'opacity'>
>;

/** One collider of a compound body, positioned in the body's local frame. */
export interface ColliderPart {
  /** Unique within its body. */
  id: string;
  shape: ShapeSpec;
  position: Vec3;
  rotation: Quat;
  material?: PartMaterial;
  /** Detects overlaps but does not collide (it still adds mass unless its density is 0). */
  sensor?: boolean;
  /** `false` hides the part (invisible helper colliders). Default: drawn. */
  visible?: boolean;
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
  /** Behaviours attached to the joint (FB-7); same mechanism as `BodyEntity.components`. */
  components: ComponentSpec[];
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
  /** Id of the group (or other entity) this one is grouped under (FB-6). */
  parent?: string;
}

// ── FB-6: group / light / path entities ────────────────────────────────────────────────────────────────

/**
 * A folder with a pivot transform. Members point at the group through their `parent` link and keep their own
 * *world* pose; the group's `position` / `rotation` is the pivot that moving the group (`SceneStore.transformGroup`)
 * carries every descendant about. A group has no physics of its own — it exists only in the document and the editor.
 */
export interface GroupEntity {
  kind: 'group';
  id: string;
  name: string;
  /** Pivot, world space. */
  position: Vec3;
  rotation: Quat;
  locked: boolean;
  hidden: boolean;
  parent?: string;
}

export type LightType = 'point' | 'spot' | 'directional' | 'area';

/**
 * A light source. Point and spot intensities are in candela, directional in lux and area in nits (cd/m²), the
 * physical units three.js uses. A light shines along its local −Z axis (the camera convention); the default
 * rotation of a spot / directional / area light points it straight down. Lights have no physical behaviour: they
 * are stored in the document, drawn as an editor helper and rendered by a real three.js light (`render/lightViews.ts`).
 */
export interface LightEntity {
  kind: 'light';
  id: string;
  name: string;
  lightType: LightType;
  position: Vec3;
  rotation: Quat;
  color: string;
  intensity: number;
  /** Cut-off distance in metres (point / spot); 0 = the light reaches infinitely far. */
  range: number;
  /** Half-angle of the spot cone, radians. */
  angle: number;
  /** Soft edge of the spot cone, 0 (hard) – 1 (fully soft). */
  penumbra: number;
  /** Width × height of an area light, metres. */
  size: [number, number];
  castShadow: boolean;
  /** Switched off lights stay in the scene but emit nothing. */
  enabled: boolean;
  locked: boolean;
  hidden: boolean;
  parent?: string;
}

/**
 * A spline through `points` (a Catmull-Rom / cardinal curve, see `model/path.ts`), used as a track for movers,
 * cameras and anything else that follows a route. Points are in the path's own frame; `position` / `rotation` place
 * that frame in the world.
 */
export interface PathEntity {
  kind: 'path';
  id: string;
  name: string;
  position: Vec3;
  rotation: Quat;
  /** Control points, local to the path's frame (at least 2). */
  points: Vec3[];
  /** The last point connects back to the first (needs at least 3 points). */
  closed: boolean;
  /** Cardinal-spline tension: 0 = Catmull-Rom, 1 = straight segments between the points. */
  tension: number;
  color: string;
  locked: boolean;
  hidden: boolean;
  parent?: string;
}

export type Entity = BodyEntity | JointEntity | SoftEntity | GroupEntity | LightEntity | PathEntity;
/** Entities that live at a pose in the world (everything except joints, which hang off bodies). */
export type PosedEntity = Exclude<Entity, JointEntity>;
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
  // ── ZN-34: what each face of the box does, soft walls, the respawn policy ──
  /** What happens at each face of the box (default: every face kills, as a plain kill box). */
  edges: BoundsEdges;
  /** The spring wall of 'soft' faces. */
  soft: BoundsSoftWall;
  /** Used when `policy` is 'respawn'. */
  respawn: BoundsRespawn;
}

/**
 * What a face of the bounds box does to a dynamic body whose centre goes past it:
 *  - `open`   nothing (the world just continues; bodies are still switched off 400 m below the origin);
 *  - `kill`   the body is lost (removed, or respawned, by the policy) — a kill wall, or with the bottom face a kill plane;
 *  - `soft`   an invisible spring wall pushes the body back before it gets there (never kills);
 *  - `water`  like `kill`, reported as drowned and drawn as a sea (the bottom face is the one it is made for).
 */
export type BoundsEdge = 'open' | 'kill' | 'soft' | 'water';
export interface BoundsEdges {
  /** −x, +x, −y (the floor), +y (the ceiling), −z, +z. */
  nx: BoundsEdge;
  px: BoundsEdge;
  ny: BoundsEdge;
  py: BoundsEdge;
  nz: BoundsEdge;
  pz: BoundsEdge;
}
/** Soft wall: starts `margin` metres inside the face and pushes with an acceleration `stiffness`·depth, damped outward. */
export interface BoundsSoftWall {
  /** Thickness of the wall, metres. */
  margin: number;
  /** Spring constant as an acceleration per metre of depth, 1/s². */
  stiffness: number;
  /** Damping of the outward velocity, 1/s. */
  damping: number;
}
export interface BoundsRespawn {
  /** Where the body comes back: its starting pose, or the last checkpoint / respawn point it passed (else the start). */
  to: 'start' | 'checkpoint';
  /** Seconds the body is out of the world before it returns. */
  delay: number;
  /** Seconds added to the racer's times for every respawn. */
  penaltySeconds: number;
  /** Points taken off the score for every respawn. */
  penaltyPoints: number;
  /** Respawns allowed per body (or group) before it is removed for good (0 = unlimited). */
  max: number;
  /** Bodies that share a group (a vehicle) are lost and respawned together. */
  wholeGroups: boolean;
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
export const isGroup = (e: Entity | undefined | null): e is GroupEntity => !!e && e.kind === 'group';
export const isLight = (e: Entity | undefined | null): e is LightEntity => !!e && e.kind === 'light';
export const isPath = (e: Entity | undefined | null): e is PathEntity => !!e && e.kind === 'path';
/** Has a position and rotation in the world (every entity but joints). */
export const isPosed = (e: Entity | undefined | null): e is PosedEntity => !!e && e.kind !== 'joint';
/** The id of the entity this one is grouped under, if any (joints are never grouped). */
export const parentOf = (e: Entity): string | undefined => (e.kind === 'joint' ? undefined : e.parent);

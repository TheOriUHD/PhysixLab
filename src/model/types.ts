/**
 * The PhysixLab scene document.
 *
 * The document is the single source of truth for what the user has built. It is plain,
 * JSON-serializable data. The physics worker builds a Rapier world from it, the renderer
 * mirrors it, and the UI edits it through SceneStore (which keeps it immutable + undoable).
 */
import type { CollisionLayers } from './collisionLayers';
import type { JointParams } from './jointParams';
import type { Quat, Vec3 } from '../core/math';
// -- ED-A array: the stored definition of a linked array --
import type { ArrayDef } from './edit/arraySpec';

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
  // -- VZ-A: optional PBR extras + textures (absent = plain MeshStandard look) --
  emissive?: string;
  emissiveIntensity?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** Glass-like light transmission 0–1 (with `ior` and `thickness`). */
  transmission?: number;
  ior?: number;
  thickness?: number;
  sheen?: number;
  sheenColor?: string;
  anisotropy?: number;
  texture?: TextureSpec;
}

export type ProceduralPattern =
  | 'checker'
  | 'stripes'
  | 'hazard'
  | 'wood'
  | 'brick'
  | 'concrete'
  | 'marble'
  | 'noise'
  | 'grid'
  | 'dots'
  | 'carbon';

/** Albedo texture of a material: a procedural pattern or a user image, with UV controls and optional extra maps. */
export interface TextureSpec {
  /** Procedural pattern, or 'image' to use the `imageId` asset. */
  pattern: ProceduralPattern | 'image';
  /** Second colour of the pattern (the first is the material colour). */
  color2: string;
  /** Pattern repeats across a unit of UV (or per metre when triplanar). */
  scale: [number, number];
  /** Degrees. */
  rotation: number;
  offset: [number, number];
  /** Project the texture along the three axes in object space instead of using the shape's UVs. */
  triplanar: boolean;
  /** Texture assets (kind 'texture'). */
  imageId?: string;
  normalId?: string;
  roughnessId?: string;
  emissiveId?: string;
  /** Derive a normal map from the pattern's height (procedural patterns only). */
  bump: number;
  /** Strength of the supplied normal map. */
  normalStrength: number;
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

// -- UI-A: outliner organisation fields shared by every entity kind (UI-20/UI-21) --
export interface OutlinerMeta {
  /** Colour tag key (see `TAG_COLORS` in `model/outlinerMeta.ts`). Editor-only. */
  colorTag?: string;
  /** Free-form labels (bodies always carry the list; other kinds only when tagged). */
  tags?: string[];
  /** Soloed in the outliner: everything unrelated to the soloed entities is hidden (and marked `soloHid`). */
  solo?: boolean;
  /** Hidden *by* a solo (so that clearing the solo shows exactly these again). */
  soloHid?: boolean;
}
// -- end UI-A --

export interface BodyEntity extends OutlinerMeta {
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
  /**
   * JT-31: one-way platform. The direction (in the body's local frame) of the solid side: other bodies collide only
   * when they are on that side and not moving away from it, and pass through otherwise. Absent = a normal solid.
   */
  oneWay?: Vec3;
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

export type JointType =
  | 'fixed'
  | 'hinge'
  | 'slider'
  | 'ball'
  | 'spring'
  | 'rope'
  // -- JT-A: new joint types --
  | 'conetwist'
  | 'sixdof'
  | 'pulley'
  | 'rack'
  | 'gear'
  | 'belt'
  | 'universal'
  | 'screw'
  | 'winch'
  | 'softweld';

export type MotorMode = 'off' | 'velocity' | 'position';

export interface MotorSpec {
  mode: MotorMode;
  /** rad/s (hinge) or m/s (slider) at full input. */
  targetVelocity: number;
  /** rad (hinge) or m (slider). With a key bound it is the deflection at full input. */
  targetPosition: number;
  /**
   * Deflection at full *negative* input (key / axis), when it differs from `targetPosition`: lets a steering knuckle
   * turn further toward one side than the other, which is what Ackermann steering needs (the inner wheel turns more).
   */
  targetPositionNeg?: number;
  /** N/m or N·m/rad — position mode spring gain. */
  stiffness: number;
  /** N·s/m or N·m·s/rad — velocity-mode gain / position-mode damping. */
  damping: number;
  /** Max force (N) or torque (N·m) the motor can deliver. */
  maxForce: number;
  /** KeyboardEvent.code that drives the motor in the + / − direction. Empty = none. */
  keyPos: string;
  keyNeg: string;
  // -- CM-A: analog input --
  /** Name of an analog input axis (−1 … 1: gamepad, touch stick, ramped keys) added to the key input. Empty = none. */
  axis?: string;
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

/**
 * JT-11: when a joint fails. The thresholds apply to the force / torque the joint transmits (estimated by the
 * engine, see `src/physics/world/jointLoad.ts`); 0 = that component never breaks the joint. Springs keep their
 * own `spring.breakForce`. `fatigue` makes overload cumulative instead of instantaneous.
 */
export interface BreakSpec {
  /** Newtons. */
  force: number;
  /** N·m (ignored by joints that transmit no torque, e.g. ball and rope). */
  torque: number;
  fatigue: {
    enabled: boolean;
    /** Load ratio (load / threshold, 0..1) above which damage accumulates. */
    start: number;
    /** Seconds the joint survives at exactly its threshold once fatigue is accumulating at the full rate. */
    life: number;
  };
}

export interface JointEntity extends OutlinerMeta {
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
  // -- JT-A: settings of the cone-twist / 6-DOF / pulley / rack / gear / belt / screw / winch / soft weld types --
  params: JointParams;
  hidden: boolean;
  /** Behaviours attached to the joint (FB-7); same mechanism as `BodyEntity.components`. */
  components: ComponentSpec[];
  // -- JT-B: breakage thresholds (absent = unbreakable) --
  breakage?: BreakSpec;
}

/**
 * Deformable bodies (engine soft-body solver): jelly lattices, balloons, cloth and cables.
 * Particles live in the physics worker; the document only stores the recipe.
 */
export type SoftType = 'jelly' | 'balloon' | 'cloth' | 'cable' | 'mesh' | 'tyre';
export type SoftPin = 'none' | 'edge' | 'corners' | 'corners4' | 'one-end' | 'ends';

// -- SF: attachments, pressure, material model, volumetric meshes, tyres --
/**
 * A soft body fastened to a rigid body (SF-1). The particles inside `radius` of `center` (soft-body local rest frame)
 * are rigidly attached to `body` at the stored body-local `offset` of `center`; they follow the body (rotation
 * included), drag it back when pulled, and are released when `joint` breaks or the body is removed.
 */
export interface SoftAttachment {
  id: string;
  body: string;
  /** `region`: particles within `radius` of `center`; `rim`: the inner rim ring of a tyre (hub fastening). */
  kind: 'region' | 'rim';
  center: Vec3;
  radius: number;
  /** Body-local position of `center`. */
  offset: Vec3;
  /** Optional joint whose failure releases the attachment ("release on break"). */
  joint?: string;
}

export interface SoftEntity extends OutlinerMeta {
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
  // -- SF --
  /** Rigid-body fastenings (SF-1); particle sets are resolved from the rest lattice when the body is built. */
  attachments: SoftAttachment[];
  /** Target volume relative to the rest volume (pressure of balloons / tyres); 1 = unpressurised. */
  volumeFactor: number;
  /** Keep the enclosed volume (balloon, pneumatic tyre) — on for shells, off for plain lattices. */
  volumePreserve: boolean;
  /** Air escaping through a puncture: the volume factor decays at this rate (1/s). 0 = airtight. */
  leakRate: number;
  /** Poisson ratio of the material (0 – 0.49). */
  poisson: number;
  /** Permanent set: strain beyond which the material stays deformed (0 = purely elastic). */
  plasticYield: number;
  /** Surface friction of the particles' contact skin (SF-6). */
  friction: number;
  /** Collision radius override in metres (0 = automatic) (SF-6). */
  particleRadius: number;
  /** `mesh`: the shape this volumetric jelly is built from. */
  shape: ShapeSpec;
  /** `mesh`: volumetric cell size in metres (smaller = more particles). */
  cell: number;
  /** `tyre`: true = pneumatic (pressurised shell), false = airless (solid lattice). */
  pneumatic: boolean;
}

// ── FB-6: group / light / path entities ────────────────────────────────────────────────────────────────

/**
 * A folder with a pivot transform. Members point at the group through their `parent` link and keep their own
 * *world* pose; the group's `position` / `rotation` is the pivot that moving the group (`SceneStore.transformGroup`)
 * carries every descendant about. A group has no physics of its own — it exists only in the document and the editor.
 */
export interface GroupEntity extends OutlinerMeta {
  kind: 'group';
  id: string;
  name: string;
  /** Pivot, world space. */
  position: Vec3;
  rotation: Quat;
  locked: boolean;
  hidden: boolean;
  parent?: string;
  // -- ED-A array: present when this group holds the instances of a linked (re-editable) array --
  array?: ArrayDef;
}

export type LightType = 'point' | 'spot' | 'directional' | 'area';

/**
 * A light source. Point and spot intensities are in candela, directional in lux and area in nits (cd/m²), the
 * physical units three.js uses. A light shines along its local −Z axis (the camera convention); the default
 * rotation of a spot / directional / area light points it straight down. Lights have no physical behaviour: they
 * are stored in the document, drawn as an editor helper and rendered by a real three.js light (`render/lightViews.ts`).
 */
/** Candle-like flicker or a smooth pulse of a light's intensity. */
export interface LightFlicker {
  mode: 'flicker' | 'pulse';
  /** 0–1: how deep the intensity dips below its set value. */
  amount: number;
  /** Cycles per second. */
  speed: number;
}

export interface LightEntity extends OutlinerMeta {
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
  // -- VZ-A: optional intensity animation (absent = steady) --
  flicker?: LightFlicker;
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
export interface PathEntity extends OutlinerMeta {
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
  // -- VZ-A --
  type?: GroundType;
  /** 0–1: how far the ground fades into the horizon colour in the distance. */
  horizonBlend?: number;
}

/** How the ground slab looks (physics is the same for all; 'none' hides it but it still collides). */
export type GroundType = 'grid' | 'checker' | 'plain' | 'none' | 'water';

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
  // -- JT-B: named collision layers + matrix (absent = every layer collides with every layer) --
  layers?: CollisionLayers;

  // -- UI-A: named selection sets (UI-21) --
  /** Named groups of entity ids the outliner saves and recalls. */
  selectionSets: SelectionSet[];
  // -- VZ-B: weather --
  /** Per-scene weather (VZ-23). Absent = clear. */
  weather?: WeatherSettings;
}

/** A named, saved selection (UI-21). Ids of removed entities are skipped when it is recalled. */
export interface SelectionSet {
  name: string;
  ids: string[];
}

// -- VZ-B: weather --
export type WeatherKind = 'none' | 'rain' | 'snow' | 'leaves' | 'dust';

/** Weather of a scene: GPU particles, the wind they (and the effects package) feel, wet surfaces, lightning. */
export interface WeatherSettings {
  kind: WeatherKind;
  /** 0–1: scales the particle count (and the lightning rate). */
  intensity: number;
  /** Random lightning flashes (a brief screen flash; gentler with "reduce motion"). */
  lightning: boolean;
  /** 0–1: how wet the surfaces look (roughness down, darker ground). Rain wets at least as much as its intensity. */
  wet: number;
  /** Wind speed, m/s (0–40). The one scene wind: weather particles and the effects package both drift with it. */
  windSpeed: number;
  /** Direction the wind blows towards, degrees clockwise from −Z (0 = −Z, 90 = +X). */
  windDir: number;
}

export type SkyPreset =
  | 'studio'
  | 'day'
  | 'sunset'
  | 'night'
  | 'overcast'
  // -- VZ-A: more presets, the physically based sky and the user HDRI --
  | 'blueprint'
  | 'space'
  | 'lab'
  | 'desert'
  | 'snow'
  | 'physical'
  | 'hdri';

export type ToneMappingName = 'aces' | 'agx' | 'neutral' | 'linear';
export type FogType = 'linear' | 'exp' | 'height';

export interface EnvironmentSettings {
  sky: SkyPreset;
  /** Solar time in hours, 0–24 (the Time-of-day slider sets the sun from it; the day cycle advances it). */
  timeOfDay: number;
  fog: {
    enabled: boolean;
    color: string;
    /** Exponential / height-fog density, 1/m. */
    density: number;
    type: FogType;
    /** Linear fog: distance where it starts / is complete, metres. */
    near: number;
    far: number;
    /** Height fog: the fog is densest below this world height (m) and thins out upwards at `falloff` 1/m. */
    height: number;
    falloff: number;
  };
  /** Tone-mapping exposure multiplier. */
  exposure: number;
  // -- VZ-A --
  toneMapping: ToneMappingName;
  sun: {
    /** Compass direction of the sun in degrees (0 = north = −Z, 90 = east = +X). */
    azimuth: number;
    /** Degrees above the horizon (negative = below). */
    elevation: number;
    /** Multiplier of the sun light's intensity. */
    intensity: number;
    /** Physical sky: haze (2 = very clear … 20 = very hazy) and Rayleigh scattering strength. */
    turbidity: number;
    rayleigh: number;
  };
  /** Animated day-night cycle: the sun sweeps through the day at `hoursPerSecond` (display only, not saved as it runs). */
  cycle: { enabled: boolean; hoursPerSecond: number };
  /** A user HDRI (a blob asset in .hdr / .exr / .jpg / .png) used as 'hdri' sky. */
  hdri: {
    assetId: string | null;
    /** Show it as the background (otherwise only as lighting). */
    showBackground: boolean;
    /** 0 sharp … 1 fully blurred. */
    backgroundBlur: number;
    /** Degrees about the vertical axis. */
    rotation: number;
    /** Multiplier of the lighting it casts. */
    intensity: number;
  };
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
  format: 'physixlab-scene';
  version: number;
  name: string;
  settings: SceneSettings;
  entities: Entity[];
  /** Binary payloads referenced by entities (see the asset store section above). */
  assets: Record<string, Asset>;
  /** -- CM-A: bookmarks, shots and view setups; absent in files from before the camera package. -- */
  cameras?: SceneCameras;
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

// ── CM-A: saved cameras (bookmarks, cinematic shots, split / picture-in-picture setups) ───────────────────────
/** A named view: where the camera is and what it looks at, with a tiny thumbnail (a data URL, ≤ 24 kB). */
export interface CameraBookmark {
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  fov: number;
  ortho: boolean;
  /** Visible height in metres of an orthographic view. */
  orthoSize: number;
  thumb?: string;
}

export type ShotEase = 'linear' | 'in' | 'out' | 'inOut';

/** A keyframe of a cinematic shot: at time `t` seconds the camera is at fraction `u` (0…1 of the path) with this lens. */
export interface ShotKey {
  t: number;
  u: number;
  fov: number;
  /** Easing of the motion from this key to the next. */
  ease: ShotEase;
}

/** A camera on a rail: the path entity is the spline, the keys time the flight along it. */
export interface CameraShot {
  id: string;
  name: string;
  pathId: string;
  duration: number;
  loop: boolean;
  keys: ShotKey[];
  /** What the camera looks at: along the path, at a body (tracked) or at a fixed point. */
  look: { mode: 'tangent' | 'body' | 'point'; bodyId: string; point: Vec3 };
}

/** One secondary view (a split-screen pane or a picture-in-picture window). */
export interface ViewPane {
  id: string;
  /** `chase`: behind the subject; `topdown`: above it; `mount`: fixed on it (dashcam, drone); `bookmark`: a saved view. */
  mode: 'chase' | 'topdown' | 'mount' | 'bookmark' | 'shot';
  /** Body id the view follows / is mounted on (null = the first selected body at draw time). */
  subject: string | null;
  /** Bookmark or shot id for those modes. */
  ref: string;
  fov: number;
  /** `mount`: offset in the subject's frame (x right, y up, z back) and look direction yaw / pitch in degrees. */
  offset: Vec3;
  yaw: number;
  pitch: number;
  /** Picture-in-picture window: left / top / width as fractions of the viewport (ignored for split panes). */
  x: number;
  y: number;
  w: number;
}

export interface MinimapSettings {
  enabled: boolean;
  /** Visible half-extent in metres. */
  range: number;
  rotate: boolean;
  /** Window corner. */
  corner: 'tl' | 'tr' | 'bl' | 'br';
}

export interface SceneCameras {
  bookmarks: CameraBookmark[];
  shots: CameraShot[];
  /** Number of viewports in the split layout: 1 (none), 2, 3 or 4; the main view is the first. */
  split: 1 | 2 | 3 | 4;
  panes: ViewPane[];
  pips: ViewPane[];
  minimap: MinimapSettings;
}

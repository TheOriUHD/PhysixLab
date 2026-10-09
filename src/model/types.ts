/**
 * The PhysicsLab scene document.
 *
 * The document is the single source of truth for what the user has built. It is plain,
 * JSON-serializable data. The physics worker builds a Rapier world from it, the renderer
 * mirrors it, and the UI edits it through SceneStore (which keeps it immutable + undoable).
 */
import type { Quat, Vec3 } from '../core/math';

export type { Quat, Vec3 };

export type ShapeType = 'box' | 'sphere' | 'cylinder' | 'capsule' | 'cone' | 'wedge' | 'prism' | 'icosahedron';

/**
 * Shapes are parameterised by a bounding size [x, y, z] in metres (full extents):
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
  /** Prism only. */
  sides?: number;
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
}

export interface SceneDocument {
  format: 'physicslab-scene';
  version: number;
  name: string;
  settings: SceneSettings;
  entities: Entity[];
}

export const isBody = (e: Entity | undefined | null): e is BodyEntity => !!e && e.kind === 'body';
export const isJoint = (e: Entity | undefined | null): e is JointEntity => !!e && e.kind === 'joint';
export const isSoft = (e: Entity | undefined | null): e is SoftEntity => !!e && e.kind === 'soft';

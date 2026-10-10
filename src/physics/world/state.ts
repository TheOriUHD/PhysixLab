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
import type { BodyEntity, JointEntity, SceneSettings, SoftEntity } from '../../model/types';
import type { EnergyStats, SimEvent } from '../protocol';
import { RigidEnergy } from './energy';

export interface BodyRec {
  id: string;
  def: BodyEntity;
  rb: RAPIER.RigidBody;
  /** The first collider (every body has at least one). */
  col: RAPIER.Collider;
  /** All colliders of the body: several for compound shapes. */
  cols: RAPIER.Collider[];
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
  /** Emulated sleep threshold (see dynamics.ts); null = the engine's own sleeping applies. */
  sleep: { threshold: number; radius: number; calm: number } | null;
}

export interface SoftRec {
  id: string;
  def: SoftEntity;
  root: RAPIER.SoftBody;
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
}

export class WorldState {
  settings: SceneSettings;
  simTime = 0;
  stepCount = 0;
  layoutVersion = 0;

  bodies = new Map<string, BodyRec>();
  order: BodyRec[] = [];
  joints = new Map<string, JointRec>();
  jointOrder: JointRec[] = [];
  ground: { body: RAPIER.RigidBody; col: RAPIER.Collider } | null = null;
  softs = new Map<string, SoftRec>();
  softOrder: SoftRec[] = [];
  softBlocks: RAPIER.SoftBody[][] = [];
  softSig = '';
  softGrab: { body: RAPIER.SoftBody; local: number; target: Vec3 } | null = null;
  softParticles = 0;
  /** Unconsumed wall-clock time (scaled), in seconds, for the fixed-step accumulator. */
  acc = 0;
  keys = new Set<string>();
  grab: { rec: BodyRec; local: Vec3; target: Vec3 } | null = null;
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

  constructor(
    readonly world: RAPIER.World,
    /** Fixed, immovable body that joints attach to when one side is "the world". */
    readonly worldBody: RAPIER.RigidBody,
    settings: SceneSettings,
  ) {
    this.settings = settings;
  }
}

/**
 * Messages exchanged between the main thread (SimClient) and the physics worker.
 * The worker owns the Rapier world; the main thread owns the scene document.
 */
import type { Quat, Vec3 } from '../core/math';
import type { BodyEntity, JointEntity, SceneDocument, SceneSettings, SoftEntity } from '../model/types';

/** Floats per body in the pose buffer. */
export const BODY_STRIDE = 18;
/** Offsets inside one body record. */
export const B = {
  px: 0, py: 1, pz: 2,
  qx: 3, qy: 4, qz: 5, qw: 6,
  vx: 7, vy: 8, vz: 9,
  wx: 10, wy: 11, wz: 12,
  fx: 13, fy: 14, fz: 15, // average net force over the last frame (N): m·Δv/Δt
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
  | { op: 'wakeAll' };

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
      wantContacts: boolean;
    }
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
  | { type: 'ready' }
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
    }
  | { type: 'error'; message: string };

export type SimEvent =
  | { kind: 'jointBroken'; id: string; force: number }
  | { kind: 'impact'; id: string; speed: number };

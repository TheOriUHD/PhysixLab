/** Build-time info, run-time statistics and the lookups the tests and inspector use. */
import type { Quat, Vec3 } from '../../core/math';
import type { BuiltInfo, SimStats } from '../protocol';
import { measureJoint } from './joints';
import type { WorldState } from './state';
import { pos, rot } from './util';

/** Per-entity mass (all kinds) and local centre of mass (rigid bodies), as built by the engine. */
export function builtInfo(s: WorldState): BuiltInfo {
  const mass: Record<string, number> = {};
  const com: Record<string, Vec3> = {};
  for (const r of s.softOrder) mass[r.id] = r.def.mass;
  for (const r of s.order) {
    mass[r.id] = r.mass;
    const c = r.rb.localCom();
    com[r.id] = [c.x, c.y, c.z];
  }
  return { mass, com };
}

export function stats(s: WorldState): SimStats {
  let awake = s.awakeCount;
  if (awake === 0) awake = s.order.filter((r) => r.def.bodyType === 'dynamic' && !r.rb.isSleeping()).length;
  return {
    simTime: s.simTime,
    stepCount: s.stepCount,
    stepMs: s.stepMsEma,
    bodies: s.order.length,
    awake,
    particles: s.softParticles,
    contacts: s.lastContacts,
    realtimeFactor: s.rtf,
    energy: s.lastEnergy,
  };
}

/** Test helper: pose of a body in the live world. */
export function getPose(
  s: WorldState,
  id: string,
): { position: Vec3; rotation: Quat; linvel: Vec3; angvel: Vec3 } | null {
  const r = s.bodies.get(id);
  if (!r) return null;
  const lv = r.rb.linvel(),
    av = r.rb.angvel();
  return {
    position: pos(r.rb),
    rotation: rot(r.rb),
    linvel: [lv.x, lv.y, lv.z],
    angvel: [av.x, av.y, av.z],
  };
}

export function getJointRec(
  s: WorldState,
  id: string,
): {
  value: number;
  speed: number;
  force: number;
  broken: boolean;
  load: number;
  torque: number;
  ratio: number;
  damage: number;
} | null {
  const j = s.joints.get(id);
  if (!j) return null;
  if (!j.broken && j.joint) measureJoint(j);
  const l = j.jl;
  return {
    value: j.value,
    speed: j.speed,
    force: j.force,
    broken: j.broken,
    load: l?.force ?? 0,
    torque: l?.torque ?? 0,
    ratio: l?.ratio ?? 0,
    damage: l?.damage ?? 0,
  };
}

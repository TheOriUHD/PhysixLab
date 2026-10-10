/**
 * Vehicles for drive mode. A `VehicleAdapter` says what the thing you can drive is: its chassis, the bodies that
 * make it up, the driven wheels, and a human-readable list of the controls (key → what it does). Detectors turn a
 * scene into adapters; registering one with `registerVehicleDetector` lets other packages (a raycast vehicle) plug in.
 *
 * The built-in detector (`joints`) finds an *assembly*: bodies connected by joints (springs and ropes are soft links
 * and do not join assemblies), and treats the assemblies that have key-bound motors or powered components (engine,
 * motor, thruster …) or analog axes as vehicles. A single powered body is a vehicle of one.
 */
import { Registry } from '../../core/registry';
import type { Quat, Vec3 } from '../../core/math';
import { sceneControls, shortUse, type ControlUse } from '../../model/controls';
import type { BodyEntity, Entity, JointEntity } from '../../model/types';
import { isBody, isJoint } from '../../model/types';

export interface VehicleControl {
  /** `KeyboardEvent.code`. */
  code: string;
  /** What it does, for the legend: "Throttle · Engine", "Steer left". */
  label: string;
}

export interface VehicleAdapter {
  /** The detector that made this adapter (`joints`, later `raycast`). */
  readonly source: string;
  readonly name: string;
  readonly chassisId: string;
  /** Every body that is part of the vehicle (chassis, wheels, hubs …). */
  readonly bodyIds: readonly string[];
  /** Wheels / driven bodies (empty for a vehicle that is only thrusters). */
  readonly drivenIds: readonly string[];
  /** Key controls in first-seen order. */
  readonly controls: readonly VehicleControl[];
  /** Analog axis names the vehicle reads (gamepad sticks, touch joysticks). */
  readonly axes: readonly string[];
  /** Ids of the joints and bodies carrying components (engine, gearbox …), for the HUD to read their state. */
  readonly componentOwners: readonly string[];
  /** Pose of every body in the scene document (the start pose reset returns to). */
  startPose(id: string): { position: Vec3; rotation: Quat } | null;
}

export interface DetectInput {
  entities: readonly Entity[];
  /** Selected ids (bodies or joints). */
  selection: readonly string[];
  /** A world point to prefer the nearest vehicle to (the camera target) when nothing is selected. */
  near?: Vec3;
}

export interface VehicleDetector {
  id: string;
  order: number;
  /** All vehicles of the scene, best first. Never throws. */
  detect(input: DetectInput): VehicleAdapter[];
}

export const vehicleDetectors = new Registry<VehicleDetector>({ kind: 'vehicle detector', order: (d) => d.order });

export function registerVehicleDetector(d: VehicleDetector): () => void {
  return vehicleDetectors.register(d);
}

export interface VehicleChoice {
  vehicle: VehicleAdapter | null;
  /** Why there is none (shown as a toast). */
  reason?: string;
}

/** The vehicle to drive: the one that contains the selection, else the nearest / only vehicle of the scene. */
export function findVehicle(input: DetectInput): VehicleChoice {
  const all: VehicleAdapter[] = [];
  for (const d of vehicleDetectors.list()) {
    try {
      all.push(...d.detect(input));
    } catch (e) {
      console.error(`[vehicle detector ${d.id}]`, e);
    }
  }
  if (!all.length) {
    return {
      vehicle: null,
      reason:
        'No vehicle found: a vehicle is bodies joined together with key-bound motors or powered parts (engine, motor, thruster). Open the Drivable car to try it.',
    };
  }
  const sel = new Set(input.selection);
  if (sel.size) {
    const hit = all.find((v) => v.bodyIds.some((b) => sel.has(b)) || v.componentOwners.some((b) => sel.has(b)));
    if (hit) return { vehicle: hit };
    return {
      vehicle: null,
      reason: 'The selected object is not part of a vehicle with key-bound motors or powered parts. Select the vehicle, or clear the selection.',
    };
  }
  if (all.length === 1 || !input.near) return { vehicle: all[0] };
  const near = input.near;
  const dist = (v: VehicleAdapter): number => {
    const p = v.startPose(v.chassisId)?.position;
    return p ? Math.hypot(p[0] - near[0], p[1] - near[1], p[2] - near[2]) : Infinity;
  };
  return { vehicle: [...all].sort((a, b) => dist(a) - dist(b))[0] };
}

// ---- the joint-built vehicle detector ------------------------------------------------------------------------------

const SOFT_LINKS = new Set<string>(['spring', 'rope']);
const POWER_TYPES = new Set(['engine', 'motor', 'thruster', 'jet', 'rotor', 'propeller', 'servo', 'stepper']);

/** A disjoint-set over ids. */
class Groups {
  private parent = new Map<string, string>();
  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }
  find(id: string): string {
    let r = id;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = id;
    while (c !== r) {
      const n = this.parent.get(c)!;
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const VOLUME = (b: BodyEntity): number => b.massOverride ?? b.shape.size[0] * b.shape.size[1] * b.shape.size[2] * b.material.density;

/** Words that only say which corner a part is on. */
const SIDE_WORDS = /\b(front|rear|back|left|right|fl|fr|rl|rr)\b/gi;

function roleOf(name: string): string {
  const r = name.replace(SIDE_WORDS, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return r || name.toLowerCase();
}

/** A friendly name for what a key does, from every use the scene makes of it. */
export function describeKey(uses: readonly ControlUse[], joints: ReadonlyMap<string, JointEntity>): string {
  const phrases: string[] = [];
  const add = (p: string) => {
    if (!phrases.includes(p)) phrases.push(p);
  };
  for (const u of uses) {
    if (u.componentId) {
      const base = shortUse(u);
      add(base.toLowerCase() === u.componentLabel.toLowerCase() ? base : `${base} · ${u.componentLabel}`);
      continue;
    }
    const j = joints.get(u.ownerId);
    const positive = /\+/.test(u.fieldLabel);
    if (!j) {
      add(`${u.ownerName} ${positive ? '+' : '−'}`);
      continue;
    }
    if (j.motor.mode === 'position') {
      const vertical = Math.abs(j.axis[1]) > 0.7;
      add(vertical ? (positive ? 'Steer left' : 'Steer right') : `${roleOf(j.name)} ${positive ? '+' : '−'}`);
    } else if (j.type === 'hinge' && j.motor.mode === 'velocity') {
      add(positive ? 'Drive forward' : 'Drive reverse');
    } else {
      add(`${roleOf(j.name)} ${positive ? '+' : '−'}`);
    }
  }
  return phrases.length > 3 ? `${phrases.slice(0, 3).join(' + ')} …` : phrases.join(' + ');
}

export const jointVehicleDetector: VehicleDetector = {
  id: 'joints',
  order: 10,
  detect({ entities }) {
    const bodies = new Map<string, BodyEntity>();
    const joints = new Map<string, JointEntity>();
    for (const e of entities) {
      if (isBody(e) && e.bodyType !== 'static') bodies.set(e.id, e);
      else if (isJoint(e)) joints.set(e.id, e);
    }
    if (!bodies.size) return [];
    const groups = new Groups();
    for (const id of bodies.keys()) groups.add(id);
    for (const j of joints.values()) {
      if (SOFT_LINKS.has(j.type) || !j.bodyA || !j.bodyB) continue;
      if (bodies.has(j.bodyA) && bodies.has(j.bodyB)) groups.union(j.bodyA, j.bodyB);
    }
    const members = new Map<string, string[]>();
    for (const id of bodies.keys()) {
      const r = groups.find(id);
      const l = members.get(r);
      if (l) l.push(id);
      else members.set(r, [id]);
    }
    const out: { adapter: VehicleAdapter; score: number }[] = [];
    for (const ids of members.values()) {
      const set = new Set(ids);
      const myJoints = [...joints.values()].filter(
        (j) => (j.bodyA !== null && set.has(j.bodyA)) || (j.bodyB !== null && set.has(j.bodyB)),
      );
      const owners: Entity[] = [...ids.map((id) => bodies.get(id)!), ...myJoints];
      const ctl = sceneControls(owners);
      if (!ctl.keys.length && !ctl.axes.length) continue;
      // The chassis: the body with the engine, else the one with most joints, then the heaviest.
      const jointCount = new Map<string, number>();
      for (const j of myJoints)
        for (const b of [j.bodyA, j.bodyB]) if (b && set.has(b)) jointCount.set(b, (jointCount.get(b) ?? 0) + 1);
      const rank = (id: string): number => {
        const b = bodies.get(id)!;
        const engine = b.components.some((c) => c.type === 'engine' && c.enabled) ? 1e6 : 0;
        return engine + (jointCount.get(id) ?? 0) * 1000 + Math.min(999, VOLUME(b));
      };
      const chassis = [...ids].sort((a, b) => rank(b) - rank(a))[0];
      // Driven bodies: the far end of hinges that turn at a commanded speed or carry a drive shaft.
      const driven = new Set<string>();
      for (const j of myJoints) {
        if (j.type !== 'hinge') continue;
        const turns =
          (j.motor.mode === 'velocity' && (j.motor.keyPos || j.motor.keyNeg || j.motor.axis)) ||
          j.components.some((c) => c.enabled && (c.type === 'driveShaft' || c.type === 'motor'));
        if (!turns) continue;
        for (const b of [j.bodyA, j.bodyB]) if (b && set.has(b) && b !== chassis) driven.add(b);
      }
      const jointMap = new Map(myJoints.map((j) => [j.id, j]));
      const controls: VehicleControl[] = ctl.keys.map((k) => ({ code: k.code, label: describeKey(k.uses, jointMap) }));
      const chassisBody = bodies.get(chassis)!;
      const componentOwners = owners.filter((o) => (isBody(o) || isJoint(o)) && o.components.length > 0).map((o) => o.id);
      const powered = owners.some((o) => (isBody(o) || isJoint(o)) && o.components.some((c) => POWER_TYPES.has(c.type)));
      const score = ctl.keys.length + ctl.axes.length * 0.5 + (powered ? 3 : 0) + (driven.size ? 2 : 0) + ids.length * 0.01;
      const poses = new Map(ids.map((id) => [id, { position: bodies.get(id)!.position, rotation: bodies.get(id)!.rotation }]));
      out.push({
        score,
        adapter: {
          source: 'joints',
          name: ids.length > 1 ? chassisBody.name.replace(/\s+chassis$/i, '') || chassisBody.name : chassisBody.name,
          chassisId: chassis,
          bodyIds: ids,
          drivenIds: [...driven],
          controls,
          axes: ctl.axes.map((a) => a.name),
          componentOwners,
          startPose: (id) => poses.get(id) ?? null,
        },
      });
    }
    return out.sort((a, b) => b.score - a.score).map((o) => o.adapter);
  },
};

registerVehicleDetector(jointVehicleDetector);

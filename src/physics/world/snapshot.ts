/**
 * Snapshots of the simulated world (`SimOp 'snapshot'` / `'restore'`): the foundation of time travel and replays.
 *
 * The engine serialises its complete state (`World.takeSnapshot`: rigid bodies, colliders, joints, soft bodies,
 * island and contact caches, integration parameters). What the engine cannot know is how our ids map onto its
 * handles and the JavaScript-side bookkeeping around them — which definition each body was built from, joint
 * frames, the motor cache, the emulated sleep counters, the clock and the RNG — so every record's handles and
 * fields are saved next to the engine bytes. Restoring builds a new engine world from the bytes, looks every handle
 * up again and rebuilds the records; the old world is freed. A snapshot restores bodies that were removed since it
 * was taken and removes the ones that were added, because the world's contents are replaced as a whole.
 *
 * Not captured: the mouse grab (released on restore), pending events, and the input state (keys, axes — the next
 * tick supplies them). Components keep their own state through `saveState` / `loadState`; those without it start
 * over from their parameters.
 */
import { countHooks } from './layers';
import RAPIER from '@dimforge/rapier3d-compat';
import { pathCurveOf } from '../../model/path';
import type { Quat, Vec3 } from '../../core/math';
import type { BodySnapshot, JointSnapshot, WorldSnapshot } from '../protocol';
import { sleepEmulation } from './bodies';
import { registerColliders, registerGround } from './events';
import type { BodyRec, JointRec, SoftRec, WorldState } from './state';

export function takeSnapshot(s: WorldState): WorldSnapshot {
  const bodies: BodySnapshot[] = s.order.map((r) => ({
    def: r.def,
    ephemeral: r.ephemeral,
    disabled: r.disabled,
    rb: r.rb.handle,
    cols: r.cols.map((c) => c.handle),
    colParts: r.colParts.map((p) => (p ? p.id : null)),
    mass: r.mass,
    prev: [...r.prev],
    hasPrev: r.hasPrev,
    vPrev: [...r.vPrev] as Vec3,
    forced: r.forced,
    sleepCalm: r.sleep ? r.sleep.calm : null,
  }));
  const joints: JointSnapshot[] = s.jointOrder.map((j) => ({
    def: j.def,
    handle: j.joint && j.joint.isValid() ? j.joint.handle : null,
    aA: [...j.aA] as Vec3,
    aB: [...j.aB] as Vec3,
    frameA: [...j.frameA] as Quat,
    frameB: [...j.frameB] as Quat,
    broken: j.broken,
    angle: j.angle,
    lastTwist: j.lastTwist,
    value: j.value,
    speed: j.speed,
    force: j.force,
    motorTarget: j.motorTarget,
    cache: [...j.cache] as [number, number, number],
    rt: [...j.rt], // -- JT-A --
    jl: j.jl ? { ...j.jl } : undefined,
  }));
  return {
    version: 1,
    rapier: s.world.takeSnapshot(),
    simTime: s.simTime,
    stepCount: s.stepCount,
    acc: s.acc,
    rng: s.rng.state,
    settings: s.settings,
    bodies,
    joints,
    softs: s.softOrder.map((r) => ({
      def: r.def,
      root: r.root.handle,
      volumeFactor: r.volumeFactor,
      released: [...r.released],
      attached: r.attached.map((a) => ({ id: a.att.id, particles: [...a.particles], bodyHandle: a.bodyHandle })),
    })),
    paths: [...s.paths.values()].map((p) => p.def),
    worldBody: s.worldBody.handle,
    ground: s.ground ? { body: s.ground.body.handle, collider: s.ground.col.handle } : null,
    components: s.host.saveStates(),
  };
}

/**
 * Replace the world's contents by `snap`. Throws (leaving the world untouched) if the snapshot is not one this
 * build can read.
 */
export function restoreSnapshot(s: WorldState, snap: WorldSnapshot): void {
  if (snap.version !== 1) throw new Error(`unsupported snapshot version ${String(snap.version)}`);
  const next = RAPIER.World.restoreSnapshot(snap.rapier);

  // From here on the old world is gone: shut down everything that points into it.
  s.host.disposeAll();
  const old = s.world;
  s.world = next;
  s.worldBody = next.getRigidBody(snap.worldBody);
  s.grab = null;
  s.softGrab = null;
  s.bodies = new Map();
  s.order = [];
  s.draggers = [];
  s.sleepers = [];
  s.joints = new Map();
  s.jointOrder = [];
  s.softs = new Map();
  s.softOrder = [];
  s.softBlocks = [];
  s.softSig = '';
  s.owners = new Map();
  s.retired = new Map();
  s.pendingContacts = new Map();
  s.freshContacts = [];
  s.eventQueue.clear(); // events of the old world name handles that no longer exist
  s.lastContactAt = new Map();
  s.paths = new Map();
  // `disposeAll` queued the ids of every published state for withdrawal; keep that list so the page forgets the
  // numbers of components that no longer exist (those that do are re-created below and publish again).
  s.componentState = new Map();
  s.events = [];
  s.settings = snap.settings;
  s.simTime = snap.simTime;
  s.stepCount = snap.stepCount;
  s.acc = snap.acc;
  s.rng.state = snap.rng;
  s.simSinceRead = 0;
  old.free();

  // ground
  if (snap.ground) {
    s.ground = { body: next.getRigidBody(snap.ground.body), col: next.getCollider(snap.ground.collider) };
    registerGround(s);
  } else s.ground = null;

  // rigid bodies
  for (const b of snap.bodies) {
    const rb = next.getRigidBody(b.rb);
    const cols = b.cols.map((h) => next.getCollider(h));
    const def = b.def;
    const rec: BodyRec = {
      id: def.id,
      seq: s.bodySeq++,
      def,
      rb,
      col: cols[0],
      cols,
      colParts: b.colParts.map((id) => (id === null ? null : (def.parts?.find((p) => p.id === id) ?? null))),
      mass: b.mass,
      ephemeral: b.ephemeral,
      disabled: b.disabled,
      prev: Float64Array.from(b.prev),
      hasPrev: b.hasPrev,
      vPrev: [...b.vPrev] as Vec3,
      force: [0, 0, 0],
      forced: b.forced,
      dragged: def.bodyType === 'dynamic' && (def.drag.linear2 > 0 || def.drag.angular2 > 0),
      sleep: sleepEmulation(def),
      oneWay: def.oneWay !== undefined, // -- JT-B --
    };
    if (rec.sleep && b.sleepCalm !== null) rec.sleep.calm = b.sleepCalm;
    s.bodies.set(def.id, rec);
    s.order.push(rec);
    if (rec.dragged) s.draggers.push(rec);
    if (rec.sleep) s.sleepers.push(rec);
    registerColliders(s, rec);
  }
  countHooks(s); // -- JT-B --

  // joints
  for (const j of snap.joints) {
    const rec: JointRec = {
      id: j.def.id,
      def: j.def,
      joint: j.handle === null ? null : next.getImpulseJoint(j.handle),
      A: j.def.bodyA ? (s.bodies.get(j.def.bodyA) ?? null) : null,
      B: j.def.bodyB ? (s.bodies.get(j.def.bodyB) ?? null) : null,
      aA: [...j.aA] as Vec3,
      aB: [...j.aB] as Vec3,
      frameA: [...j.frameA] as Quat,
      frameB: [...j.frameB] as Quat,
      broken: j.broken,
      angle: j.angle,
      lastTwist: j.lastTwist,
      value: j.value,
      speed: j.speed,
      force: j.force,
      motorTarget: j.motorTarget,
      cache: [...j.cache] as [number, number, number],
      rt: j.rt ? [...j.rt] : [], // -- JT-A --
      jl: j.jl ? { ...j.jl } : undefined,
    };
    s.joints.set(rec.id, rec);
    s.jointOrder.push(rec);
  }

  // soft bodies (the engine restored the particles; we only need the wrappers back)
  for (const sb of snap.softs) {
    const root = next.softBodies.get(sb.root);
    if (!root) continue;
    const rec: SoftRec = {
      id: sb.def.id,
      def: sb.def,
      root,
      rest: null,
      attached: [],
      released: new Set(sb.released ?? []),
      volumeFactor: sb.volumeFactor ?? sb.def.volumeFactor,
      restLen: new Map(),
    };
    for (const a of sb.attached ?? []) {
      const att = sb.def.attachments.find((x) => x.id === a.id);
      if (att) rec.attached.push({ att, particles: [...a.particles], bodyHandle: a.bodyHandle });
    }
    s.softs.set(rec.id, rec);
    s.softOrder.push(rec);
  }

  // paths, then components (bodies and joints exist now, so they can be re-attached and given their saved state)
  for (const p of snap.paths) s.paths.set(p.id, { def: p, curve: pathCurveOf(p) });
  for (const r of s.order) s.host.sync('body', r.id, r.def.components);
  for (const j of s.jointOrder) s.host.sync('joint', j.id, j.def.components);
  s.host.loadStates(snap.components);

  s.queriesDirty = true;
  s.layoutVersion++;
}

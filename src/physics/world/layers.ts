/**
 * JT-30 / JT-31: collision layers applied to the live world, trigger layers, and one-way platforms.
 *
 * Layers: every collider carries a Rapier interaction-group word built from its body's layer and mask limited by the
 * scene matrix (`interactionGroups`); a trigger layer makes the collider a sensor. One-way platforms are a physics hook
 * (`filterContactPair`): a pair involving a platform is solid only when the other body is on the platform's solid
 * side and is not moving away through it.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { qrot, vdot, type Vec3 } from '../../core/math';
import { isTriggerLayer } from '../../model/collisionLayers';
import type { BodyEntity, SceneSettings } from '../../model/types';
import { groundGroups, interactionGroups } from './bodyFields';
import type { BodyRec, WorldState } from './state';
import { rot } from './util';

const COLLISION_EVENTS = RAPIER.ActiveEvents.COLLISION_EVENTS;
const HOOK = RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS;

/** Is this body a trigger (its colliders are sensors) under the scene's layers? */
export function isTriggerBody(def: BodyEntity, layers: SceneSettings['layers']): boolean {
  return isTriggerLayer(layers, def.collision.group);
}

/** Re-apply groups, trigger flags and hook flags to every collider after the layers (or a body's layer) changed. */
export function refreshLayers(s: WorldState): void {
  const layers = s.settings.layers;
  for (const rec of s.order) applyBodyLayer(s, rec, rec.def, false);
  countHooks(s);
  if (s.ground) s.ground.col.setCollisionGroups(groundGroups(layers));
}

/** Update one body's colliders (groups, sensor flag, one-way hook flag) from its definition. */
export function applyBodyLayer(s: WorldState, rec: BodyRec, def: BodyEntity, recount = true): void {
  const groups = interactionGroups(def.collision, s.settings.layers);
  const trigger = isTriggerBody(def, s.settings.layers);
  const oneWay = def.oneWay !== undefined;
  rec.cols.forEach((c, i) => {
    c.setCollisionGroups(groups);
    const sensor = def.ghost || !!rec.colParts[i]?.sensor || trigger;
    if (c.isSensor() !== sensor) {
      c.setSensor(sensor);
      const owner = s.owners.get(c.handle);
      if (owner) owner.sensor = sensor;
      if (sensor) c.setActiveEvents(COLLISION_EVENTS);
    }
    c.setActiveHooks(oneWay ? HOOK : RAPIER.ActiveHooks.NONE);
  });
  rec.oneWay = oneWay;
  if (recount) countHooks(s);
}

/** Recount the platforms: the hook object is only handed to the engine while there is at least one. */
export function countHooks(s: WorldState): void {
  let n = 0;
  for (const r of s.order) if (r.def.oneWay !== undefined && !r.disabled) n++;
  s.oneWayCount = n;
}

/**
 * What the contact hook may look at. The engine holds its body set borrowed while it calls the hook, so the hook must
 * not touch any rigid body: the poses and velocities it needs are copied here before every step (`refreshHookCache`).
 */
interface HookBody {
  rec: BodyRec;
  com: Vec3;
  vel: Vec3;
  /** Platforms only: world position and the world direction of the solid side. */
  pos: Vec3;
  normal: Vec3;
}

const cache = new Map<number, HookBody>();

/** Copy the poses / velocities the hook needs (all bodies when platforms exist). Called before each engine step. */
export function refreshHookCache(s: WorldState): void {
  cache.clear();
  for (const rec of s.order) {
    if (rec.disabled) continue;
    const rb = rec.rb;
    const c = rb.worldCom();
    const v = rb.linvel();
    const t = rb.translation();
    cache.set(rb.handle, {
      rec,
      com: [c.x, c.y, c.z],
      vel: [v.x, v.y, v.z],
      pos: [t.x, t.y, t.z],
      normal: rec.oneWay && rec.def.oneWay ? qrot(rot(rb), rec.def.oneWay) : [0, 0, 0],
    });
  }
}

/** Margin (m/s) a body may be moving *away* from the solid side and still count as resting on it. */
const REST_SPEED = 0.35;

function platformAllows(platform: HookBody, other: HookBody | undefined): boolean {
  if (!other) return true;
  const n = platform.normal;
  const side = vdot(
    [other.com[0] - platform.pos[0], other.com[1] - platform.pos[1], other.com[2] - platform.pos[2]],
    n,
  );
  if (side <= 0) return false;
  const vn = vdot([other.vel[0] - platform.vel[0], other.vel[1] - platform.vel[1], other.vel[2] - platform.vel[2]], n);
  return vn <= REST_SPEED;
}

/** The hook object: solid unless a one-way platform on either side says no. */
export function makeHooks(s: WorldState): RAPIER.PhysicsHooks {
  return {
    filterContactPair(c1, c2, b1, b2) {
      const o1 = s.owners.get(c1)?.rec;
      const o2 = s.owners.get(c2)?.rec;
      if (o1?.oneWay) {
        const p = cache.get(b1);
        if (p && !platformAllows(p, cache.get(b2))) return null;
      }
      if (o2?.oneWay) {
        const p = cache.get(b2);
        if (p && !platformAllows(p, cache.get(b1))) return null;
      }
      return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair() {
      return true;
    },
  };
}

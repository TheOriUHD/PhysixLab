/**
 * Scene queries: ray casts (the `raycast` op and `ctx.raycast`) and the contact list of a body (`ctx.contacts`).
 *
 * The engine's query structures are rebuilt by a step, so after bodies were added, removed or teleported they are
 * stale until the next step. A query that finds them stale first runs a zero-length update step (time does not
 * advance and nothing moves); this keeps ray casts correct on a paused simulation right after an edit.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../../core/math';
import { GROUND_ID, type RayHit, type RaycastOptions } from '../protocol';
import { collectEvents } from './events';
import type { WorldState } from './state';
import { rv } from './util';

/** A touching contact of a body, as `ctx.contacts` returns it. */
export interface ContactPoint {
  /** The other body (`GROUND_ID` for the ground). */
  other: string;
  point: Vec3;
  /** Unit normal pointing out of the other body toward this one (the direction it pushes this body). */
  normal: Vec3;
  /** Normal force estimate over the last engine step, N. */
  force: number;
}

/** Bring the engine's query structures up to date if bodies changed since the last step. */
export function updateQueries(s: WorldState): void {
  if (!s.queriesDirty) return;
  s.queriesDirty = false;
  const dt = s.world.integrationParameters.dt;
  s.world.integrationParameters.dt = 0;
  s.world.step(s.eventQueue);
  s.world.integrationParameters.dt = dt;
  collectEvents(s, s.simTime);
}

/** The nearest hit of a ray, or null. `dir` need not be normalised; `maxDist` is in metres. */
export function raycast(
  s: WorldState,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  options: RaycastOptions = {},
): RayHit | null {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 1e-12) || !(maxDist > 0)) return null;
  updateQueries(s);
  const d: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  const ignored = new Set<number>();
  for (const id of options.ignore ?? []) {
    const rec = s.bodies.get(id);
    if (rec) for (const c of rec.cols) ignored.add(c.handle);
  }
  const hit = s.world.castRayAndGetNormal(
    new RAPIER.Ray(rv(origin), rv(d)),
    maxDist,
    options.solid ?? true,
    options.sensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    undefined,
    undefined,
    undefined,
    ignored.size ? (c) => !ignored.has(c.handle) : undefined,
  );
  if (!hit) return null;
  const owner = s.owners.get(hit.collider.handle);
  const t = hit.timeOfImpact;
  return {
    id: owner?.id ?? GROUND_ID,
    ...(owner?.part !== undefined ? { part: owner.part } : {}),
    distance: t,
    point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t],
    normal: [hit.normal.x, hit.normal.y, hit.normal.z],
  };
}

/** The contacts a body is in right now (solid contacts with at least one active contact point). */
export function contactsOf(s: WorldState, id: string): ContactPoint[] {
  const rec = s.bodies.get(id);
  if (!rec) return [];
  const dt = s.world.integrationParameters.dt;
  const out: ContactPoint[] = [];
  for (const c of rec.cols) {
    s.world.contactPairsWith(c, (c2) => {
      const other = s.owners.get(c2.handle);
      if (!other || other.sensor) return;
      s.world.contactPair(c, c2, (m, flipped) => {
        const ns = m.numSolverContacts();
        if (ns === 0) return;
        let imp = 0;
        for (let i = 0; i < m.numContacts(); i++) imp += m.contactImpulse(i);
        const n = m.normal();
        const sgn = flipped ? 1 : -1; // raw normal runs collider 1 → 2; we want out of the other toward this body
        for (let i = 0; i < ns; i++) {
          const p = m.solverContactPoint(i);
          if (!p) continue;
          out.push({
            other: other.id,
            point: [p.x, p.y, p.z],
            normal: [n.x * sgn, n.y * sgn, n.z * sgn],
            force: dt > 0 ? imp / ns / dt : 0,
          });
        }
      });
    });
  }
  return out;
}

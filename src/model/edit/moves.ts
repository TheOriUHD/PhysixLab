/**
 * Rigid moves (and optional resizing) of top-level entities as store patches (pure).
 *
 * `movePatches` is the one primitive align / distribute / drop / stack / randomise / pivot rotation are built on. A
 * move names an entity and its target pose (and optionally a size factor); the result is the list of
 * `[id, Partial<Entity>]` patches `SceneStore.updateMany` applies in one undo step:
 *
 *  - a plain entity gets its own `position` / `rotation` (a body's initial velocities turn with it);
 *  - a *group* is moved about its pivot and every descendant is carried by the same rigid transform (exactly what
 *    `groupTransformPatches` does), so a group never leaves its members behind;
 *  - joints anchored to the world on one side follow the single body they hold (anchor and axis);
 *  - a size factor resizes the entity through the shape registry (`normalizeSize`), scales a compound's parts, a soft
 *    body's size and a path's points.
 */
import { qmul, qnorm, qrot, qrotInv, vadd, type Quat, type Vec3 } from '../../core/math';
import { scaleParts } from '../compound';
import { childIndex, descendantIds, topLevel } from '../groups';
import { normalizeSize } from '../shapes';
import type { BodyEntity, Entity, PosedEntity } from '../types';
import { isBody, isGroup, isJoint, isPath, isPosed, isSoft } from '../types';

export type Patch = [string, Partial<Entity>];

export interface RootMove {
  id: string;
  /** Target position (default: where it is). For a group this is the new pivot position. */
  position?: Vec3;
  rotation?: Quat;
  /**
   * Size factor: along the entity's own axes for a single entity; along world axes for the offsets of a group's
   * members (and per member along its own axes for its size). Omit for no resizing.
   */
  scale?: Vec3;
}

interface Mapper {
  point(p: Vec3): Vec3;
  dir(d: Vec3): Vec3;
}

/** Entities `ids` may be edited: top-level, posed, not locked, not hidden. */
export function editableRoots(entities: readonly Entity[], ids: readonly string[]): string[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  return topLevel((id) => byId.get(id), ids).filter((id) => {
    const e = byId.get(id);
    return !!e && isPosed(e) && !e.locked && !e.hidden;
  });
}

const isIdentity = (f: Vec3): boolean => Math.abs(f[0] - 1) + Math.abs(f[1] - 1) + Math.abs(f[2] - 1) < 1e-12;

function resizePatch(e: PosedEntity, f: Vec3): Partial<Entity> {
  if (isBody(e)) {
    const size = normalizeSize(
      e.shape.type,
      [e.shape.size[0] * f[0], e.shape.size[1] * f[1], e.shape.size[2] * f[2]],
      e.shape.size,
      e.shape.params,
    );
    const patch: Partial<BodyEntity> = { shape: { ...e.shape, size } };
    if (e.parts?.length) {
      const k = size.map((v, i) => (e.shape.size[i] > 0 ? v / e.shape.size[i] : 1)) as Vec3;
      patch.parts = scaleParts(e.parts, k);
    }
    return patch;
  }
  if (isSoft(e)) {
    const m = (v: number) => (v > 0 ? Math.max(0.1, v) : 0);
    const [sx, sy, sz] = e.size;
    let size: Vec3;
    switch (e.type) {
      case 'balloon': {
        const d = m(sx * Math.cbrt(f[0] * f[1] * f[2]));
        size = [d, d, d];
        break;
      }
      case 'cloth':
        size = [m(sx * f[0]), 0, m(sz * f[2])];
        break;
      case 'cable':
        size = [m(sx * f[0]), 0, 0];
        break;
      default:
        size = [m(sx * f[0]), m(sy * f[1]), m(sz * f[2])];
    }
    return { size };
  }
  if (isPath(e)) return { points: e.points.map((p) => [p[0] * f[0], p[1] * f[1], p[2] * f[2]] as Vec3) };
  return {};
}

/**
 * Patches realising `moves`. Moves of entities that sit below another moved entity are ignored (the ancestor
 * carries them); locked and hidden entities are NOT filtered here — callers pass `editableRoots`.
 */
export function movePatches(entities: readonly Entity[], moves: readonly RootMove[]): Patch[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const roots = new Set(
    topLevel(
      (id) => byId.get(id),
      moves.map((m) => m.id),
    ),
  );
  const index = childIndex(entities);
  const out: Patch[] = [];
  /** body id → how a world point attached to it moves. */
  const bodyMap = new Map<string, Mapper>();

  for (const m of moves) {
    if (!roots.has(m.id)) continue;
    const e = byId.get(m.id);
    if (!e || !isPosed(e)) continue;
    const toPos: Vec3 = m.position ?? e.position;
    const toRot: Quat = qnorm(m.rotation ?? e.rotation);
    const rot = qnorm(qmul(toRot, [-e.rotation[0], -e.rotation[1], -e.rotation[2], e.rotation[3]]));
    const turns = Math.hypot(rot[0], rot[1], rot[2]) > 1e-9;
    const f: Vec3 = m.scale ?? [1, 1, 1];
    const scaled = !isIdentity(f);

    const rootPatch: Partial<Entity> = { position: [...toPos] as Vec3, rotation: [...toRot] as Quat };
    if (isGroup(e)) {
      // World-axis scale about the old pivot, then the rigid turn, then the shift to the new pivot.
      const point = (p: Vec3): Vec3 => {
        const r: Vec3 = [(p[0] - e.position[0]) * f[0], (p[1] - e.position[1]) * f[1], (p[2] - e.position[2]) * f[2]];
        return vadd(toPos, qrot(rot, r));
      };
      const mapper: Mapper = { point, dir: (d) => qrot(rot, d) };
      out.push([e.id, rootPatch]);
      for (const id of descendantIds(index, e.id)) {
        const d = byId.get(id);
        if (!d || !isPosed(d)) continue;
        const patch: Partial<Entity> = {
          position: point(d.position),
          rotation: qnorm(qmul(rot, d.rotation)),
          ...(scaled && !isGroup(d) ? resizePatch(d, f) : {}),
        };
        if (isBody(d) && turns)
          Object.assign(patch, { velocity: mapper.dir(d.velocity), angularVelocity: mapper.dir(d.angularVelocity) });
        out.push([id, patch]);
        if (isBody(d)) bodyMap.set(id, mapper);
      }
    } else {
      if (scaled) Object.assign(rootPatch, resizePatch(e, f));
      if (isBody(e) && turns)
        Object.assign(rootPatch, { velocity: qrot(rot, e.velocity), angularVelocity: qrot(rot, e.angularVelocity) });
      out.push([e.id, rootPatch]);
      if (isBody(e)) {
        bodyMap.set(e.id, {
          point: (p) => {
            const local = qrotInv(e.rotation, [p[0] - e.position[0], p[1] - e.position[1], p[2] - e.position[2]]);
            return vadd(toPos, qrot(toRot, [local[0] * f[0], local[1] * f[1], local[2] * f[2]]));
          },
          dir: (d) => qrot(rot, d),
        });
      }
    }
  }

  // Joints anchored to the world on one side follow the one body they hold.
  for (const j of entities) {
    if (!isJoint(j)) continue;
    if ((j.bodyA === null) === (j.bodyB === null)) continue; // both world, or both bodies (local anchors follow)
    const mapper = bodyMap.get((j.bodyA ?? j.bodyB) as string);
    if (!mapper) continue;
    const patch: Record<string, Vec3> = {};
    if (j.bodyA === null) {
      patch.anchorA = mapper.point(j.anchorA);
      patch.axis = mapper.dir(j.axis);
    } else {
      patch.anchorB = mapper.point(j.anchorB);
    }
    out.push([j.id, patch]);
  }
  return out;
}

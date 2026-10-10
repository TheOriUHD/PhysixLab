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
import { qmul, qnorm, qrot, qrotInv, vadd, vnorm, type Quat, type Vec3 } from '../../core/math';
import { scaleParts } from '../compound';
import { childIndex, descendantIds, topLevel } from '../groups';
import { normalizeSize } from '../shapes';
import { shapeVolume } from '../shapeRegistry';
import { localFactor } from './groupScale';
import type { BodyEntity, Entity, JointEntity, PosedEntity } from '../types';
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
    const k = size.map((v, i) => (e.shape.size[i] > 0 ? v / e.shape.size[i] : 1)) as Vec3;
    if (e.parts?.length) patch.parts = scaleParts(e.parts, k);
    const vol = shapeVolume(e.shape);
    if (e.massOverride !== undefined && vol > 0)
      patch.massOverride = (e.massOverride * shapeVolume(patch.shape!)) / vol;
    if (e.comOverride) patch.comOverride = [e.comOverride[0] * k[0], e.comOverride[1] * k[1], e.comOverride[2] * k[2]];
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
  /** body id → per-local-axis factor its size actually took (so body-local joint anchors can follow). */
  const resized = new Map<string, Vec3>();
  const noteResize = (e: PosedEntity, patch: Partial<Entity>) => {
    const shape = (patch as Partial<BodyEntity>).shape;
    if (!isBody(e) || !shape) return;
    resized.set(e.id, shape.size.map((v, i) => (e.shape.size[i] > 1e-12 ? v / e.shape.size[i] : 1)) as Vec3);
  };

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
        // `f` is along world axes: a member turned against them takes the length each of its own axes takes.
        const rp = scaled && !isGroup(d) ? resizePatch(d, localFactor(d.rotation, f).f) : {};
        noteResize(d, rp);
        const patch: Partial<Entity> = {
          position: point(d.position),
          rotation: qnorm(qmul(rot, d.rotation)),
          ...rp,
        };
        if (isBody(d) && turns)
          Object.assign(patch, { velocity: mapper.dir(d.velocity), angularVelocity: mapper.dir(d.angularVelocity) });
        out.push([id, patch]);
        if (isBody(d)) bodyMap.set(id, mapper);
      }
    } else {
      if (scaled) {
        const rp = resizePatch(e, f);
        noteResize(e, rp);
        Object.assign(rootPatch, rp);
      }
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

  // Joints: world-frame ends follow the one body they hold; body-local anchors follow their body's resize.
  for (const j of entities) {
    if (!isJoint(j)) continue;
    const effA = j.bodyA !== null ? resized.get(j.bodyA) : undefined;
    const effB = j.bodyB !== null ? resized.get(j.bodyB) : undefined;
    const patch: Partial<JointEntity> = {};
    if (effA) {
      patch.anchorA = [j.anchorA[0] * effA[0], j.anchorA[1] * effA[1], j.anchorA[2] * effA[2]];
      patch.axis = vnorm([j.axis[0] * effA[0], j.axis[1] * effA[1], j.axis[2] * effA[2]], j.axis);
    }
    if (effB) patch.anchorB = [j.anchorB[0] * effB[0], j.anchorB[1] * effB[1], j.anchorB[2] * effB[2]];
    if (effA && effB) {
      const k = effA[0];
      const same = [...effA, ...effB].every((v) => Math.abs(v - k) < 1e-9);
      if (same && j.type === 'spring') patch.spring = { ...j.spring, restLength: j.spring.restLength * k };
      if (same && j.type === 'rope') patch.ropeLength = j.ropeLength * k;
    }
    if ((j.bodyA === null) !== (j.bodyB === null)) {
      const mapper = bodyMap.get((j.bodyA ?? j.bodyB) as string);
      if (mapper) {
        if (j.bodyA === null) {
          patch.anchorA = mapper.point(j.anchorA);
          patch.axis = mapper.dir(j.axis);
        } else patch.anchorB = mapper.point(j.anchorB);
      }
    }
    if (Object.keys(patch).length) out.push([j.id, patch]);
  }
  return out;
}

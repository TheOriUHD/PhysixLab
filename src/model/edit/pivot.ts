/**
 * Pivot editing (pure): rotate or scale the selection about a pivot point or an arbitrary axis, and move a group's
 * own pivot without moving its members.
 *
 * A pivot is where a rotation or scale is centred:
 *   `centre`   the median of the selected entities' origins (what the gizmo handle sits on)
 *   `bounds`   the centre of their joint bounding box
 *   `cursor`   the 3D cursor
 *   `origins`  each entity about its own origin (individual origins)
 *   `group`    each entity about the pivot of the group it is in (its own origin when it is in none)
 *
 * A group's pivot is its own `position` / `rotation` (members keep world poses in the document), so a *custom pivot
 * per group* is simply that pose edited on its own: `groupPivotPatches` / `setGroupPivotPatches` change the group
 * and nothing else, and every later move, rotation or scale of the group is about the new pivot.
 */
import { qfromAxisAngle, qmul, qrot, vadd, vlen, vnorm, vsub, type Quat, type Vec3 } from '../../core/math';
import { childIndex, descendantIds } from '../groups';
import { localFactor } from './groupScale';
import type { Entity, GroupEntity, PosedEntity } from '../types';
import { isBody, isGroup, isPath, isPosed, isSoft } from '../types';
import { aabbCentre, aabbUnion, BoundsContext, type AABB } from './bounds';
import { editableRoots, movePatches, type Patch, type RootMove } from './moves';

export type PivotMode = 'centre' | 'bounds' | 'cursor' | 'origins' | 'group';

export const PIVOT_MODES: readonly { id: PivotMode; label: string; short: string; hint: string }[] = [
  { id: 'centre', short: 'Centre', label: 'Selection centre', hint: 'Median of the selected objects' },
  { id: 'bounds', short: 'Bounds', label: 'Bounds centre', hint: 'Centre of the selection’s bounding box' },
  { id: 'cursor', short: 'Cursor', label: '3D cursor', hint: 'About the 3D cursor' },
  { id: 'origins', short: 'Origins', label: 'Individual origins', hint: 'Each object about its own origin' },
  { id: 'group', short: 'Group', label: 'Group pivot', hint: 'Each object about the pivot of its group' },
];

export interface PivotSpec {
  mode: PivotMode;
  cursor: Vec3;
}

/** Rotate `point` by `angle` (radians, right-handed) about the line through `pivot` along `axis`. */
export function rotatePointAboutAxis(point: Vec3, pivot: Vec3, axis: Vec3, angle: number): Vec3 {
  return vadd(pivot, qrot(qfromAxisAngle(axis, angle), vsub(point, pivot)));
}

/** The pivot point of each root for `spec` (a root id → world point). */
export function pivotPoints(entities: readonly Entity[], roots: readonly string[], spec: PivotSpec): Map<string, Vec3> {
  const c = new BoundsContext(entities);
  const out = new Map<string, Vec3>();
  const ents = roots.map((id) => c.get(id)).filter((e): e is PosedEntity => !!e && isPosed(e));
  let shared: Vec3 | null = null;
  if (spec.mode === 'cursor') shared = spec.cursor;
  else if (spec.mode === 'centre' && ents.length) {
    const s: Vec3 = [0, 0, 0];
    for (const e of ents) {
      s[0] += e.position[0];
      s[1] += e.position[1];
      s[2] += e.position[2];
    }
    shared = [s[0] / ents.length, s[1] / ents.length, s[2] / ents.length];
  } else if (spec.mode === 'bounds') {
    let box: AABB | null = null;
    for (const e of ents) box = aabbUnion(box, c.bounds(e.id));
    shared = box ? aabbCentre(box) : null;
  }
  for (const e of ents) {
    if (shared) out.set(e.id, shared);
    else if (spec.mode === 'group') {
      const g = e.parent !== undefined ? c.get(e.parent) : undefined;
      out.set(e.id, isGroup(g) ? g.position : e.position);
    } else out.set(e.id, e.position);
  }
  return out;
}

export interface RotateAboutOptions {
  /** Rotation axis. In `world` space it is a world direction; in `local` space it is in the active entity's frame. */
  axis: Vec3;
  /** Radians. */
  angle: number;
  space?: 'world' | 'local';
  pivot: PivotSpec;
  /** The entity whose frame `local` refers to (default: the last id). With `origins` each entity uses its own frame. */
  activeId?: string;
}

/**
 * Rotate the top-level entities `angle` about `axis` through their pivot. Positions orbit the pivot and orientations
 * turn with them; a group turns about its pivot carrying its members.
 */
export function rotateAboutPatches(
  entities: readonly Entity[],
  ids: readonly string[],
  o: RotateAboutOptions,
): Patch[] {
  if (vlen(o.axis) < 1e-9 || !Number.isFinite(o.angle) || o.angle === 0) return [];
  const c = new BoundsContext(entities);
  const roots = editableRoots(entities, ids);
  if (!roots.length) return [];
  const pivots = pivotPoints(entities, roots, o.pivot);
  const local = o.space === 'local';
  const activeId = o.activeId !== undefined && roots.includes(o.activeId) ? o.activeId : roots[roots.length - 1];
  const perEntityFrame = o.pivot.mode === 'origins' || o.pivot.mode === 'group';
  const moves: RootMove[] = [];
  for (const id of roots) {
    const e = c.get(id) as PosedEntity;
    const pivot = pivots.get(id);
    if (!pivot) continue;
    const frame = (perEntityFrame ? e : (c.get(activeId) as PosedEntity)).rotation;
    const axisWorld = local ? qrot(frame, vnorm(o.axis)) : vnorm(o.axis);
    const q = qfromAxisAngle(axisWorld, o.angle);
    moves.push({
      id,
      position: vadd(pivot, qrot(q, vsub(e.position, pivot))),
      rotation: qmul(q, e.rotation),
    });
  }
  return movePatches(entities, moves);
}

export interface ScaleAboutOptions {
  /** Size factor per world axis (offsets from the pivot scale along world axes; each entity's size along its own axes). */
  factor: Vec3;
  pivot: PivotSpec;
}

/** Scale the top-level entities about their pivot: offsets from the pivot and the entities' sizes both grow. */
export function scaleAboutPatches(entities: readonly Entity[], ids: readonly string[], o: ScaleAboutOptions): Patch[] {
  const [fx, fy, fz] = o.factor;
  if (![fx, fy, fz].every((f) => Number.isFinite(f) && f > 0)) return [];
  const roots = editableRoots(entities, ids);
  const pivots = pivotPoints(entities, roots, o.pivot);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const moves: RootMove[] = [];
  for (const id of roots) {
    const e = byId.get(id) as PosedEntity;
    const p = pivots.get(id);
    if (!p) continue;
    moves.push({
      id,
      position: [
        p[0] + (e.position[0] - p[0]) * fx,
        p[1] + (e.position[1] - p[1]) * fy,
        p[2] + (e.position[2] - p[2]) * fz,
      ],
      // A group takes the factor along world axes (members are mapped per own axis inside movePatches); a single
      // entity sizes along its own axes, so a turned one gets the length each of its axes takes under the factor.
      scale: isGroup(e) ? [fx, fy, fz] : localFactor(e.rotation, [fx, fy, fz]).f,
    });
  }
  return movePatches(entities, moves);
}

/**
 * True when `factor` is non-uniform and some scaled body / soft body / path is turned against the world axes: it
 * cannot be sheared, so its sizes follow the length each of its own axes takes (the UI says so).
 */
export function scaleAboutIsApproximate(entities: readonly Entity[], ids: readonly string[], factor: Vec3): boolean {
  if (Math.abs(factor[0] - factor[1]) < 1e-9 && Math.abs(factor[1] - factor[2]) < 1e-9) return false;
  const byId = new Map(entities.map((e) => [e.id, e]));
  const index = childIndex(entities);
  for (const id of editableRoots(entities, ids)) {
    const e = byId.get(id);
    if (!e) continue;
    const members = isGroup(e) ? descendantIds(index, id).map((d) => byId.get(d)) : [e];
    for (const m of members) {
      if (!m || !(isBody(m) || isSoft(m) || isPath(m))) continue;
      if (!localFactor(m.rotation, factor).aligned) return true;
    }
  }
  return false;
}

// ── custom pivot of a group ──────────────────────────────────────────────────────────────────────────

export type GroupPivotTarget = 'centre' | 'bounds' | 'bottom' | 'cursor' | 'origin';

/** Change only the group's own pivot pose; members keep their world poses. */
export function setGroupPivotPatches(
  entities: readonly Entity[],
  groupId: string,
  to: { position?: Vec3; rotation?: Quat },
): Patch[] {
  const g = entities.find((e) => e.id === groupId);
  if (!g || !isGroup(g)) return [];
  const patch: Partial<GroupEntity> = {};
  if (to.position) patch.position = [...to.position] as Vec3;
  if (to.rotation) patch.rotation = [...to.rotation] as Quat;
  return Object.keys(patch).length ? [[groupId, patch]] : [];
}

/**
 * Put the pivot of a group at the `centre` (median of its members' origins), the `bounds` centre of its members, the
 * bottom of that box (`bottom`: below the bounds centre — handy for things that stand on the ground), the 3D
 * `cursor` or the world `origin`. `resetRotation` also straightens the pivot's orientation to the world axes.
 * Members do not move.
 */
export function groupPivotPatches(
  entities: readonly Entity[],
  groupId: string,
  target: GroupPivotTarget,
  cursor: Vec3 = [0, 0, 0],
  resetRotation = false,
): Patch[] {
  const c = new BoundsContext(entities);
  const g = c.get(groupId);
  if (!g || !isGroup(g)) return [];
  const members = descendantIds(c.children, groupId)
    .map((id) => c.get(id))
    .filter((e): e is PosedEntity => !!e && isPosed(e) && !isGroup(e));
  let position: Vec3 = g.position;
  if (target === 'cursor') position = cursor;
  else if (target === 'origin') position = [0, 0, 0];
  else if (members.length) {
    if (target === 'centre') {
      const s: Vec3 = [0, 0, 0];
      for (const m of members) {
        s[0] += m.position[0];
        s[1] += m.position[1];
        s[2] += m.position[2];
      }
      position = [s[0] / members.length, s[1] / members.length, s[2] / members.length];
    } else {
      const box = c.bounds(groupId);
      if (box) {
        const mid = aabbCentre(box);
        position = target === 'bottom' ? [mid[0], box.min[1], mid[2]] : mid;
      }
    }
  }
  return setGroupPivotPatches(entities, groupId, {
    position,
    ...(resetRotation ? { rotation: [0, 0, 0, 1] as Quat } : {}),
  });
}

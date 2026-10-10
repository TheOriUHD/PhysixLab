/**
 * Arrangement operations (pure): align, distribute, drop to ground / onto the surface below, stack, centre on the
 * origin and seeded randomisation. Each returns the `[id, Partial<Entity>]` patches `SceneStore.updateMany` applies
 * as ONE undo step; groups carry their members and world-anchored joints follow (see `movePatches`). Locked and
 * hidden entities are never touched, and only top-level entities act (the members of a selected group move with it).
 *
 * Bounds are exact world axis-aligned boxes (`bounds.ts`). "Onto surface" stands on the top of the *bounding box* of
 * whatever is below: for tilted or non-box obstacles that is an AABB approximation (the object rests on the highest
 * point of the obstacle's box, not on its true surface).
 */
import { DEG, lerp, qfromEuler, qmul, type Vec3 } from '../../core/math';
import { Rng } from '../../core/rng';
import { withDescendants } from '../groups';
import type { Entity } from '../types';
import { isBody } from '../types';
import { aabbCentre, aabbOverlapXZ, aabbSize, aabbUnion, BoundsContext, type AABB } from './bounds';
import { editableRoots, movePatches, type Patch, type RootMove } from './moves';

export type Axis = 0 | 1 | 2;
export type AlignMode = 'min' | 'centre' | 'max';
export type AlignTarget = 'selection' | 'active';

const AXIS_INDEX: Record<'x' | 'y' | 'z', Axis> = { x: 0, y: 1, z: 2 };
export const axisIndex = (a: Axis | 'x' | 'y' | 'z'): Axis => (typeof a === 'number' ? a : AXIS_INDEX[a]);

function shifted(c: BoundsContext, id: string, delta: Vec3): RootMove | null {
  const e = c.get(id);
  if (!e || !('position' in e)) return null;
  if (Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]) < 1e-12) return null;
  return { id, position: [e.position[0] + delta[0], e.position[1] + delta[1], e.position[2] + delta[2]] };
}

function toPatches(entities: readonly Entity[], moves: (RootMove | null)[]): Patch[] {
  return movePatches(
    entities,
    moves.filter((m): m is RootMove => m !== null),
  );
}

const along = (axis: Axis, d: number): Vec3 => (axis === 0 ? [d, 0, 0] : axis === 1 ? [0, d, 0] : [0, 0, d]);

// ── align ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Align the bounds of the selected entities on one axis: their min faces, centres or max faces coincide with those
 * of the whole selection (`target: 'selection'`) or of the active entity (`activeId`, default the last id), which
 * itself stays put.
 */
export function alignPatches(
  entities: readonly Entity[],
  ids: readonly string[],
  axis: Axis | 'x' | 'y' | 'z',
  mode: AlignMode,
  target: AlignTarget = 'selection',
  activeId?: string,
): Patch[] {
  const a = axisIndex(axis);
  const c = new BoundsContext(entities);
  const movable = editableRoots(entities, ids);
  const all = c.roots(ids);
  if (!movable.length) return [];
  let ref: AABB | null = null;
  let active: string | undefined;
  if (target === 'active') {
    active = activeId !== undefined && all.includes(activeId) ? activeId : all[all.length - 1];
    ref = active ? c.bounds(active) : null;
  } else {
    for (const id of all) ref = aabbUnion(ref, c.bounds(id));
  }
  if (!ref) return [];
  const pick = (b: AABB): number => (mode === 'min' ? b.min[a] : mode === 'max' ? b.max[a] : aabbCentre(b)[a]);
  const want = pick(ref);
  return toPatches(
    entities,
    movable.map((id) => {
      if (id === active) return null;
      const b = c.bounds(id);
      return b ? shifted(c, id, along(a, want - pick(b))) : null;
    }),
  );
}

// ── distribute ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Even spacing along one axis for three or more entities. Ordered by their centres, the first and the last stay;
 * `spacing` puts the centres at equal distances, `gaps` leaves equal empty space between neighbouring bounds.
 */
export function distributePatches(
  entities: readonly Entity[],
  ids: readonly string[],
  axis: Axis | 'x' | 'y' | 'z',
  mode: 'spacing' | 'gaps',
): Patch[] {
  const a = axisIndex(axis);
  const c = new BoundsContext(entities);
  const movable = new Set(editableRoots(entities, ids));
  const items = c
    .roots(ids)
    .map((id) => ({ id, b: c.bounds(id) as AABB }))
    .filter((i) => i.b)
    .sort((p, q) => aabbCentre(p.b)[a] - aabbCentre(q.b)[a]);
  if (items.length < 3) return [];
  const n = items.length;
  const first = items[0].b;
  const last = items[n - 1].b;
  const moves: (RootMove | null)[] = [];
  if (mode === 'spacing') {
    const c0 = aabbCentre(first)[a];
    const c1 = aabbCentre(last)[a];
    items.forEach((it, i) => {
      if (!movable.has(it.id)) return;
      moves.push(shifted(c, it.id, along(a, lerp(c0, c1, i / (n - 1)) - aabbCentre(it.b)[a])));
    });
  } else {
    const total = items.reduce((s, it) => s + aabbSize(it.b)[a], 0);
    const gap = (last.max[a] - first.min[a] - total) / (n - 1);
    let cursor = first.min[a];
    items.forEach((it) => {
      if (movable.has(it.id)) moves.push(shifted(c, it.id, along(a, cursor - it.b.min[a])));
      cursor += aabbSize(it.b)[a] + gap;
    });
  }
  return toPatches(entities, moves);
}

// ── drop ────────────────────────────────────────────────────────────────────────────────────────────

export interface DropOptions {
  /** Is there a ground to land on? Without one nothing can be dropped onto "the ground". Default true. */
  ground?: boolean;
  /** Height of the ground surface. Default 0. */
  groundY?: number;
}

/** Lower or raise every top-level entity so its lowest point touches the ground plane (each on its own). */
export function dropToGroundPatches(
  entities: readonly Entity[],
  ids: readonly string[],
  opts: DropOptions = {},
): Patch[] {
  if (opts.ground === false) return [];
  const y = opts.groundY ?? 0;
  const c = new BoundsContext(entities);
  return toPatches(
    entities,
    editableRoots(entities, ids).map((id) => {
      const b = c.bounds(id);
      return b ? shifted(c, id, [0, y - b.min[1], 0]) : null;
    }),
  );
}

/**
 * Rest every top-level entity on whatever is below it: the highest body (not part of the selection, not hidden)
 * whose XZ bounds overlap and whose top is at or below the entity's centre; otherwise the ground. Entities are
 * settled from the lowest up and an already placed one counts as a surface for the next, so a loose heap lands as a
 * stack. AABB approximation — see the file header.
 */
export function dropOntoSurfacePatches(
  entities: readonly Entity[],
  ids: readonly string[],
  opts: DropOptions = {},
): Patch[] {
  const groundOn = opts.ground !== false;
  const groundY = opts.groundY ?? 0;
  const c = new BoundsContext(entities);
  const roots = editableRoots(entities, ids);
  const moving = withDescendants(entities, ids);
  const surfaces: AABB[] = [];
  for (const e of entities) {
    if (!isBody(e) || moving.has(e.id) || e.hidden) continue;
    const b = c.bounds(e.id);
    if (b) surfaces.push(b);
  }
  const items = roots
    .map((id) => ({ id, b: c.bounds(id) }))
    .filter((i): i is { id: string; b: AABB } => !!i.b)
    .sort((p, q) => p.b.min[1] - q.b.min[1]);
  const moves: (RootMove | null)[] = [];
  for (const it of items) {
    const mid = aabbCentre(it.b)[1];
    let top = groundOn ? groundY : -Infinity;
    for (const s of surfaces) if (s.max[1] <= mid + 1e-9 && s.max[1] > top && aabbOverlapXZ(it.b, s)) top = s.max[1];
    if (top === -Infinity) continue; // nothing below and no ground
    const dy = top - it.b.min[1];
    moves.push(shifted(c, it.id, [0, dy, 0]));
    surfaces.push({
      min: [it.b.min[0], it.b.min[1] + dy, it.b.min[2]],
      max: [it.b.max[0], it.b.max[1] + dy, it.b.max[2]],
    });
  }
  return toPatches(entities, moves);
}

// ── stack ───────────────────────────────────────────────────────────────────────────────────────────

export interface StackOptions {
  /** Empty space between neighbours, metres. Default 0. */
  gap?: number;
  /** `selection`: pile in selection order from the first; `height`: lowest first. Default `selection`. */
  order?: 'selection' | 'height';
  /** Centre every entity above the first one's XZ centre (a tidy pile). Default true. */
  centreXZ?: boolean;
}

/** Pile the entities vertically, the first one staying where it is, each next one resting `gap` above the last. */
export function stackPatches(entities: readonly Entity[], ids: readonly string[], opts: StackOptions = {}): Patch[] {
  const gap = opts.gap ?? 0;
  const c = new BoundsContext(entities);
  let items = editableRoots(entities, ids)
    .map((id) => ({ id, b: c.bounds(id) }))
    .filter((i): i is { id: string; b: AABB } => !!i.b);
  if (items.length < 2) return [];
  if (opts.order === 'height') items = [...items].sort((p, q) => p.b.min[1] - q.b.min[1]);
  const base = aabbCentre(items[0].b);
  let top = items[0].b.max[1];
  const moves: (RootMove | null)[] = [];
  for (const it of items.slice(1)) {
    const cen = aabbCentre(it.b);
    const dx = opts.centreXZ === false ? 0 : base[0] - cen[0];
    const dz = opts.centreXZ === false ? 0 : base[2] - cen[2];
    const dy = top + gap - it.b.min[1];
    moves.push(shifted(c, it.id, [dx, dy, dz]));
    top += gap + aabbSize(it.b)[1];
  }
  return toPatches(entities, moves);
}

// ── centre on origin ────────────────────────────────────────────────────────────────────────────────

/** Move the selection (as one block) so the centre of its bounds sits at the origin on the chosen axes. */
export function centreOnOriginPatches(
  entities: readonly Entity[],
  ids: readonly string[],
  axes: readonly [boolean, boolean, boolean] = [true, true, true],
): Patch[] {
  const c = new BoundsContext(entities);
  const roots = editableRoots(entities, ids);
  let box: AABB | null = null;
  for (const id of roots) box = aabbUnion(box, c.bounds(id));
  if (!box) return [];
  const cen = aabbCentre(box);
  const d: Vec3 = [axes[0] ? -cen[0] : 0, axes[1] ? -cen[1] : 0, axes[2] ? -cen[2] : 0];
  return toPatches(
    entities,
    roots.map((id) => shifted(c, id, d)),
  );
}

// ── randomise ───────────────────────────────────────────────────────────────────────────────────────

export interface RandomiseOptions {
  /** Each axis moves by a random offset in [-range, +range], metres. */
  position: Vec3;
  /** Each axis turns (about the world axes, around the entity's own pivot) by a random angle in [-range, +range], degrees. */
  rotation: Vec3;
  /** Size factors drawn from [min, max]; `uniform` draws one factor for all axes (from `min[0]`..`max[0]`). */
  scale: { min: Vec3; max: Vec3; uniform: boolean };
  /** Unsigned 32-bit seed: the same seed on the same selection gives the identical result. */
  seed: number;
}

export const DEFAULT_RANDOMISE: RandomiseOptions = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: { min: [1, 1, 1], max: [1, 1, 1], uniform: true },
  seed: 1,
};

/**
 * Jitter position, rotation and size of the top-level entities with a seeded generator. Entities are visited in
 * document order (not selection order) and every entity consumes the same nine draws, so the result depends only on
 * the seed and on which entities are selected.
 */
export function randomisePatches(entities: readonly Entity[], ids: readonly string[], opts: RandomiseOptions): Patch[] {
  const wanted = new Set(editableRoots(entities, ids));
  const rng = new Rng(opts.seed);
  const moves: RootMove[] = [];
  for (const e of entities) {
    if (!wanted.has(e.id) || !('position' in e)) continue;
    const dp: Vec3 = [
      rng.range(-1, 1) * opts.position[0],
      rng.range(-1, 1) * opts.position[1],
      rng.range(-1, 1) * opts.position[2],
    ];
    const dr: Vec3 = [
      rng.range(-1, 1) * opts.rotation[0] * DEG,
      rng.range(-1, 1) * opts.rotation[1] * DEG,
      rng.range(-1, 1) * opts.rotation[2] * DEG,
    ];
    const u: Vec3 = [rng.next(), rng.next(), rng.next()];
    const { min, max, uniform } = opts.scale;
    const f: Vec3 = uniform
      ? [lerp(min[0], max[0], u[0]), lerp(min[0], max[0], u[0]), lerp(min[0], max[0], u[0])]
      : [lerp(min[0], max[0], u[0]), lerp(min[1], max[1], u[1]), lerp(min[2], max[2], u[2])];
    const move: RootMove = { id: e.id };
    if (dp.some((v) => v !== 0)) move.position = [e.position[0] + dp[0], e.position[1] + dp[1], e.position[2] + dp[2]];
    if (dr.some((v) => v !== 0)) move.rotation = qmul(qfromEuler(dr), e.rotation);
    if (f.some((v) => v !== 1)) move.scale = f;
    if (move.position || move.rotation || move.scale) moves.push(move);
  }
  return movePatches(entities, moves);
}

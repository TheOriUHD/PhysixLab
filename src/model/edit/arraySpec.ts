/**
 * ED-12: the stored definition of a *linked* array — kept on the `group` that holds the generated instances
 * (`GroupEntity.array`). Pure data + its sanitiser, so `sanitize/kinds.ts` can import it without pulling in the
 * store. The generators that turn a spec into poses live in `arrays.ts`.
 */
import { clamp, type Vec3 } from '../../core/math';
import { idStr, isFiniteVec, num, obj, oneOf } from '../sanitize/primitives';

export type ArrayKind = 'linear' | 'grid' | 'radial' | 'path';
export const ARRAY_KINDS: readonly ArrayKind[] = ['linear', 'grid', 'radial', 'path'];
export const ARRAY_KIND_LABELS: Record<ArrayKind, string> = {
  linear: 'Linear',
  grid: 'Grid',
  radial: 'Radial',
  path: 'Along path',
};

/** The most instances one array may generate (per source set), to keep a typo from freezing the editor. */
export const MAX_ARRAY_INSTANCES = 2000;

export interface LinearSpec {
  kind: 'linear';
  /** Total number of copies INCLUDING the original (>= 2 makes sense; 1 = just the original). */
  count: number;
  /** Step between neighbours, world metres. */
  offset: Vec3;
  /** Extra rotation per step as Euler angles in degrees (XYZ), about the copy's own centre. */
  stepRotation: Vec3;
  /** Size factor per step (1 = none, 1.1 = each copy 10 % larger than the previous one). */
  stepScale: number;
}

export interface GridSpec {
  kind: 'grid';
  /** Copies along x, y, z INCLUDING the original (so 3 x 2 x 1 = 6 copies). */
  counts: [number, number, number];
  /** Distance between neighbouring cells along x, y, z (metres). */
  spacing: Vec3;
}

export interface RadialSpec {
  kind: 'radial';
  /** Total number of copies INCLUDING the original. */
  count: number;
  /** A point on the axis (world). */
  center: Vec3;
  /** Axis direction (world; normalised on use). */
  axis: Vec3;
  /** Sweep in degrees: 360 = full circle (no duplicate at the end); less = an arc whose ends are both occupied. */
  angle: number;
  /** Turn each copy with the circle (spokes) instead of keeping its orientation. */
  orient: boolean;
}

export interface PathArraySpec {
  kind: 'path';
  /** Id of the `PathEntity` to follow. */
  pathId: string;
  /** Number of copies placed on the path (the original stays where it is). */
  count: number;
  /** Turn each copy so the original's `forward` axis points along the path. */
  orient: boolean;
  forward: 'x' | 'y' | 'z';
  /** Shift of every copy from the path point: in the path-aligned frame when oriented, in world axes otherwise. */
  offset: Vec3;
}

export type ArraySpec = LinearSpec | GridSpec | RadialSpec | PathArraySpec;

/** What a group stores to stay a re-editable array. */
export interface ArrayDef {
  /** Ids of the entities the instances are copies of (they stay editable, outside the group). */
  sourceIds: string[];
  spec: ArraySpec;
}

export function defaultSpec(kind: ArrayKind): ArraySpec {
  switch (kind) {
    case 'linear':
      return { kind, count: 5, offset: [1.5, 0, 0], stepRotation: [0, 0, 0], stepScale: 1 };
    case 'grid':
      return { kind, counts: [3, 1, 3], spacing: [1.5, 1.5, 1.5] };
    case 'radial':
      return { kind, count: 8, center: [0, 0, 0], axis: [0, 1, 0], angle: 360, orient: true };
    case 'path':
      return { kind, pathId: '', count: 8, orient: true, forward: 'x', offset: [0, 0, 0] };
  }
}

/** Copies a spec generates (including the original where the kind counts it). */
export function specInstanceCount(s: ArraySpec): number {
  return s.kind === 'grid' ? s.counts[0] * s.counts[1] * s.counts[2] : s.count;
}

const cnt = (x: unknown, d: number): number => clamp(Math.round(num(x, d)), 1, MAX_ARRAY_INSTANCES);
const vec = (x: unknown, d: Vec3, lim = 1e5): Vec3 =>
  isFiniteVec(x, 3) ? [clamp(x[0], -lim, lim), clamp(x[1], -lim, lim), clamp(x[2], -lim, lim)] : [...d];

/** Repair a raw spec (untrusted JSON). Unknown kinds fall back to a linear array. Never throws. */
export function sanitizeArraySpec(input: unknown): ArraySpec {
  const raw = obj(input);
  const kind = oneOf(raw.kind, ARRAY_KINDS, 'linear');
  const d = defaultSpec(kind);
  switch (d.kind) {
    case 'linear':
      return {
        kind: 'linear',
        count: cnt(raw.count, d.count),
        offset: vec(raw.offset, d.offset),
        stepRotation: vec(raw.stepRotation, d.stepRotation, 36000),
        stepScale: clamp(num(raw.stepScale, 1), 0.05, 20),
      };
    case 'grid': {
      const c = isFiniteVec(raw.counts, 3) ? raw.counts : d.counts;
      let counts: [number, number, number] = [cnt(c[0], 1), cnt(c[1], 1), cnt(c[2], 1)];
      // Never accept a product above the cap: shrink the largest axis until it fits.
      while (counts[0] * counts[1] * counts[2] > MAX_ARRAY_INSTANCES) {
        const i = counts.indexOf(Math.max(...counts));
        counts = counts.map((v, j) => (j === i ? v - 1 : v)) as [number, number, number];
      }
      return { kind: 'grid', counts, spacing: vec(raw.spacing, d.spacing) };
    }
    case 'radial':
      return {
        kind: 'radial',
        count: cnt(raw.count, d.count),
        center: vec(raw.center, d.center, 1e6),
        axis: vec(raw.axis, d.axis, 1e6),
        angle: clamp(num(raw.angle, 360), -3600, 3600),
        orient: raw.orient === undefined ? true : raw.orient === true,
      };
    case 'path':
      return {
        kind: 'path',
        pathId: idStr(raw.pathId, ''),
        count: cnt(raw.count, d.count),
        orient: raw.orient === undefined ? true : raw.orient === true,
        forward: oneOf(raw.forward, ['x', 'y', 'z'] as const, 'x'),
        offset: vec(raw.offset, d.offset),
      };
  }
}

/** A stored array definition, or undefined when the field is absent / has no sources. */
export function sanitizeArrayDef(input: unknown): ArrayDef | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = obj(input);
  const ids = Array.isArray(raw.sourceIds)
    ? (raw.sourceIds as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 256)
    : [];
  if (!ids.length) return undefined;
  return { sourceIds: ids.map((s) => idStr(s, '')), spec: sanitizeArraySpec(raw.spec) };
}

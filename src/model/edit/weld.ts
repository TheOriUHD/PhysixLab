/**
 * Welding a set of bodies into one rigid assembly (pure). The weld is a spanning tree of `fixed` joints — n bodies
 * need n−1 joints — chosen by proximity (minimum spanning tree over centre distances), so the links are short and
 * the assembly does not get long diagonal braces. Two static bodies are never linked (they are already immovable);
 * bodies that are already connected by weld joints are respected, so welding twice adds nothing.
 */
import { qrotInv, vdist, vsub, type Quat, type Vec3 } from '../../core/math';
import { createJoint } from '../factory';
import type { BodyEntity, Entity, JointEntity } from '../types';
import { isJoint } from '../types';

/** Name prefix that marks a joint as made by "Weld group" (survives save / load: names are persisted). */
export const WELD_PREFIX = 'Group weld';

export const isWeldJoint = (e: Entity): e is JointEntity =>
  isJoint(e) && e.type === 'fixed' && e.name.startsWith(WELD_PREFIX);

export type WeldBody = Pick<BodyEntity, 'id' | 'position' | 'rotation' | 'bodyType'>;

/** Nearest neighbours per body that seed the spanning tree (the rest is joined by the closest-pair fallback). */
const WELD_NEIGHBOURS = 8;

/**
 * Candidate edges from a uniform hash grid: every body is paired with its `k` nearest bodies among the 27 cells around
 * it, so the work is ~O(n·k) instead of O(n²) for n bodies spread in space.
 */
function nearestCandidates(
  bodies: readonly Pick<WeldBody, 'position'>[],
  k: number,
  skip: (a: number, b: number) => boolean,
): [number, number][] {
  const n = bodies.length;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], b.position[i]);
      hi[i] = Math.max(hi[i], b.position[i]);
    }
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const maxExt = Math.max(...ext);
  if (!(maxExt > 0)) return []; // all at one point: the fallback links them
  const real = ext.filter((e) => e > maxExt * 1e-6);
  const cell = Math.max(maxExt * 1e-6, Math.pow(real.reduce((a, e) => a * e, 1) / n, 1 / real.length));
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const cellOf = (p: Vec3) => [0, 1, 2].map((i) => Math.floor((p[i] - lo[i]) / cell));
  const grid = new Map<string, number[]>();
  const cells = bodies.map((b) => cellOf(b.position));
  cells.forEach((c, i) => {
    const kk = key(c[0], c[1], c[2]);
    const l = grid.get(kk);
    if (l) l.push(i);
    else grid.set(kk, [i]);
  });
  const out: [number, number][] = [];
  for (let a = 0; a < n; a++) {
    const [cx, cy, cz] = cells[a];
    const near: { b: number; d: number }[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const b of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            if (b === a || skip(a, b)) continue;
            near.push({ b, d: vdist(bodies[a].position, bodies[b].position) });
          }
    near.sort((x, y) => x.d - y.d || x.b - y.b);
    for (const c of near.slice(0, k)) out.push([Math.min(a, c.b), Math.max(a, c.b)]);
  }
  return out;
}

/** Pairs of body indices to join: Kruskal over proximity (grid-seeded neighbour edges), skipping static–static pairs and already-joined bodies. */
export function weldEdges(
  bodies: readonly Pick<WeldBody, 'id' | 'position' | 'bodyType'>[],
  alreadyJoined: readonly [string, string][] = [],
): [number, number][] {
  const n = bodies.length;
  const parent = bodies.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const idx = new Map(bodies.map((b, i) => [b.id, i]));
  for (const [a, b] of alreadyJoined) {
    const ia = idx.get(a);
    const ib = idx.get(b);
    if (ia !== undefined && ib !== undefined) parent[find(ia)] = find(ib);
  }
  const bothStatic = (a: number, b: number) => bodies[a].bodyType === 'static' && bodies[b].bodyType === 'static';
  const dist = (a: number, b: number) => vdist(bodies[a].position, bodies[b].position);
  const edges: { a: number; b: number; d: number }[] = [];
  for (const [a, b] of nearestCandidates(bodies, WELD_NEIGHBOURS, bothStatic)) edges.push({ a, b, d: dist(a, b) });
  edges.sort((x, y) => x.d - y.d || x.a - y.a || x.b - y.b);
  const out: [number, number][] = [];
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent[ra] = rb;
    out.push([e.a, e.b]);
  }
  // Components the neighbour graph left apart: join them by closest pairs (smallest component first).
  for (;;) {
    const comps = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      const l = comps.get(r);
      if (l) l.push(i);
      else comps.set(r, [i]);
    }
    if (comps.size <= 1) break;
    let progressed = false;
    // A component that cannot be joined (only static bodies left) is skipped; try the next smallest.
    for (const members of [...comps.values()].sort((x, y) => x.length - y.length || x[0] - y[0])) {
      let best: { a: number; b: number; d: number } | null = null;
      const root = find(members[0]);
      for (const a of members)
        for (let b = 0; b < n; b++) {
          if (find(b) === root || bothStatic(a, b)) continue;
          const d = dist(a, b);
          if (!best || d < best.d || (d === best.d && (a < best.a || (a === best.a && b < best.b)))) best = { a, b, d };
        }
      if (!best) continue;
      parent[find(best.a)] = find(best.b);
      out.push([Math.min(best.a, best.b), Math.max(best.a, best.b)]);
      progressed = true;
      break;
    }
    if (!progressed) break;
  }
  return out;
}

/** A fixed joint between two bodies, anchored at the midpoint between their centres (anchors are body-local). */
export function weldJoint(a: WeldBody, b: WeldBody, name: string): JointEntity {
  const mid: Vec3 = [
    (a.position[0] + b.position[0]) / 2,
    (a.position[1] + b.position[1]) / 2,
    (a.position[2] + b.position[2]) / 2,
  ];
  const local = (p: Vec3, q: Quat, at: Vec3): Vec3 => qrotInv(q, vsub(at, p));
  return createJoint({
    type: 'fixed',
    name,
    bodyA: a.id,
    bodyB: b.id,
    anchorA: local(a.position, a.rotation, mid),
    anchorB: local(b.position, b.rotation, mid),
  });
}

/** The weld joints that connect bodies in `bodyIds` (what "Unweld" removes). */
export function weldJointsAmong(entities: readonly Entity[], bodyIds: ReadonlySet<string>): JointEntity[] {
  return entities.filter(
    (e): e is JointEntity =>
      isWeldJoint(e) && e.bodyA !== null && e.bodyB !== null && bodyIds.has(e.bodyA) && bodyIds.has(e.bodyB),
  );
}

/** The joints to add to weld `bodies` (named after the group). `existing` = weld joints already among them. */
export function planWeld(
  bodies: readonly WeldBody[],
  existing: readonly JointEntity[],
  groupName: string,
): JointEntity[] {
  const edges = weldEdges(
    bodies,
    existing.filter((j) => j.bodyA && j.bodyB).map((j): [string, string] => [j.bodyA!, j.bodyB!]),
  );
  return edges.map(([a, b], i) =>
    weldJoint(bodies[a], bodies[b], `${WELD_PREFIX}: ${groupName} ${existing.length + i + 1}`),
  );
}

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

/** Pairs of body indices to join: Kruskal over proximity, skipping static–static pairs and already-joined bodies. */
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
  const edges: { a: number; b: number; d: number }[] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      if (bodies[a].bodyType === 'static' && bodies[b].bodyType === 'static') continue;
      edges.push({ a, b, d: vdist(bodies[a].position, bodies[b].position) });
    }
  edges.sort((x, y) => x.d - y.d || x.a - y.a || x.b - y.b);
  const out: [number, number][] = [];
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent[ra] = rb;
    out.push([e.a, e.b]);
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

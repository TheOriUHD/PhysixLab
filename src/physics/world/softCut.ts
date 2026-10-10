/**
 * Cutting and tearing on demand (SF-2). A cut is a triangle (viewer position + the two ends of the dragged line):
 * the engine severs every edge / cell crossing it, pieces that fall apart become soft bodies of their own, and the
 * topology change reaches the renderer through the usual layout signature.
 */
import type { Vec3 } from '../../core/math';
import { piecesOf } from './soft';
import type { WorldState } from './state';

/** Cut soft body `id` with the triangle `origin`, `a`, `b` (world space). Returns the number of pieces that changed. */
export function cutSoft(s: WorldState, id: string, origin: Vec3, a: Vec3, b: Vec3): number {
  const rec = s.softs.get(id);
  if (!rec) return 0;
  let changed = 0;
  const tri = [origin, a, b].map((p) => ({ x: p[0], y: p[1], z: p[2] }));
  for (const sb of piecesOf(s, rec)) {
    if (!sb.isValid()) continue;
    const ev = s.world.cutSoftBody(sb, tri);
    if (ev) {
      changed += ev.tornEdges().length + ev.tornCells().length;
      ev.free();
    }
  }
  if (changed) {
    s.softSig = '';
    s.layoutVersion++;
    for (const sb of piecesOf(s, rec)) sb.wakeUp();
  }
  return changed;
}

/** Tear a hole: sever every edge with an endpoint within `radius` of the world point (tear-on-demand command). */
export function tearSoftAt(s: WorldState, id: string, point: Vec3, radius: number): number {
  const rec = s.softs.get(id);
  if (!rec) return 0;
  let changed = 0;
  for (const sb of piecesOf(s, rec)) {
    if (!sb.isValid()) continue;
    const pos = sb.particlePositions();
    const edges = sb.edges();
    const cut: number[] = [];
    const r2 = radius * radius;
    for (let e = 0; e < edges.length / 2; e++) {
      for (let k = 0; k < 2; k++) {
        const i = edges[2 * e + k];
        const dx = pos[3 * i] - point[0],
          dy = pos[3 * i + 1] - point[1],
          dz = pos[3 * i + 2] - point[2];
        if (dx * dx + dy * dy + dz * dz <= r2) {
          cut.push(e);
          break;
        }
      }
    }
    if (!cut.length) continue;
    const ev = s.world.tearSoftBody(sb, cut, []);
    if (ev) {
      changed += ev.tornEdges().length;
      ev.free();
    }
  }
  if (changed) {
    s.softSig = '';
    s.layoutVersion++;
  }
  return changed;
}

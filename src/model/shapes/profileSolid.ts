/**
 * Solids made by extruding a *top profile* — the curved ramp, the quarter-pipe and the half-pipe.
 *
 * The solid is everything between the flat bottom of the size box and a polyline `top` that runs across the box
 * (monotone in its first coordinate, from −½ to +½) and is extruded across the box's other horizontal axis. It is
 * described in unit coordinates, so the mesh is shared by every size and the colliders, the mesh and the volume are
 * one polyhedron under the same stretch: the volume is the unit area times `width · height · depth`.
 *
 * Decomposition into convex pieces (so a ramp works dynamic or static, with no triangle mesh): the region under a
 * *concave* stretch of the top (slopes never increasing) is convex, so each maximal concave run of the polyline is one
 * hull; where the top curves the other way (the floor of a pipe, the sweep of a ramp) every segment is its own
 * vertical slab. The pieces tile the solid without overlap, so the engine's mass equals `density × volume`.
 */
import type { BufferGeometry } from 'three';
import type { Vec3 } from '../../core/math';
import type { GeometryKit, RapierModule, ShapeCollider } from '../shapeRegistry';
import { extrudeOutline, MeshBuilder, signedArea, type P2 } from './meshKit';
import { convexHull3, isEngineSafe } from './hull3';
import { hullPart } from './parts';

/** Which world axis the profile's first coordinate runs along; the other horizontal axis is the extrusion. */
export type ProfileAxis = 'x' | 'z';

/** Maximal runs of consecutive top points whose slopes never increase (the region under each run is convex). */
export function concaveRuns(top: readonly P2[]): P2[][] {
  const runs: P2[][] = [];
  let run: P2[] = [top[0], top[1]];
  let lastSlope = slope(top[0], top[1]);
  for (let i = 1; i + 1 < top.length; i++) {
    const s = slope(top[i], top[i + 1]);
    if (s <= lastSlope + 1e-9) {
      run.push(top[i + 1]);
    } else {
      runs.push(run);
      run = [top[i], top[i + 1]];
    }
    lastSlope = s;
  }
  runs.push(run);
  return runs;
}

const slope = (a: P2, b: P2): number => (b[1] - a[1]) / Math.max(1e-12, b[0] - a[0]);

/** The solid's outline in unit coordinates, counter-clockwise: the bottom edge, up the high end, back along the top. */
export function profileOutline(top: readonly P2[], bottom = -0.5): P2[] {
  const first = top[0],
    last = top[top.length - 1];
  const out: P2[] = [
    [first[0], bottom],
    [last[0], bottom],
  ];
  for (let i = top.length - 1; i >= 0; i--) out.push(top[i]);
  return out;
}

/** Area of the unit profile. */
export function profileArea(top: readonly P2[], bottom = -0.5): number {
  return signedArea(profileOutline(top, bottom));
}

/** The convex pieces as hull point sets (unit coordinates, first coordinate along `axis`, extruded over ±½). */
export function profilePieces(top: readonly P2[], axis: ProfileAxis, bottom = -0.5): Vec3[][] {
  return profilePiecesOf(concaveRuns(top), axis, bottom);
}

/** The hull point set of each given run of the top. */
function profilePiecesOf(runs: P2[][], axis: ProfileAxis, bottom = -0.5): Vec3[][] {
  return runs.map((run) => {
    const pts: P2[] = [[run[0][0], bottom], ...run, [run[run.length - 1][0], bottom]];
    const out: Vec3[] = [];
    for (const [u, y] of pts) for (const w of [-0.5, 0.5]) out.push(axis === 'z' ? [w, y, u] : [u, y, w]);
    return out;
  });
}

/** Rapier colliders of the pieces at a real size. */
export function profileColliders(R: RapierModule, top: readonly P2[], axis: ProfileAxis, size: Vec3): ShapeCollider[] {
  return profilePieces(top, axis).map((pts) =>
    hullPart(
      R,
      pts.map((p): Vec3 => [p[0] * size[0], p[1] * size[1], p[2] * size[2]]),
    ),
  );
}

function pieceIsSafe(run: readonly P2[], axis: ProfileAxis, size: Vec3): boolean {
  const piece = profilePiecesOf([[...run]], axis)[0];
  const hull = convexHull3(piece.map((p): Vec3 => [p[0] * size[0], p[1] * size[1], p[2] * size[2]]));
  return !hull || isEngineSafe(hull);
}

/**
 * The top with just enough vertices removed that the engine can integrate every piece at this size, and whether that
 * worked. A very narrow or very tall shape has steep stretches whose vertical neighbour faces meet at under a couple
 * of degrees (see `hull3.ts`); the vertex between such a piece and its thinner neighbour is dropped, which turns the
 * two stretches into one longer chord — the mesh and the volume use the same shortened top, so nothing disagrees.
 */
export function repairTop(top: readonly P2[], axis: ProfileAxis, size: Vec3): { top: P2[]; safe: boolean } {
  let cur = [...top];
  for (let guard = 0; guard < top.length; guard++) {
    const runs = concaveRuns(cur);
    const bad = runs.findIndex((run) => !pieceIsSafe(run, axis, size));
    if (bad < 0) return { top: cur, safe: true };
    if (runs.length === 1) return { top: cur, safe: false };
    const width = (run: readonly P2[]) => Math.abs(run[run.length - 1][0] - run[0][0]);
    const left = bad > 0 ? runs[bad - 1] : null,
      right = bad + 1 < runs.length ? runs[bad + 1] : null;
    const useLeft = left && (!right || width(left) <= width(right));
    const shared = useLeft ? runs[bad][0] : runs[bad][runs[bad].length - 1];
    cur = cur.filter((p) => p !== shared);
  }
  return { top: cur, safe: false };
}

/**
 * The finest top the engine can integrate at this size: `build(segments)` for `wanted` segments, repaired; with fewer
 * segments (a gentle curve cut into many facets has neighbouring faces under 2.5° apart) when it cannot be made safe.
 */
export function safeTop(
  build: (segments: number) => P2[],
  wanted: number,
  axis: ProfileAxis,
  size: Vec3,
): { top: P2[]; repaired: boolean } {
  let last: { top: P2[]; repaired: boolean } | null = null;
  for (let segments = wanted; segments >= 3; segments--) {
    const own = build(segments);
    const fixed = repairTop(own, axis, size);
    last = { top: fixed.top, repaired: segments !== wanted || fixed.top.length !== own.length };
    if (fixed.safe) return last;
  }
  return last ?? { top: build(wanted), repaired: false };
}

/** Mesh of the unit solid: the outline extruded across ±½ with smooth shading along curved stretches. */
export function profileGeometry(T: GeometryKit, top: readonly P2[], axis: ProfileAxis): BufferGeometry {
  const b = new MeshBuilder();
  b.crease = 40;
  // the outline is (u, y); the extrusion axis is w
  extrudeOutline(b, profileOutline(top), -0.5, 0.5, axis === 'z' ? (u, v, w) => [w, v, u] : (u, v, w) => [u, v, w]);
  return b.build(T);
}

/** Convex points of every piece — for tests and bounding radii. */
export function profilePoints(top: readonly P2[], axis: ProfileAxis, size: Vec3): Vec3[] {
  return profilePieces(top, axis).flatMap((pts) =>
    pts.map((p): Vec3 => [p[0] * size[0], p[1] * size[1], p[2] * size[2]]),
  );
}

/**
 * The ramp's top: a circular arc (stretched to the box) that leaves the low end tangent to the floor and turns by
 * `arcDeg`, from z = −½ to +½, with a minimum thickness `base` (fraction of the height) at the low end and an
 * optional flat `deck` (fraction of the depth) at the high end. `convex` mirrors the arc: it leaves the low end
 * steeply and flattens out at the top, a hill rather than a launch ramp.
 */
export function rampTop(arcDeg: number, convex: boolean, base: number, deck: number, segments: number): P2[] {
  const arc = (Math.max(1, Math.min(90, arcDeg)) * Math.PI) / 180;
  const curveEnd = 0.5 - deck; // the deck takes this fraction of the depth from the high end
  const z0 = -0.5;
  const out: P2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (arc * i) / segments;
    // normalised arc coordinates in 0..1
    const gz = Math.sin(t) / Math.sin(arc);
    const gy = (1 - Math.cos(t)) / (1 - Math.cos(arc));
    // concave: (gz, gy); convex: the same arc turned half a revolution about the middle of the box
    const [uz, uy] = convex
      ? [1 - Math.sin(arc - t) / Math.sin(arc), 1 - (1 - Math.cos(arc - t)) / (1 - Math.cos(arc))]
      : [gz, gy];
    out.push([z0 + (curveEnd - z0) * uz, -0.5 + base + (1 - base) * uy]);
  }
  if (deck > 1e-9) out.push([0.5, 0.5]);
  return out;
}

/**
 * The pipe's top across x: decks at both sides, then an elliptical concave quarter arc down to the floor on each side
 * and a flat bottom of width `flat` (fraction of the trough) between them. `floor` is the thickness under the lowest
 * point (fraction of the height).
 */
export function pipeTop(floor: number, deck: number, flat: number, segments: number): P2[] {
  const yTop = 0.5,
    yFloor = -0.5 + floor;
  const half = 0.5 * (1 - deck); // trough half width
  const flatHalf = half * flat;
  const arcWidth = half - flatHalf;
  const right: P2[] = [];
  right.push([0, yFloor]);
  if (flatHalf > 1e-9) right.push([flatHalf, yFloor]);
  for (let i = 1; i <= segments; i++) {
    const phi = ((Math.PI / 2) * i) / segments;
    right.push([flatHalf + arcWidth * Math.sin(phi), yFloor + (yTop - yFloor) * (1 - Math.cos(phi))]);
  }
  if (deck > 1e-9) right.push([0.5, yTop]);
  const left: P2[] = right
    .slice(1)
    .reverse()
    .map(([x, y]): P2 => [-x, y]);
  return [...left, ...right];
}

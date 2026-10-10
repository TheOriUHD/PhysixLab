/**
 * A hollow cylinder — the maths shared by the ring (washer) and the tube (pipe).
 *
 * The collider is `segments` wedges, each the hull of the trapezoid between two radial planes extruded over the
 * height, so a ball really passes through the hole and a rod really sits inside. The two end faces of a wedge are
 * mirror images in its bisecting plane, which makes every side face planar and the wedge volume exact:
 * `h · ½ sin(2π/N) · (ro² − ri²)`. The mesh is the same N-gon prism, shaded smooth when it has enough sides.
 */
import type { BufferGeometry } from 'three';
import type { Vec3 } from '../../core/math';
import type { GeometryKit, RapierModule, ShapeCollider } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { creaseFor, lathe, MeshBuilder, type P2 } from './meshKit';
import { hullPart } from './parts';

const TAU = Math.PI * 2;

export interface Annulus {
  /** Outer radius. */
  ro: number;
  /** Inner (hole) radius. */
  ri: number;
  /** Height. */
  h: number;
  /** Wedges around. */
  n: number;
}

/** Segment count from the shape's `segments` parameter. */
export function segmentsOf(spec: ShapeSpec, def = 32, lo = 8, hi = 64): number {
  return Math.max(lo, Math.min(hi, Math.round(Number(spec.params?.segments ?? def))));
}

export function annulusVolume({ ro, ri, h, n }: Annulus): number {
  return n * h * 0.5 * Math.sin(TAU / n) * (ro * ro - ri * ri);
}

export function annulusColliders(R: RapierModule, { ro, ri, h, n }: Annulus): ShapeCollider[] {
  const parts: ShapeCollider[] = [];
  const at = (r: number, k: number, y: number): Vec3 => {
    const a = (k / n) * TAU;
    return [r * Math.cos(a), y, r * Math.sin(a)];
  };
  for (let k = 0; k < n; k++) {
    const pts: Vec3[] = [];
    for (const y of [-h / 2, h / 2]) pts.push(at(ri, k, y), at(ri, k + 1, y), at(ro, k, y), at(ro, k + 1, y));
    parts.push(hullPart(R, pts));
  }
  return parts;
}

/** Mesh of the unit annulus (outer diameter 1, height 1); the shape scales it by its size. */
export function annulusGeometry(T: GeometryKit, holeRatio: number, n: number): BufferGeometry {
  const ro = 0.5,
    ri = ro * holeRatio;
  const profile: P2[] = [
    [ri, -0.5],
    [ro, -0.5],
    [ro, 0.5],
    [ri, 0.5],
  ];
  const b = new MeshBuilder();
  b.crease = creaseFor(n);
  lathe(b, profile, n, true);
  return b.build(T);
}

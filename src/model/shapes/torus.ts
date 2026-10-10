/**
 * Torus (donut): a ring-shaped solid that other bodies can pass through the hole of.
 *
 * The collider is a compound of `segments` convex hulls, one per slice of the ring; each slice is the hull of the
 * `tubeSides`-gon cross-section at its two ends. The two end polygons are mirror images in the slice's bisecting
 * plane, so every side face is a planar trapezoid and the slice volume is exact: `sin(2π/N) · A · R` with A the
 * polygon area and R the radius of the tube's centre line. The mesh is built from the very same polygon, so what
 * you see is what collides (smooth-shaded when it has enough sides).
 *
 * Size: x = z = outer diameter, y = tube diameter (the height). The hole stays open: the tube diameter is held to
 * at most 40 % of the outer diameter, which leaves a hole of at least 20 % of it.
 */
import type { BufferGeometry } from 'three';
import type { Vec3 } from '../../core/math';
import type { GeometryKit, ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { axialDiameter, clampDims, MIN_DIM } from './helpers';
import { creaseFor, lathe, MeshBuilder, type P2 } from './meshKit';
import { hullPart } from './parts';
import { SHAPE_ICONS } from './shapeIcons';

/** Widest tube relative to the outer diameter: keeps a hole open. */
export const TORUS_MAX_TUBE = 0.4;

const TAU = Math.PI * 2;

interface TorusDims {
  /** Radius of the tube's centre line. */
  R: number;
  /** Radius of the tube. */
  r: number;
  /** Slices around the ring. */
  N: number;
  /** Sides of the tube's cross-section. */
  M: number;
}

const intParam = (spec: ShapeSpec, key: string, def: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(Number(spec.params?.[key] ?? def))));

export function torusDims(spec: ShapeSpec): TorusDims {
  const D = Math.max(spec.size[0], MIN_DIM);
  const t = Math.min(spec.size[1], TORUS_MAX_TUBE * D);
  return {
    R: (D - t) / 2,
    r: t / 2,
    N: intParam(spec, 'segments', 24, 8, 64),
    M: intParam(spec, 'tubeSides', 16, 6, 32),
  };
}

/** The tube's cross-section in the (radius from the axis, height) plane, counter-clockwise, first corner outermost. */
function crossSection({ R, r, M }: TorusDims): P2[] {
  const out: P2[] = [];
  for (let j = 0; j < M; j++) {
    const phi = (j / M) * TAU;
    out.push([R + r * Math.cos(phi), r * Math.sin(phi)]);
  }
  return out;
}

/** Exact volume of the polyhedral torus the colliders (and the mesh) form. */
export function torusVolume(spec: ShapeSpec): number {
  const d = torusDims(spec);
  const area = 0.5 * d.M * d.r * d.r * Math.sin(TAU / d.M);
  return d.N * Math.sin(TAU / d.N) * area * d.R;
}

function torusGeometry(T: GeometryKit, spec: ShapeSpec): BufferGeometry {
  // The mesh is built for a unit outer diameter and scaled uniformly by the real one (see `geometryKey`).
  const unit: ShapeSpec = { ...spec, size: [1, spec.size[1] / spec.size[0], 1] };
  const d = torusDims(unit);
  const b = new MeshBuilder();
  b.crease = creaseFor(d.N, d.M);
  lathe(b, crossSection(d), d.N, true);
  return b.build(T);
}

export const torus: ShapeDef = {
  id: 'torus',
  label: 'Torus',
  icon: SHAPE_ICONS.torus,
  category: 'solids',
  blurb: 'Donut ring with a real hole: things fall through it, hoops, tyres, life rings',
  defaultSize: [1, 0.3, 1],
  params: [
    {
      key: 'segments',
      label: 'Ring segments',
      kind: 'int',
      min: 8,
      max: 64,
      step: 1,
      default: 24,
      hint: 'Convex collider parts around the ring: more is rounder but costs more',
    },
    {
      key: 'tubeSides',
      label: 'Tube sides',
      kind: 'int',
      min: 6,
      max: 32,
      step: 1,
      default: 16,
      hint: 'Corners of the tube cross-section',
    },
  ],
  sizeFields: [
    { axis: 0, label: 'Outer diameter' },
    { axis: 1, label: 'Tube diameter' },
  ],
  axial: true,
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, Math.min(s[1], TORUS_MAX_TUBE * d), d];
  },
  volume: torusVolume,
  boundingRadius: (spec) => {
    const { R, r } = torusDims(spec);
    return R + r;
  },
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, spec) => {
    const d = torusDims(spec);
    const section = crossSection(d);
    const ring = (theta: number): Vec3[] =>
      section.map(([rho, y]): Vec3 => [rho * Math.cos(theta), y, rho * Math.sin(theta)]);
    const parts = [];
    for (let k = 0; k < d.N; k++) {
      parts.push(hullPart(R, [...ring((k / d.N) * TAU), ...ring(((k + 1) / d.N) * TAU)]));
    }
    return parts;
  },
  // One mesh per segment count and tube-to-ring ratio, shared by every size of that torus.
  geometryKey: (spec) => {
    const d = torusDims(spec);
    return `torus:${d.N}:${d.M}:${Math.round(((d.r * 2) / spec.size[0]) * 1000)}`;
  },
  visualScale: ({ size }) => [size[0], size[0], size[0]],
  geometry: torusGeometry,
};

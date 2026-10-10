/**
 * Convex solids that are the hull of a point set which stretches with the size box: the n-gonal pyramid, the
 * tetrahedron, octahedron, dodecahedron and the dice.
 *
 * A solid supplies *unit points* for its parameters (any size, any centre). The shape fits them into the size box —
 * centred on the bounding box and stretched to fill it — so `size` is the true bounding box, the mesh and the
 * collider are the same polyhedron under one affine map, the volume is the unit volume times the stretch, and the
 * mesh is shared by every body with those parameters whatever its size. At the default size the solid is regular.
 */
import type { Vec3 } from '../../core/math';
import type { ParamDef, ShapeCategory, ShapeDef } from '../shapeRegistry';
import type { ShapeParams, ShapeSpec } from '../types';
import { clampDims, hullCollider } from './helpers';
import { convexHull3, hullFaces, hullVolume, type Hull, type HullFace } from './hull3';
import { memo, paramsKey } from './memo';
import { flatFacesMesh } from './polyMesh';
import type { BufferGeometry } from 'three';
import type { GeometryKit } from '../shapeRegistry';

export interface Extent {
  centre: Vec3;
  /** Full extents of the bounding box. */
  dims: Vec3;
}

export function extentOf(pts: readonly Vec3[]): Extent {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p[a]);
      hi[a] = Math.max(hi[a], p[a]);
    }
  return {
    centre: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    dims: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
  };
}

/** The points centred on their bounding box and scaled to fill `size`. */
export function fitPoints(unit: readonly Vec3[], size: Vec3): Vec3[] {
  const { centre, dims } = extentOf(unit);
  const k: Vec3 = [
    dims[0] > 1e-12 ? size[0] / dims[0] : 1,
    dims[1] > 1e-12 ? size[1] / dims[1] : 1,
    dims[2] > 1e-12 ? size[2] / dims[2] : 1,
  ];
  return unit.map((p): Vec3 => [(p[0] - centre[0]) * k[0], (p[1] - centre[1]) * k[1], (p[2] - centre[2]) * k[2]]);
}

export interface ConvexSolidOptions {
  id: string;
  label: string;
  icon: string;
  category: ShapeCategory;
  blurb: string;
  keywords?: readonly string[];
  params?: readonly ParamDef[];
  /** Unit points for the given (complete) parameters. */
  unitPoints(params: ShapeParams): Vec3[];
  /** Default size; the bounding box of the unit points when omitted. */
  defaultSize?: Vec3;
  /** Keep the proportions (dice): the axis that changed most wins. */
  uniform?: boolean;
  /** Key of a painter for the surface (see `ShapeDef.surface`) and a function building the mesh from the unit hull. */
  mesh?(T: GeometryKit, hull: Hull, faces: HullFace[], params: ShapeParams): BufferGeometry;
  surface?: ShapeDef['surface'];
  quantities?: ShapeDef['quantities'];
}

interface Unit {
  pts: Vec3[];
  dims: Vec3;
  hull: Hull | null;
  volume: number;
}

export function convexSolid(o: ConvexSolidOptions): ShapeDef {
  const params = o.params ?? [];
  const paramsOf = (spec: ShapeSpec): ShapeParams => {
    const out: ShapeParams = {};
    for (const p of params) out[p.key] = spec.params?.[p.key] ?? p.default;
    return out;
  };
  const unitOf = (spec: ShapeSpec): Unit =>
    memo(`${o.id}|unit|${paramsKey(spec.params)}`, () => {
      const pts = o.unitPoints(paramsOf(spec));
      const hull = convexHull3(pts);
      return { pts, dims: extentOf(pts).dims, hull, volume: hull ? hullVolume(hull) : 0 };
    });
  const stretch = (spec: ShapeSpec): Vec3 => {
    const u = unitOf(spec);
    return [spec.size[0] / u.dims[0], spec.size[1] / u.dims[1], spec.size[2] / u.dims[2]];
  };
  const pointsOf = (spec: ShapeSpec): Vec3[] =>
    memo(`${o.id}|pts|${paramsKey(spec.params)}|${spec.size.join(',')}`, () => fitPoints(unitOf(spec).pts, spec.size));
  const defaultSize = o.defaultSize ?? roundDims(extentOf(o.unitPoints(defaultsOf(params))).dims);

  return {
    id: o.id,
    label: o.label,
    icon: o.icon,
    category: o.category,
    blurb: o.blurb,
    keywords: o.keywords,
    defaultSize,
    params,
    sizeFields: [
      { axis: 0, label: 'Width' },
      { axis: 1, label: 'Height' },
      { axis: 2, label: 'Depth' },
    ],
    normalizeSize: (size, _params, prev) => {
      const s = clampDims(size);
      if (!o.uniform) return s;
      const d = uniformAxis(s, prev);
      return [d, d, d];
    },
    volume: (spec) => {
      const k = stretch(spec);
      return unitOf(spec).volume * k[0] * k[1] * k[2];
    },
    boundingRadius: (spec) => Math.max(...pointsOf(spec).map((p) => Math.hypot(p[0], p[1], p[2]))),
    halfHeight: ({ size }) => size[1] / 2,
    convexPoints: pointsOf,
    colliders: (R, spec) => hullCollider(R, pointsOf(spec), spec.size),
    geometryKey: (spec) => `${o.id}:${paramsKey(spec.params)}`,
    visualScale: (spec) => stretch(spec),
    geometry: (T, spec) => {
      const u = unitOf(spec);
      const unit = fitPoints(u.pts, u.dims);
      const hull = convexHull3(unit);
      if (!hull) return new T.BoxGeometry(1, 1, 1);
      const faces = hullFaces(hull);
      return o.mesh ? o.mesh(T, hull, faces, paramsOf(spec)) : flatFacesMesh(hull, faces).build(T);
    },
    surface: o.surface,
    quantities: o.quantities,
  };
}

function defaultsOf(params: readonly ParamDef[]): ShapeParams {
  const out: ShapeParams = {};
  for (const p of params) out[p.key] = p.default;
  return out;
}

const roundDims = (d: Vec3): Vec3 => [
  Math.round(d[0] * 1e4) / 1e4,
  Math.round(d[1] * 1e4) / 1e4,
  Math.round(d[2] * 1e4) / 1e4,
];

function uniformAxis(s: Vec3, prev?: Vec3): number {
  if (!prev) return s[0];
  const dx = Math.abs(s[0] - prev[0]),
    dy = Math.abs(s[1] - prev[1]),
    dz = Math.abs(s[2] - prev[2]);
  return dx >= dy && dx >= dz ? s[0] : dy >= dz ? s[1] : s[2];
}

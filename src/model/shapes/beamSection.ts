/**
 * Structural beams — I, L and T sections — share this factory. A beam runs along X; its cross-section lies in the
 * (z, y) plane (z = width, y = height) and is extruded over the length.
 *
 * Size: x = length, y = section height, z = section width. The section's two thicknesses are fractions so a beam
 * scales as a whole: `flange` is the flange (or horizontal leg) thickness over the height, `web` the web (or
 * vertical leg) thickness over the width.
 *
 * The collider is one cuboid per rectangle of the section (a real section, not a bounding box) and the rectangles
 * tile the section exactly, so the mass is `density × length × section area`. The mesh is the section outline
 * extruded along the length; a unit test checks its enclosed volume against the same figure.
 */
import type { ParamDef, ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { clampDims } from './helpers';
import { extrudeOutline, MeshBuilder, type P2 } from './meshKit';
import { boxPart } from './parts';

/** A rectangle of the section in (z, y): centre and half extents. */
export interface Rect {
  cz: number;
  cy: number;
  hz: number;
  hy: number;
}

export interface BeamKind {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  defaultSize: [number, number, number];
  flange: { default: number; max: number };
  web: { default: number; max: number };
  flangeLabel: string;
  webLabel: string;
  /** The section split into non-overlapping rectangles, for a section of width `W`, height `H`. */
  rects(W: number, H: number, tf: number, tw: number): Rect[];
  /** The section outline, counter-clockwise in (z, y). */
  outline(W: number, H: number, tf: number, tw: number): P2[];
}

const ratio = (spec: ShapeSpec, key: string, def: number, max: number): number =>
  Math.max(0.04, Math.min(max, Number(spec.params?.[key] ?? def)));

export function makeBeam(kind: BeamKind): ShapeDef {
  const fOf = (spec: ShapeSpec) => ratio(spec, 'flange', kind.flange.default, kind.flange.max);
  const wOf = (spec: ShapeSpec) => ratio(spec, 'web', kind.web.default, kind.web.max);
  const thicknesses = (spec: ShapeSpec): [number, number] => [fOf(spec) * spec.size[1], wOf(spec) * spec.size[2]];
  const params: ParamDef[] = [
    {
      key: 'flange',
      label: kind.flangeLabel,
      kind: 'float',
      min: 0.04,
      max: kind.flange.max,
      step: 0.01,
      default: kind.flange.default,
      hint: 'As a fraction of the section height',
    },
    {
      key: 'web',
      label: kind.webLabel,
      kind: 'float',
      min: 0.04,
      max: kind.web.max,
      step: 0.01,
      default: kind.web.default,
      hint: 'As a fraction of the section width',
    },
  ];
  return {
    id: kind.id,
    label: kind.label,
    icon: kind.icon,
    category: 'structural',
    blurb: kind.blurb,
    defaultSize: kind.defaultSize,
    params,
    sizeFields: [
      { axis: 0, label: 'Length' },
      { axis: 1, label: 'Height' },
      { axis: 2, label: 'Width' },
    ],
    normalizeSize: (size) => clampDims(size),
    volume: (spec) => {
      const [tf, tw] = thicknesses(spec);
      const [L, H, W] = spec.size;
      return L * kind.rects(W, H, tf, tw).reduce((a, r) => a + 4 * r.hz * r.hy, 0);
    },
    boundingRadius: ({ size }) => Math.hypot(size[0], size[1], size[2]) / 2,
    halfHeight: ({ size }) => size[1] / 2,
    colliders: (R, spec) => {
      const [tf, tw] = thicknesses(spec);
      const [L, H, W] = spec.size;
      return kind.rects(W, H, tf, tw).map((r) => boxPart(R, [0, r.cy, r.cz], [L / 2, r.hy, r.hz]));
    },
    // the section scales affinely with the size, so one unit mesh per thickness pair serves every beam
    geometry: (T, spec) => {
      const b = new MeshBuilder();
      b.crease = 5;
      const pts = kind.outline(1, 1, fOf(spec), wOf(spec));
      // section (z, y) extruded along x: u → z, v → y, w → x
      extrudeOutline(b, pts, -0.5, 0.5, (u, v, w) => [w, v, u]);
      return b.build(T);
    },
  };
}

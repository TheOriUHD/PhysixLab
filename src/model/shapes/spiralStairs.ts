/**
 * Spiral stairs: a central column with `turns × stepsPerTurn` wedge-shaped treads climbing around it.
 *
 * Size: x = z = outer diameter, y = total height. A tread is `tread × rise` thick (the rise follows from the
 * height: `height = (steps − 1) · rise + tread thickness`), so the top of the last tread is the top of the shape.
 * Turns whose stairs overlap in plan are separated by `stepsPerTurn · rise`, always more than a tread is thick.
 *
 * Colliders: the column (an exact cylinder) and one convex hull per tread. A tread's inner edge is a chord of the
 * column's circle pushed out until it is *tangent* to it, so a tread never overlaps the column (no mass counted
 * twice) and the volume is the plain sum of the parts; its outer edge is a polyline on the outer circle with at
 * most 15° per piece. The mesh draws the same treads and a smooth column, so what you see is what collides.
 */
import type { BufferGeometry } from 'three';
import type { GeometryKit, ShapeCollider, ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { axialDiameter, clampDims, MIN_DIM, single } from './helpers';
import { creaseFor, extrudeOutline, lathe, MeshBuilder, type P2 } from './meshKit';
import { hullPart, prismPoints } from './parts';
import { SHAPE_ICONS } from './shapeIcons';

const MAX_STEPS = 96;
/** The first tread starts at the front (+Z), so a default camera looks at the foot of the stair. */
const START_ANGLE = Math.PI / 2;

export interface Spiral {
  /** Outer radius. */
  R: number;
  /** Column radius. */
  rc: number;
  H: number;
  steps: number;
  perTurn: number;
  /** Angle one tread spans. */
  delta: number;
  rise: number;
  /** Tread thickness. */
  tt: number;
  /** +1 climbs clockwise seen from above, −1 counter-clockwise. */
  dir: 1 | -1;
  /** Radius of the corners of a tread's inner chord (the chord is tangent to the column). */
  rin: number;
  /** Pieces of the outer arc of one tread. */
  pieces: number;
}

export function spiralLayout(spec: ShapeSpec): Spiral {
  const P = spec.params ?? {};
  const R = Math.max(spec.size[0], MIN_DIM) / 2;
  const H = spec.size[1];
  const turns = Math.max(0.25, Math.min(3, Number(P.turns ?? 1)));
  const perTurn = Math.max(6, Math.min(32, Math.round(Number(P.stepsPerTurn ?? 12))));
  const core = Math.max(0.05, Math.min(0.5, Number(P.core ?? 0.2)));
  const f = Math.max(0.2, Math.min(1.5, Number(P.tread ?? 0.6)));
  const steps = Math.max(2, Math.min(MAX_STEPS, Math.round(turns * perTurn)));
  const delta = (Math.PI * 2) / perTurn;
  const rise = H / (steps - 1 + f);
  const rc = core * R;
  return {
    R,
    rc,
    H,
    steps,
    perTurn,
    delta,
    rise,
    tt: f * rise,
    dir: P.clockwise === true ? 1 : -1,
    rin: rc / Math.cos(delta / 2),
    pieces: Math.max(1, Math.ceil(delta / (Math.PI / 12))),
  };
}

/** Plan polygon (x, z) of tread `i`: the inner chord's corners and the outer arc between them. */
export function treadPolygon(s: Spiral, i: number): P2[] {
  const a = START_ANGLE + s.dir * i * s.delta;
  const at = (r: number, ang: number): P2 => [r * Math.cos(ang), r * Math.sin(ang)];
  const poly: P2[] = [at(s.rin, a)];
  for (let j = 0; j <= s.pieces; j++) poly.push(at(s.R, a + (s.dir * s.delta * j) / s.pieces));
  poly.push(at(s.rin, a + s.dir * s.delta));
  return poly;
}

/** Top height of tread `i` in the body frame. */
export const treadTop = (s: Spiral, i: number): number => -s.H / 2 + s.tt + i * s.rise;

/** Exact sum of the column and the treads. */
export function spiralVolume(spec: ShapeSpec): number {
  const s = spiralLayout(spec);
  const area = 0.5 * s.pieces * s.R * s.R * Math.sin(s.delta / s.pieces) - 0.5 * s.rin * s.rin * Math.sin(s.delta);
  return Math.PI * s.rc * s.rc * s.H + s.steps * s.tt * area;
}

function spiralGeometry(T: GeometryKit, spec: ShapeSpec): BufferGeometry {
  // unit mesh (outer diameter 1, height 1), scaled by the size
  const s = spiralLayout({ ...spec, size: [1, 1, 1] });
  const b = new MeshBuilder();
  const n = 32;
  b.crease = creaseFor(n);
  lathe(
    b,
    [
      [0, -0.5],
      [s.rc, -0.5],
      [s.rc, 0.5],
      [0, 0.5],
    ],
    n,
  );
  b.crease = 5;
  for (let i = 0; i < s.steps; i++) {
    const top = treadTop(s, i);
    // plan (x, z) extruded along y: the axis map swaps v and w
    extrudeOutline(b, treadPolygon(s, i), top - s.tt, top, (u, v, w) => [u, w, v]);
  }
  return b.build(T);
}

export const spiralStairs: ShapeDef = {
  id: 'spiral-stairs',
  label: 'Spiral stairs',
  icon: SHAPE_ICONS['spiral-stairs'],
  category: 'structural',
  blurb: 'Winding stair around a central column: climb it, roll things down it',
  defaultSize: [2, 2.4, 2],
  params: [
    {
      key: 'turns',
      label: 'Turns',
      kind: 'float',
      min: 0.25,
      max: 3,
      step: 0.25,
      default: 1,
      hint: 'Revolutions around the column (rounded to whole steps)',
    },
    {
      key: 'stepsPerTurn',
      label: 'Steps per turn',
      kind: 'int',
      min: 6,
      max: 32,
      step: 1,
      default: 12,
    },
    {
      key: 'core',
      label: 'Column',
      kind: 'float',
      min: 0.05,
      max: 0.5,
      step: 0.01,
      default: 0.2,
      hint: 'Column radius as a fraction of the outer radius',
    },
    {
      key: 'tread',
      label: 'Tread thickness',
      kind: 'float',
      min: 0.2,
      max: 1.5,
      step: 0.05,
      default: 0.6,
      hint: 'In multiples of the rise of one step',
    },
    { key: 'clockwise', label: 'Clockwise', kind: 'bool', default: false, hint: 'Direction of climb seen from above' },
  ],
  sizeFields: [
    { axis: 0, label: 'Outer diameter' },
    { axis: 1, label: 'Height' },
  ],
  axial: true,
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, s[1], d];
  },
  volume: spiralVolume,
  boundingRadius: ({ size }) => Math.hypot(size[0] / 2, size[1] / 2),
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, spec) => {
    const s = spiralLayout(spec);
    const parts: ShapeCollider[] = single(R.ColliderDesc.cylinder(s.H / 2, s.rc));
    for (let i = 0; i < s.steps; i++) {
      const top = treadTop(s, i);
      parts.push(hullPart(R, prismPoints(treadPolygon(s, i), top - s.tt, top)));
    }
    return parts;
  },
  geometry: spiralGeometry,
};

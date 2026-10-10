/**
 * Stairs: a solid flight of `steps` equal steps rising toward −Z (the low end faces +Z, toward the default camera).
 *
 * Size: x = width, y = total height (the rise), z = total depth (the run); each step is `height / steps` high and
 * `depth / steps` deep. The collider is one cuboid per step, each reaching from the bottom to its tread and
 * covering only its own run, so the parts tile the solid without overlap and a ball dropped on a tread really
 * comes to rest on it. The mesh is the stepped profile extruded across the width.
 */
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { clampDims } from './helpers';
import { extrudeOutline, MeshBuilder, type P2 } from './meshKit';
import { boxPart } from './parts';
import { SHAPE_ICONS } from './shapeIcons';

export const stepsOf = (spec: ShapeSpec): number =>
  Math.max(2, Math.min(48, Math.round(Number(spec.params?.steps ?? 6))));

/** Side profile in (u = −z, v = y): counter-clockwise, low end at u = −D/2. */
export function stairProfile(D: number, H: number, n: number): P2[] {
  const run = D / n,
    rise = H / n;
  const pts: P2[] = [
    [-D / 2, -H / 2],
    [D / 2, -H / 2],
  ];
  for (let i = n - 1; i >= 0; i--) {
    const top = -H / 2 + (i + 1) * rise;
    pts.push([-D / 2 + (i + 1) * run, top], [-D / 2 + i * run, top]);
  }
  return pts;
}

export const stairs: ShapeDef = {
  id: 'stairs',
  label: 'Stairs',
  icon: SHAPE_ICONS.stairs,
  category: 'structural',
  blurb: 'Solid flight of steps: climb them, roll things down, build a staircase',
  defaultSize: [1.2, 1.2, 1.8],
  params: [
    {
      key: 'steps',
      label: 'Steps',
      kind: 'int',
      min: 2,
      max: 48,
      step: 1,
      default: 6,
      hint: 'Rise per step = height ÷ steps, run per step = depth ÷ steps',
    },
  ],
  sizeFields: [
    { axis: 0, label: 'Width' },
    { axis: 1, label: 'Height (rise)' },
    { axis: 2, label: 'Depth (run)' },
  ],
  normalizeSize: (size) => clampDims(size),
  // Σ over steps of width · run · (i + 1) · rise
  volume: (spec) => {
    const n = stepsOf(spec);
    return (spec.size[0] * spec.size[1] * spec.size[2] * (n + 1)) / (2 * n);
  },
  boundingRadius: ({ size }) => Math.hypot(size[0], size[1], size[2]) / 2,
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, spec) => {
    const [W, H, D] = spec.size;
    const n = stepsOf(spec);
    const run = D / n,
      rise = H / n;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const h = (i + 1) * rise;
      parts.push(boxPart(R, [0, -H / 2 + h / 2, D / 2 - (i + 0.5) * run], [W / 2, h / 2, run / 2]));
    }
    return parts;
  },
  geometry: (T, spec) => {
    // unit mesh (1 × 1 × 1), scaled by the size; the profile runs along u = −z and is extruded across x
    const b = new MeshBuilder();
    b.crease = 5;
    extrudeOutline(b, stairProfile(1, 1, stepsOf(spec)), -0.5, 0.5, (u, v, w) => [w, v, -u]);
    return b.build(T);
  },
};

/**
 * Arch: a block with an arched opening cut through it — a gateway, a bridge, an aqueduct bay. The top is a flat,
 * walkable / stackable deck.
 *
 * Size: x = span (outer width), y = height, z = depth (the way through). The opening is bounded by a circular arc
 * whose crown sits one `thickness` below the top. If the opening is at least as tall as it is wide the arc is a
 * semicircle stood on short straight walls (a stilted arch); a lower opening gets a segmental (flatter) arc.
 *
 * The collider tiles the solid with convex parts: two full-height legs, and `segments` vertical slabs over the
 * opening whose undersides are the chords of the arc. The slabs and the polygon outline of the mesh are the same
 * points, so the mesh encloses exactly the volume the colliders sum to (a unit test checks both against the
 * engine's mass).
 */
import type { BufferGeometry } from 'three';
import type { Vec3 } from '../../core/math';
import type { GeometryKit, ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { clampDims } from './helpers';
import { extrudeOutline, MeshBuilder, type P2 } from './meshKit';
import { boxPart, hullPart } from './parts';
import { SHAPE_ICONS } from './shapeIcons';

/** Lowest crown rise of the opening relative to its half width. */
const MIN_RISE = 0.15;

const num = (spec: ShapeSpec, key: string, def: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Number(spec.params?.[key] ?? def)));

interface ArchLayout {
  W: number;
  H: number;
  D: number;
  /** Leg and crown thickness. */
  t: number;
  /** Half width of the opening. */
  a: number;
  /** Points of the arc, left spring to right spring, in (x, height above the base). */
  arc: P2[];
}

/** The arch's geometry for a width, height and depth (the body frame's y is shifted by −H/2 afterwards). */
export function archLayout(W: number, H: number, D: number, thicknessRatio: number, segments: number): ArchLayout {
  const t = thicknessRatio * W;
  const a = Math.max(1e-3, W / 2 - t);
  const s = Math.max(MIN_RISE * a, H - t); // rise of the opening: base to crown
  let rho: number, cy: number, thMax: number;
  if (s >= a) {
    rho = a;
    cy = s - a;
    thMax = Math.PI / 2;
  } else {
    rho = (a * a + s * s) / (2 * s);
    cy = s - rho;
    thMax = Math.asin(Math.min(1, a / rho));
  }
  const arc: P2[] = [];
  for (let k = 0; k <= segments; k++) {
    const th = -thMax + (2 * thMax * k) / segments;
    arc.push([rho * Math.sin(th), cy + rho * Math.cos(th)]);
  }
  // pin the springs exactly on the walls and the crown inside the top
  arc[0][0] = -a;
  arc[segments][0] = a;
  return { W, H, D, t, a, arc };
}

const layoutOf = (spec: ShapeSpec): ArchLayout =>
  archLayout(
    spec.size[0],
    spec.size[1],
    spec.size[2],
    num(spec, 'thickness', 0.22, 0.08, 0.4),
    Math.round(num(spec, 'segments', 12, 4, 32)),
  );

/** Exact volume of the union of legs and slabs. */
export function archVolume(spec: ShapeSpec): number {
  const { H, D, t, arc } = layoutOf(spec);
  let area = 2 * t * H; // the legs
  for (let k = 0; k + 1 < arc.length; k++) {
    const [x0, y0] = arc[k],
      [x1, y1] = arc[k + 1];
    area += 0.5 * (H - y0 + (H - y1)) * (x1 - x0);
  }
  return area * D;
}

/** The mesh's outline in (x, height) coordinates, counter-clockwise, with the opening cut from the base. */
function outline(l: ArchLayout): P2[] {
  const pts: P2[] = [[-l.W / 2, 0]];
  pts.push([-l.a, 0]);
  for (const p of l.arc) pts.push(p);
  pts.push([l.a, 0], [l.W / 2, 0], [l.W / 2, l.H], [-l.W / 2, l.H]);
  return pts;
}

export const arch: ShapeDef = {
  id: 'arch',
  label: 'Arch',
  icon: SHAPE_ICONS.arch,
  category: 'structural',
  blurb: 'Arched gateway or bridge bay with a flat deck: roll things through, stack on top',
  defaultSize: [2, 2, 0.8],
  params: [
    {
      key: 'thickness',
      label: 'Thickness',
      kind: 'float',
      min: 0.08,
      max: 0.4,
      step: 0.01,
      default: 0.22,
      hint: 'Leg and crown thickness as a fraction of the span',
    },
    {
      key: 'segments',
      label: 'Arc segments',
      kind: 'int',
      min: 4,
      max: 32,
      step: 1,
      default: 12,
      hint: 'Convex collider slabs over the opening: more follows the curve closer',
    },
  ],
  sizeFields: [
    { axis: 0, label: 'Span' },
    { axis: 1, label: 'Height' },
    { axis: 2, label: 'Depth' },
  ],
  normalizeSize: (size, params) => {
    const s = clampDims(size);
    const t = Number(params.thickness ?? 0.22) * s[0];
    const a = Math.max(1e-3, s[0] / 2 - t);
    return [s[0], Math.max(s[1], t + MIN_RISE * a), s[2]];
  },
  volume: archVolume,
  boundingRadius: ({ size }) => Math.hypot(size[0], size[1], size[2]) / 2,
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, spec) => {
    const l = layoutOf(spec);
    const { W, H, D, t, arc } = l;
    const hz = D / 2;
    const parts = [
      boxPart(R, [-(W - t) / 2, 0, 0], [t / 2, H / 2, hz]),
      boxPart(R, [(W - t) / 2, 0, 0], [t / 2, H / 2, hz]),
    ];
    const dy = -H / 2;
    for (let k = 0; k + 1 < arc.length; k++) {
      const [x0, y0] = arc[k],
        [x1, y1] = arc[k + 1];
      const pts: Vec3[] = [];
      for (const z of [-hz, hz]) pts.push([x0, y0 + dy, z], [x1, y1 + dy, z], [x1, H + dy, z], [x0, H + dy, z]);
      parts.push(hullPart(R, pts));
    }
    return parts;
  },
  // The opening's shape depends on the height-to-span ratio, so one mesh per ratio is shared by every size of it.
  geometryKey: (spec) =>
    `arch:${Math.round(num(spec, 'thickness', 0.22, 0.08, 0.4) * 1000)}:${Math.round(num(spec, 'segments', 12, 4, 32))}:${Math.round((spec.size[1] / spec.size[0]) * 1000)}`,
  visualScale: ({ size }) => [size[0], size[0], size[2]],
  geometry: (T: GeometryKit, spec): BufferGeometry => {
    const l = archLayout(
      1,
      spec.size[1] / spec.size[0],
      1,
      num(spec, 'thickness', 0.22, 0.08, 0.4),
      Math.round(num(spec, 'segments', 12, 4, 32)),
    );
    const b = new MeshBuilder();
    // smooth the arc's chords (a few degrees apart), keep the corners and the deck crisp
    const step = ((Math.PI * 2) / Math.max(1, l.arc.length - 1)) * (180 / Math.PI);
    b.crease = Math.max(12, Math.min(50, step * 1.6));
    // outline x: span, y: height above the base (shifted to the body frame), extruded along z
    const pts = outline(l).map(([x, y]): P2 => [x, y - l.H / 2]);
    extrudeOutline(b, pts, -0.5, 0.5);
    return b.build(T);
  },
};

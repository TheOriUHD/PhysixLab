/**
 * Wheel: a tyre with rounded shoulders on a rim with a hub and spokes (or a solid dished web), as a compound of
 * convex pieces that tile it without overlap.
 *
 * Size: x = z = outer diameter, y = width (the tyre's width, at most twice the diameter); the axle is Y, like a cylinder's, and the body is a
 * natural hinge axle. Everything is defined in unit coordinates (diameter 1, width 1), so the mesh is shared by every
 * size and the volume is the unit volume times `D² · W`.
 *
 * Pieces, all built on one angular grid of `Nt` cells so the surfaces they share coincide exactly:
 *  - the tyre: `Nt` slices of a ring whose cross-section is a rectangle with rounded outer shoulders;
 *  - the rim: `Nt` slices of a narrower ring just inside the tyre (the rim is recessed into the tyre, as on a car);
 *  - the hub: one prism of `Nt` sides on the axis;
 *  - the web: `Nt` cells between hub and rim — all of them for a solid dish (no spokes), `s` consecutive cells per
 *    spoke otherwise.
 * A slice of a ring is the hull of its cross-section at two neighbouring angles; the two end faces are mirror images in
 * the bisecting plane, so every side face is planar and the slice volume is exactly `sin(2π/Nt) · A · ρ̄` (`A` the area
 * of the cross-section, `ρ̄` the distance of its centroid from the axis) — the same argument as the torus. The tyre is
 * tinted dark, the rim, hub and spokes take the body colour.
 */
import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { axialDiameter, clampDims } from './helpers';
import { convexHull3, isEngineSafe } from './hull3';
import { memo } from './memo';
import { creaseFor, extrudeOutline, lathe, MeshBuilder, type P2 } from './meshKit';
import { hullPart } from './parts';
import { SHAPE_ICONS } from './shapeIcons';

const TAU = Math.PI * 2;
const R = 0.5;
/** Widest wheel relative to its diameter. */
export const WHEEL_MAX_WIDTH = 2;
const TYRE_TINT: Vec3 = [0.085, 0.085, 0.095];

const intParam = (spec: ShapeSpec, key: string, def: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(Number(spec.params?.[key] ?? def))));
const floatParam = (spec: ShapeSpec, key: string, def: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Number(spec.params?.[key] ?? def)));

interface WheelParams {
  tire: number;
  spokes: number;
  spokeWidth: number;
  hub: number;
  segments: number;
}

export function wheelParams(spec: ShapeSpec): WheelParams {
  return {
    tire: floatParam(spec, 'tire', 0.2, 0.08, 0.4),
    spokes: intParam(spec, 'spokes', 5, 0, 12),
    spokeWidth: floatParam(spec, 'spokeWidth', 0.3, 0.15, 0.7),
    hub: floatParam(spec, 'hub', 0.18, 0.08, 0.45),
    segments: intParam(spec, 'segments', 20, 12, 40),
  };
}

/** One ring (a cross-section in the (radius, y) plane, counter-clockwise, first corner outermost) with its tint. */
interface Ring {
  section: P2[];
  tint: boolean;
}

export interface WheelLayout {
  /** Cells around the axis. */
  Nt: number;
  rings: Ring[];
  hub: { radius: number; half: number };
  /** Web cells: [first cell, count] runs, each between the hub and the rim; `half` is the web's half thickness. */
  web: { runs: [number, number][]; half: number };
  rimInner: number;
  tyreInner: number;
  /** Facets across each tyre shoulder. */
  shoulder: number;
  /** Volume of the unit wheel (diameter 1, width 1). */
  volume: number;
}

function tyreSection(rho: number, steps: number): P2[] {
  if (steps === 0) {
    return [
      [R, -0.5],
      [R, 0.5],
      [rho, 0.5],
      [rho, -0.5],
    ];
  }
  const cy = 0.14,
    cr = 0.35 * (R - rho);
  const pts: P2[] = [];
  // outer face, bottom shoulder → top shoulder (counter-clockwise: up the outside)
  for (let j = 0; j <= steps; j++) {
    const t = (Math.PI / 2) * (j / steps);
    pts.push([R - cr + cr * Math.sin(t), -0.5 + cy - cy * Math.cos(t)]);
  }
  for (let j = 0; j <= steps; j++) {
    const t = (Math.PI / 2) * (j / steps);
    pts.push([R - cr + cr * Math.cos(t), 0.5 - cy + cy * Math.sin(t)]);
  }
  // inner face, top → bottom
  pts.push([rho, 0.5], [rho, -0.5]);
  return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9);
}

const rect = (r0: number, r1: number, h: number): P2[] => [
  [r1, -h],
  [r1, h],
  [r0, h],
  [r0, -h],
];

/** Area × centroid distance from the axis of a polygon (the first moment about the axis). */
function firstMoment(poly: readonly P2[]): number {
  let m = 0;
  for (let i = 0; i < poly.length; i++) {
    const [r0, y0] = poly[i],
      [r1, y1] = poly[(i + 1) % poly.length];
    m += ((r0 + r1) * (r0 * y1 - r1 * y0)) / 6;
  }
  return Math.abs(m);
}

/** `shoulder`: facets across each rounded shoulder of the tyre (0 = square corners). */
export function wheelLayout(p: WheelParams, shoulder = 3): WheelLayout {
  return memo(`wheel|${p.tire}|${p.spokes}|${p.spokeWidth}|${p.hub}|${p.segments}|${shoulder}`, () => {
    const cell = p.spokes > 0 ? Math.max(2, Math.ceil(p.segments / p.spokes)) : 1;
    const Nt = p.spokes > 0 ? p.spokes * cell : p.segments;
    const tyreInner = R * (1 - p.tire);
    const rimInner = tyreInner - Math.max(0.03, 0.14 * (R - tyreInner));
    const hubR = Math.min(p.hub * R, rimInner * 0.7);
    const rings: Ring[] = [
      { section: tyreSection(tyreInner, shoulder), tint: true },
      { section: rect(rimInner, tyreInner, 0.36), tint: false },
    ];
    const runs: [number, number][] = [];
    if (p.spokes > 0) {
      const s = Math.max(1, Math.min(cell - 1, Math.round(p.spokeWidth * cell)));
      for (let i = 0; i < p.spokes; i++) runs.push([i * cell + Math.floor((cell - s) / 2), s]);
    } else runs.push([0, Nt]);
    const half = p.spokes > 0 ? 0.2 : 0.1;
    const slice = Math.sin(TAU / Nt);
    let volume = 0;
    for (const ring of rings) volume += Nt * slice * firstMoment(ring.section);
    volume += 0.5 * Nt * hubR * hubR * slice * 0.84; // the hub prism
    for (const [, count] of runs) volume += count * 0.5 * slice * (rimInner * rimInner - hubR * hubR) * 2 * half;
    return { Nt, shoulder, rings, hub: { radius: hubR, half: 0.42 }, web: { runs, half }, rimInner, tyreInner, volume };
  });
}

/** Hull point sets of every piece at a real size (diameter `size[0]`, width `size[1]`). */
function piecePoints(L: WheelLayout, size: Vec3): Vec3[][] {
  const [D, W] = [size[0], size[1]];
  const at = (rho: number, y: number, k: number): Vec3 => {
    const a = (k / L.Nt) * TAU;
    return [rho * D * Math.cos(a), y * W, rho * D * Math.sin(a)];
  };
  const out: Vec3[][] = [];
  for (const ring of L.rings)
    for (let k = 0; k < L.Nt; k++)
      out.push([...ring.section.map(([r, y]) => at(r, y, k)), ...ring.section.map(([r, y]) => at(r, y, k + 1))]);
  // hub: the Nt-gon prism
  const hubPts: Vec3[] = [];
  for (let k = 0; k < L.Nt; k++) hubPts.push(at(L.hub.radius, -L.hub.half, k), at(L.hub.radius, L.hub.half, k));
  out.push(hubPts);
  for (const [first, count] of L.web.runs)
    for (let c = 0; c < count; c++) {
      const k = (first + c) % L.Nt;
      const h = L.web.half;
      out.push([
        at(L.hub.radius, -h, k),
        at(L.hub.radius, h, k),
        at(L.hub.radius, -h, k + 1),
        at(L.hub.radius, h, k + 1),
        at(L.rimInner, -h, k),
        at(L.rimInner, h, k),
        at(L.rimInner, -h, k + 1),
        at(L.rimInner, h, k + 1),
      ]);
    }
  return out;
}

/**
 * The layout the engine can integrate at this size: a thin or very wide tyre first loses the facets of its shoulders
 * (down to square corners), then cells (see `hull3.ts`).
 */
function solid(spec: ShapeSpec): WheelLayout {
  const p = wheelParams(spec);
  return memo(`wheel|solid|${p.tire}|${p.spokes}|${p.spokeWidth}|${p.hub}|${p.segments}|${spec.size.join(',')}`, () => {
    const counts = [p.segments, Math.round(p.segments * 0.8), Math.round(p.segments * 0.64)].filter(
      (n, i, all) => n >= 12 && all.indexOf(n) === i,
    );
    let last = wheelLayout(p, 0);
    for (const shoulder of [3, 2, 1, 0])
      for (const segments of counts) {
        const layout = wheelLayout({ ...p, segments }, shoulder);
        last = layout;
        const pieces = piecePoints(layout, spec.size);
        // one of each kind: a tyre slice, a rim slice, the hub, a web cell
        const sample = [pieces[0], pieces[layout.Nt], pieces[2 * layout.Nt], pieces[2 * layout.Nt + 1]];
        if (sample.every((pts) => !pts || ((h) => !h || isEngineSafe(h))(convexHull3(pts)))) return layout;
      }
    return last;
  });
}

export const wheel: ShapeDef = {
  id: 'wheel',
  label: 'Wheel',
  icon: SHAPE_ICONS.wheel,
  category: 'mechanical',
  blurb: 'Tyre on a rim with a hub and spokes: a dark rounded tyre, a recessed rim, spokes or a solid dish',
  keywords: ['tire', 'tyre', 'rim', 'car', 'vehicle', 'spoke', 'hub', 'roll', 'rubber'],
  defaultSize: [1, 0.3, 1],
  params: [
    {
      key: 'tire',
      label: 'Tyre height',
      kind: 'float',
      min: 0.08,
      max: 0.4,
      step: 0.01,
      default: 0.2,
      hint: 'Sidewall height as a fraction of the wheel radius',
    },
    {
      key: 'spokes',
      label: 'Spokes',
      kind: 'int',
      min: 0,
      max: 12,
      step: 1,
      default: 5,
      hint: 'Number of spokes; 0 makes the rim a solid dished disc',
    },
    {
      key: 'spokeWidth',
      label: 'Spoke width',
      kind: 'float',
      min: 0.15,
      max: 0.7,
      step: 0.01,
      default: 0.3,
      hint: 'Width of a spoke as a fraction of the angle between spokes (rounded to whole cells)',
    },
    {
      key: 'hub',
      label: 'Hub',
      kind: 'float',
      min: 0.08,
      max: 0.45,
      step: 0.01,
      default: 0.18,
      hint: 'Hub radius as a fraction of the wheel radius',
    },
    {
      key: 'segments',
      label: 'Segments',
      kind: 'int',
      min: 12,
      max: 40,
      step: 1,
      default: 20,
      hint: 'Cells around the wheel (at least this many, a whole number per spoke): rounder when higher, dearer to simulate',
    },
  ],
  sizeFields: [
    { axis: 0, label: 'Diameter' },
    { axis: 1, label: 'Width' },
  ],
  axial: true,
  // a wheel wider than twice its diameter is a roller (use a cylinder): its tyre slices would be slivers the
  // engine cannot integrate (see hull3.ts)
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, Math.min(s[1], WHEEL_MAX_WIDTH * d), d];
  },
  volume: (spec) => solid(spec).volume * spec.size[0] * spec.size[0] * spec.size[1],
  boundingRadius: ({ size }) => Math.hypot(size[0] / 2, size[1] / 2),
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (Rp, spec) => piecePoints(solid(spec), spec.size).map((pts) => hullPart(Rp, pts)),
  geometryKey: (spec) => {
    const p = wheelParams(spec);
    const L = solid(spec);
    return `wheel:${p.tire}:${p.spokes}:${p.spokeWidth}:${p.hub}:${L.Nt}:${L.shoulder}`;
  },
  geometry: (T, spec) => {
    const L = solid(spec);
    const b = new MeshBuilder();
    b.crease = creaseFor(L.Nt) > 5 ? 38 : 5;
    for (const ring of L.rings) {
      b.tint = ring.tint ? TYRE_TINT : null;
      lathe(b, ring.section, L.Nt, true);
    }
    b.tint = null;
    lathe(
      b,
      [
        [0, -L.hub.half],
        [L.hub.radius, -L.hub.half],
        [L.hub.radius, L.hub.half],
        [0, L.hub.half],
      ],
      L.Nt,
    );
    for (const [first, count] of L.web.runs)
      for (let c = 0; c < count; c++) {
        const k = (first + c) % L.Nt;
        const a0 = (k / L.Nt) * TAU,
          a1 = ((k + 1) / L.Nt) * TAU;
        const poly: P2[] = [
          [L.hub.radius * Math.cos(a0), L.hub.radius * Math.sin(a0)],
          [L.hub.radius * Math.cos(a1), L.hub.radius * Math.sin(a1)],
          [L.rimInner * Math.cos(a1), L.rimInner * Math.sin(a1)],
          [L.rimInner * Math.cos(a0), L.rimInner * Math.sin(a0)],
        ];
        extrudeOutline(b, poly, -L.web.half, L.web.half, (u, v, w) => [u, w, v]);
      }
    return b.build(T);
  },
};

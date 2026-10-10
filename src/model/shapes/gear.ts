/**
 * Spur gear with a real involute tooth profile.
 *
 * Size: x = z = outer (tip) diameter `D`, y = face width (thickness); the axis is Y, like a cylinder's. The tooth
 * count `N` is a parameter; everything else follows from the standard proportions: module `m = D / (N + 2)`, pitch
 * radius `m·N / 2`, addendum `m`, dedendum `1.25 m`, and a pressure angle (20° by default) that fixes the involute
 * flanks. Two gears of the same module and tooth counts N₁, N₂ mesh when their axes are `m (N₁ + N₂) / 2` apart and
 * one is turned half a pitch against the other, and then turn with the ratio −N₁ / N₂ (`tests/gear.test.ts` drives
 * two of them through each other in the engine).
 *
 * The collider is `2N` convex pieces that tile the section without overlap: one *tooth column* per tooth (the
 * involute tooth together with the part of the body below it, from the bore up to the tip) and one *gap column*
 * between teeth (the part under the floor of the gap). Their volumes sum to the exact `density × volume`, and the mesh
 * is the very same pieces extruded, so what you see is what collides. The bore is a polygon of `2N` sides with the
 * requested radius at its corners; `bore = 0` leaves the gear solid.
 */
import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { axialDiameter, clampDims } from './helpers';
import { convexHull3, isEngineSafe } from './hull3';
import { memo, paramsKey } from './memo';
import { extrudeOutline, MeshBuilder, signedArea, type P2 } from './meshKit';
import { hullPart } from './parts';
import { SHAPE_ICONS } from './shapeIcons';

const TAU = Math.PI * 2;
const inv = (a: number): number => Math.tan(a) - a;

export const gearTeeth = (spec: ShapeSpec): number =>
  Math.max(6, Math.min(48, Math.round(Number(spec.params?.teeth ?? 16))));
const pressureOf = (spec: ShapeSpec): number => Math.max(14.5, Math.min(30, Number(spec.params?.pressure ?? 20)));
const boreOf = (spec: ShapeSpec): number => Math.max(0, Math.min(0.7, Number(spec.params?.bore ?? 0.3)));

export interface GearLayout {
  N: number;
  /** Points along each flank above the root. */
  flank: number;
  /** Module as a fraction of the outer diameter. */
  m: number;
  pitchRadius: number;
  rootRadius: number;
  tipRadius: number;
  boreRadius: number;
  /** Convex pieces (counter-clockwise polygons in the (x, z) plane, outer diameter 1): tooth, gap, tooth, gap … */
  pieces: P2[][];
  /** Area of the whole section (outer diameter 1). */
  area: number;
}

const polar = (r: number, a: number): P2 => [r * Math.cos(a), r * Math.sin(a)];

/** Convex hull of 2-D points, counter-clockwise (monotone chain). */
function hull2(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The section of a gear with outer diameter 1, as `2N` convex pieces; `flank` points per tooth flank. */
export function gearLayout(N: number, pressureDeg: number, boreFrac: number, flank: number): GearLayout {
  return memo(`gear|${N}|${pressureDeg}|${boreFrac}|${flank}`, () => {
    const m = 1 / (N + 2);
    const rp = (m * N) / 2;
    const ra = 0.5;
    const rd = rp - 1.25 * m;
    const alpha = (pressureDeg * Math.PI) / 180;
    const rb = rp * Math.cos(alpha);
    const backlash = (0.04 * m) / 2 / rp; // angular half-width taken off each tooth
    const pitch = TAU / N;
    const cap = 0.82 * (pitch / 2); // the tooth never fills more of the pitch than this at its foot
    /** Half-angle of the tooth at radius r. */
    const half = (r: number): number => {
      const rr = Math.max(r, rb);
      return Math.min(cap, Math.PI / (2 * N) + inv(alpha) - inv(Math.acos(Math.min(1, rb / rr))) - backlash);
    };
    // a pointed tooth (few teeth, steep pressure angle) is cut short so the tip keeps a little width
    const minHalf = 0.05 * (pitch / 2);
    let rt = ra;
    if (half(rt) < minHalf) {
      let lo = Math.max(rb, rd),
        hi = ra;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (half(mid) >= minHalf) lo = mid;
        else hi = mid;
      }
      rt = lo;
    }
    const r0 = Math.max(rb, rd);
    const rootPoints: [number, number][] = [[rd, half(r0)]]; // (radius, half-angle) up the right flank
    if (rd < rb) rootPoints.push([rb, half(rb)]); // below the base circle the flank is a radial line
    const flankPoints: [number, number][] = [...rootPoints];
    for (let j = 1; j <= flank; j++) {
      const r = r0 + ((rt - r0) * j) / flank;
      flankPoints.push([r, half(r)]);
    }
    const boreR = boreFrac * rd < 0.02 ? 0 : boreFrac * rd;
    const hb = flankPoints[0][1];
    const pieces: P2[][] = [];
    for (let k = 0; k < N; k++) {
      const phi = k * pitch;
      const inner = (a: number): P2 => (boreR > 0 ? polar(boreR, a) : [0, 0]);
      // tooth column
      const tooth: P2[] = [inner(phi - hb), inner(phi + hb)];
      for (const [r, th] of flankPoints) tooth.push(polar(r, phi + th), polar(r, phi - th));
      pieces.push(hull2(tooth));
      // gap column up to the next tooth
      const next = phi + pitch;
      pieces.push(
        hull2([
          inner(phi + hb),
          inner(next - hb),
          polar(rd, phi + hb),
          polar(rd, phi + pitch / 2),
          polar(rd, next - hb),
        ]),
      );
    }
    const area = pieces.reduce((s, p) => s + Math.abs(signedArea(p)), 0);
    return { N, flank, m, pitchRadius: rp, rootRadius: rd, tipRadius: rt, boreRadius: boreR, pieces, area };
  });
}

/** Hull points of every piece at a real size: outer diameter `size[0]`, thickness `size[1]`. */
function piecePoints(layout: GearLayout, size: Vec3): Vec3[][] {
  return layout.pieces.map((poly) => {
    const pts: Vec3[] = [];
    for (const [x, z] of poly) for (const s of [-0.5, 0.5]) pts.push([x * size[0], s * size[1], z * size[0]]);
    return pts;
  });
}

/** The flank resolution the engine can integrate for this spec (fewer flank points when a piece is too fine). */
function solid(spec: ShapeSpec): GearLayout {
  const N = gearTeeth(spec),
    a = pressureOf(spec),
    b = boreOf(spec);
  return memo(`gear|solid|${N}|${a}|${b}|${spec.size.join(',')}`, () => {
    let last = gearLayout(N, a, b, 1);
    for (let flank = 5; flank >= 1; flank--) {
      const layout = gearLayout(N, a, b, flank);
      last = layout;
      const [tooth, gap] = piecePoints(layout, spec.size).slice(0, 2);
      const ok = [tooth, gap].every((pts) => {
        const hull = convexHull3(pts);
        return !hull || isEngineSafe(hull);
      });
      if (ok) return layout;
    }
    return last;
  });
}

export const gear: ShapeDef = {
  id: 'gear',
  label: 'Gear',
  icon: SHAPE_ICONS.gear,
  category: 'mechanical',
  blurb: 'Involute spur gear: teeth, bore and tooth proportions are parameters; meshes with a gear of the same module',
  keywords: ['cog', 'sprocket', 'tooth', 'teeth', 'involute', 'pinion', 'cogwheel', 'transmission', 'module'],
  defaultSize: [1, 0.18, 1],
  params: [
    {
      key: 'teeth',
      label: 'Teeth',
      kind: 'int',
      min: 6,
      max: 48,
      step: 1,
      default: 16,
      hint: 'Number of teeth. Two gears mesh when they share a module and sit half the sum of their pitch diameters apart',
    },
    {
      key: 'pressure',
      label: 'Pressure angle',
      kind: 'float',
      min: 14.5,
      max: 30,
      step: 0.5,
      default: 20,
      unit: '°',
      hint: 'Angle of the involute flanks: 20° is standard, 14.5° gives slimmer teeth, 25–30° stronger ones',
    },
    {
      key: 'bore',
      label: 'Bore',
      kind: 'float',
      min: 0,
      max: 0.7,
      step: 0.01,
      default: 0.3,
      hint: 'Diameter of the axle hole as a fraction of the root diameter (0 = solid)',
    },
  ],
  sizeFields: [
    { axis: 0, label: 'Outer diameter' },
    { axis: 1, label: 'Thickness' },
  ],
  axial: true,
  quantities: [
    {
      key: 'module',
      label: 'Module',
      unit: 'm',
      min: 0.005,
      step: 0.005,
      digits: 4,
      hint: 'Tooth size: pitch diameter ÷ teeth. Editing it resizes the gear for the same number of teeth',
      get: (spec) => spec.size[0] / (gearTeeth(spec) + 2),
      set: (spec, value) => ({ size: [value * (gearTeeth(spec) + 2), spec.size[1], value * (gearTeeth(spec) + 2)] }),
    },
    {
      key: 'pitch',
      label: 'Pitch diameter',
      unit: 'm',
      min: 0.05,
      step: 0.01,
      digits: 3,
      hint: 'Diameter of the pitch circle, where meshing gears roll on each other',
      get: (spec) => (spec.size[0] * gearTeeth(spec)) / (gearTeeth(spec) + 2),
      set: (spec, value) => {
        const d = (value * (gearTeeth(spec) + 2)) / gearTeeth(spec);
        return { size: [d, spec.size[1], d] };
      },
    },
  ],
  normalizeSize: (size, _params, prev) => {
    const s = clampDims(size);
    const d = axialDiameter(s, prev);
    return [d, s[1], d];
  },
  volume: (spec) => solid(spec).area * spec.size[0] * spec.size[0] * spec.size[1],
  boundingRadius: ({ size }) => Math.hypot(size[0] / 2, size[1] / 2),
  halfHeight: ({ size }) => size[1] / 2,
  colliders: (R, spec) => piecePoints(solid(spec), spec.size).map((pts) => hullPart(R, pts)),
  // the section scales uniformly in the plane, so one mesh serves every size with the same teeth and flank detail
  geometryKey: (spec) => {
    return `gear:${paramsKey(spec.params)}:${solid(spec).flank}`;
  },
  geometry: (T, spec) => {
    const layout = solid(spec);
    const b = new MeshBuilder();
    b.crease = 40;
    for (const poly of layout.pieces) extrudeOutline(b, poly, -0.5, 0.5, (u, v, w) => [u, w, v]);
    return b.build(T);
  },
};

/**
 * The faces of the dice: which polygon of the polyhedron is which number, where its number sits on the texture atlas,
 * and how to read the result of a roll. Pure data and geometry — the canvas that paints the atlas lives in
 * `src/render/dicePainter.ts` and reads this layout, so the mesh uvs (here) and the painted atlas can never disagree.
 *
 * Conventions:
 *  - the dice are the regular solids (`platonic.ts`) resting on a face, plus the pentagonal trapezohedron (d10);
 *  - every face gets a cell of a `cols × rows` grid on the atlas, row 0 at the top; the face is mapped so that the
 *    number is upright and readable when the face is seen from outside with its "up" direction at the top —
 *    toward a vertex for triangles, pentagons and kites, toward an edge for the d6's squares;
 *  - opposite faces add up to `faces + 1` (a d10 shows 0–9, opposite faces add up to 9), as on real dice;
 *  - the d4 shows, as real d4s do, three numbers per face — the labels of its corners — and the result is the label of
 *    the corner pointing up.
 */
import { qrot, type Quat, type Vec3 } from '../../core/math';
import { convexHull3, hullFaces, type Hull, type HullFace } from './hull3';
import { extentOf, fitPoints } from './convexSolid';
import { memo } from './memo';
import { dodecahedronFaceUp, faceUp, icosahedronFaceUp, octahedronFaceUp, tetrahedronPoints } from './platonic';

export type DieKind = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20';
export const DIE_KINDS: readonly DieKind[] = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'];

export const DIE_FACES: Record<DieKind, number> = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };

/** Texels of one cell of the atlas. */
export const DIE_CELL_PX = 256;

/** The corner points of the die in its resting orientation (any size; the shape fits them into its box). */
export function dieUnitPoints(kind: DieKind): Vec3[] {
  switch (kind) {
    case 'd4':
      return tetrahedronPoints();
    case 'd6': {
      const out: Vec3[] = [];
      for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) out.push([x, y, z]);
      return out;
    }
    case 'd8':
      return octahedronFaceUp();
    case 'd10':
      return faceUp(trapezohedronPoints());
    case 'd12':
      return dodecahedronFaceUp();
    case 'd20':
      return icosahedronFaceUp();
  }
}

/** Pole height : ring radius of the d10, and the ring's zig-zag amplitude that makes every kite planar. */
const D10_POLE = 0.56;
/** z/h for planar kites: solves 2.1267 z = 0.2245 h (see the derivation in the test) → h/z = 9.4721. */
const D10_ZIG = 1 / 9.472135955;

function trapezohedronPoints(): Vec3[] {
  const h = D10_POLE,
    z = D10_ZIG * h,
    r = 0.5;
  const out: Vec3[] = [
    [0, h, 0],
    [0, -h, 0],
  ];
  for (let k = 0; k < 5; k++) {
    const up = (k * 2 * Math.PI) / 5;
    const down = up + Math.PI / 5;
    out.push([r * Math.cos(up), z, r * Math.sin(up)], [r * Math.cos(down), -z, r * Math.sin(down)]);
  }
  return out;
}

/** Positions of the pips of a d6 face, in the face's own coordinates (the square spans −½ … ½, +y is up). */
export function pipPositions(value: number): [number, number][] {
  const a = 0.25;
  switch (value) {
    case 1:
      return [[0, 0]];
    case 2:
      return [
        [-a, a],
        [a, -a],
      ];
    case 3:
      return [
        [-a, a],
        [0, 0],
        [a, -a],
      ];
    case 4:
      return [
        [-a, a],
        [a, a],
        [-a, -a],
        [a, -a],
      ];
    case 5:
      return [
        [-a, a],
        [a, a],
        [0, 0],
        [-a, -a],
        [a, -a],
      ];
    default:
      return [
        [-a, a],
        [-a, 0],
        [-a, -a],
        [a, a],
        [a, 0],
        [a, -a],
      ];
  }
}

export interface DieFace {
  /** The number on the face (for a d4: the label of the corner opposite, i.e. the result when it rests on this face). */
  value: number;
  /** Outward unit normal in the unit frame. */
  normal: Vec3;
  /** Face polygon, counter-clockwise from outside, unit frame. */
  verts: Vec3[];
  col: number;
  row: number;
  /** In-plane frame of the texture: face centre, "up" and "right" (right × up = normal) and texels per unit. */
  centre: Vec3;
  up: Vec3;
  right: Vec3;
  /** Distance in the plane that spans half a cell (so the face fits its cell). */
  halfSpan: number;
  /** d4 only: the label of each corner, with the corner's position in the face frame. */
  corners?: { label: number; x: number; y: number }[];
}

export interface DieLayout {
  kind: DieKind;
  cols: number;
  rows: number;
  /** The hull the faces belong to (unit frame, the bounding box centred on the origin). */
  hull: Hull;
  faces: DieFace[];
  /** d4: the four corners and their labels 1–4. */
  corners: { point: Vec3; label: number }[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The die's hull in its unit frame (bounding box centred, natural proportions). */
export function dieHull(kind: DieKind): Hull {
  return memo(`die|hull|${kind}`, () => {
    const pts = dieUnitPoints(kind);
    return convexHull3(fitPoints(pts, extentOf(pts).dims)) as Hull;
  });
}

function faceFrame(kind: DieKind, hull: Hull, f: HullFace) {
  const verts = f.verts.map((i) => hull.points[i]);
  const centre: Vec3 = [0, 0, 0];
  for (const v of verts) {
    centre[0] += v[0] / verts.length;
    centre[1] += v[1] / verts.length;
    centre[2] += v[2] / verts.length;
  }
  // "up" on the face: toward an edge for the d6, toward the vertex that is highest (the pole / the apex) otherwise
  let towards: Vec3;
  if (kind === 'd6') {
    const m: Vec3 = [(verts[0][0] + verts[1][0]) / 2, (verts[0][1] + verts[1][1]) / 2, (verts[0][2] + verts[1][2]) / 2];
    towards = sub(m, centre);
  } else {
    // the vertex farthest along world +y; faces lying flat (top / bottom) use the first vertex
    let best = verts[0];
    for (const v of verts) if (v[1] > best[1] + 1e-9) best = v;
    towards = sub(best, centre);
    if (Math.abs(f.normal[1]) > 0.999) towards = sub(verts[0], centre);
    // a bottom face seen from below: keep "up" pointing to the first vertex too
  }
  const projected = sub(towards, [
    f.normal[0] * dot(towards, f.normal),
    f.normal[1] * dot(towards, f.normal),
    f.normal[2] * dot(towards, f.normal),
  ]);
  const up = norm(projected);
  const right = norm(cross(up, f.normal));
  let span = 0;
  for (const v of verts) {
    const d = sub(v, centre);
    span = Math.max(span, Math.abs(dot(d, up)), Math.abs(dot(d, right)));
  }
  return { centre, up, right, span, verts };
}

/** Numbers for the faces: opposite faces add up to `n + 1` (0–9 for the d10). */
function assignValues(kind: DieKind, faces: { normal: Vec3 }[]): number[] {
  const n = faces.length;
  const order = faces
    .map((f, i) => ({ i, y: f.normal[1], a: Math.atan2(f.normal[2], f.normal[0]) }))
    .sort((p, q) => q.y - p.y || p.a - q.a || p.i - q.i);
  const values = new Array<number>(n).fill(0);
  const done = new Set<number>();
  let next = 1;
  for (const { i } of order) {
    if (done.has(i)) continue;
    // the face opposite i
    let opp = -1,
      bestDot = 2;
    faces.forEach((g, j) => {
      const d = dot(faces[i].normal, g.normal);
      if (j !== i && d < bestDot) {
        bestDot = d;
        opp = j;
      }
    });
    values[i] = next;
    values[opp] = n + 1 - next;
    done.add(i);
    done.add(opp);
    next++;
  }
  return kind === 'd10' ? values.map((v) => v - 1) : values;
}

/** The d6’s faces by normal: 1 up, 2 toward +z, 3 toward +x, and the opposites 6, 5, 4. */
function cubeValue(normal: Vec3): number {
  const [x, y, z] = normal;
  if (y > 0.5) return 1;
  if (y < -0.5) return 6;
  if (z > 0.5) return 2;
  if (z < -0.5) return 5;
  return x > 0 ? 3 : 4;
}

export function dieLayout(kind: DieKind): DieLayout {
  return memo(`die|layout|${kind}`, () => {
    const hull = dieHull(kind);
    const raw = hullFaces(hull);
    const n = raw.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const values =
      kind === 'd6' ? raw.map((f) => cubeValue(f.normal)) : kind === 'd4' ? raw.map(() => 0) : assignValues(kind, raw);
    // d4: label the four corners 1–4 (apex = 1, then the base corners counter-clockwise)
    const corners = kind === 'd4' ? labelCorners(hull) : [];
    const faces: DieFace[] = raw.map((f, k) => {
      const fr = faceFrame(kind, hull, f);
      const face: DieFace = {
        value: values[k],
        normal: f.normal,
        verts: fr.verts,
        col: k % cols,
        row: Math.floor(k / cols),
        centre: fr.centre,
        up: fr.up,
        right: fr.right,
        halfSpan: kind === 'd6' ? 0.5 : fr.span,
      };
      if (kind === 'd4') {
        face.corners = fr.verts.map((v) => {
          const d = sub(v, fr.centre);
          const c = corners.find((q) => Math.hypot(q.point[0] - v[0], q.point[1] - v[1], q.point[2] - v[2]) < 1e-6);
          return { label: c ? c.label : 0, x: dot(d, fr.right), y: dot(d, fr.up) };
        });
        // the result when resting on this face is the label of the corner that is not on it
        const on = new Set(face.corners.map((c) => c.label));
        face.value = [1, 2, 3, 4].find((l) => !on.has(l)) ?? 0;
      }
      return face;
    });
    return { kind, cols, rows, hull, faces, corners };
  });
}

function labelCorners(hull: Hull): { point: Vec3; label: number }[] {
  // the apex (highest) is 1; the three others follow counter-clockwise seen from above
  const pts = [...hull.points].sort((a, b) => b[1] - a[1]);
  const apex = pts[0];
  const base = pts.slice(1).sort((a, b) => Math.atan2(-(a[2] - 0), a[0]) - Math.atan2(-(b[2] - 0), b[0]));
  return [apex, ...base].map((point, i) => ({ point, label: i + 1 }));
}

/** The uv of a point of a face on the atlas. */
export function dieUv(layout: DieLayout, face: DieFace, p: Vec3): [number, number] {
  const d = sub(p, face.centre);
  // clamp inside the cell so a bevelled corner never samples a neighbour’s cell
  const lim = 0.49;
  const x = Math.max(-lim, Math.min(lim, (dot(d, face.right) / face.halfSpan) * 0.46));
  const y = Math.max(-lim, Math.min(lim, (dot(d, face.up) / face.halfSpan) * 0.46));
  const u = (face.col + 0.5 + x) / layout.cols;
  const v = 1 - (face.row + 0.5 - y) / layout.rows;
  return [u, v];
}

/** The number showing on top after a roll, given the die's world rotation. */
export function dieValueUp(kind: DieKind, rotation: Quat): number {
  const layout = dieLayout(kind);
  if (kind === 'd4') {
    let best = layout.corners[0],
      bestY = -Infinity;
    for (const c of layout.corners) {
      const y = qrot(rotation, c.point)[1];
      if (y > bestY) {
        bestY = y;
        best = c;
      }
    }
    return best.label;
  }
  let best = layout.faces[0],
    bestY = -Infinity;
  for (const f of layout.faces) {
    const y = qrot(rotation, f.normal)[1];
    if (y > bestY) {
      bestY = y;
      best = f;
    }
  }
  return best.value;
}

/** How squarely the die rests on a face: the largest y of the world normals (1 = a face exactly up). */
export function dieFlatness(kind: DieKind, rotation: Quat): number {
  const layout = dieLayout(kind);
  let best = -1;
  for (const f of layout.faces) best = Math.max(best, qrot(rotation, f.normal)[1]);
  // for the d4 a face resting down has its opposite corner up: the lowest face normal is straight down
  if (kind === 'd4') {
    let low = 1;
    for (const f of layout.faces) low = Math.min(low, qrot(rotation, f.normal)[1]);
    return -low;
  }
  return best;
}

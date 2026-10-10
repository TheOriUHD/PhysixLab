/**
 * Dice: d4, d6 (pips), d8, d10, d12 and d20 (numbered faces). Each is a regular polyhedron resting on a face — the
 * Platonic solids and the pentagonal trapezohedron — so every face is equivalent by symmetry and a rolled die comes to
 * rest on any face with equal probability (`tests/dice.test.ts` rolls 400-odd dice of each kind in the engine and checks
 * both that they lie flat and that the faces turn up evenly).
 *
 * Size: one field, the size of the die; the proportions are fixed (a die is regular). The d6's `roundness` rounds its
 * corners like a game die; the others are sharp. The textured faces come from `ShapeDef.surface`: the mesh carries
 * uvs into an atlas with one cell per face (`diceLayout.ts`), and `src/render/dicePainter.ts` paints the pips and
 * numbers into that atlas, upright and readable, with a mark under the 6 and the 9.
 */
import type { Vec3 } from '../../core/math';
import type { ShapeDef } from '../shapeRegistry';
import type { ShapeSpec } from '../types';
import { convexSolid } from './convexSolid';
import { dieHull, dieLayout, dieUnitPoints, dieUv, type DieKind } from './diceLayout';
import { hullCollider } from './helpers';
import { PolyMesh, type UV } from './polyMesh';
import { DIE_MAX_ROUNDNESS, roundedDie } from './roundedDie';
import { SHAPE_ICONS } from './shapeIcons';

const ID_LABEL: Record<DieKind, string> = {
  d4: 'D4',
  d6: 'D6',
  d8: 'D8',
  d10: 'D10',
  d12: 'D12',
  d20: 'D20',
};

const BLURB: Record<DieKind, string> = {
  d4: 'Four-sided die: the number at the top corner is the roll',
  d6: 'Six-sided die with pips; opposite faces add up to 7',
  d8: 'Eight-sided die, numbered 1–8; opposite faces add up to 9',
  d10: 'Ten-sided die (pentagonal trapezohedron), numbered 0–9',
  d12: 'Twelve-sided die of pentagons, numbered 1–12',
  d20: 'Twenty-sided die, numbered 1–20; opposite faces add up to 21',
};

const SURFACE = (kind: DieKind): ShapeDef['surface'] => ({ painter: 'dice', variant: () => kind });
const KEYWORDS = ['dice', 'die', 'random', 'roll', 'game', 'number', 'luck', 'board game', 'rpg'];

/** Largest dimension of the default size, metres. */
const DEFAULT_SPAN: Record<DieKind, number> = { d4: 0.6, d6: 0.5, d8: 0.5, d10: 0.5, d12: 0.5, d20: 0.5 };

function numberedDie(kind: Exclude<DieKind, 'd6'>): ShapeDef {
  const dims = dieHull(kind).points.reduce(
    (acc, p) => [Math.max(acc[0], Math.abs(p[0])), Math.max(acc[1], Math.abs(p[1])), Math.max(acc[2], Math.abs(p[2]))],
    [0, 0, 0],
  );
  const span = Math.max(dims[0], dims[1], dims[2]) * 2;
  const k = DEFAULT_SPAN[kind] / span;
  const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return convexSolid({
    id: kind,
    label: ID_LABEL[kind],
    icon: SHAPE_ICONS[kind],
    category: 'special',
    blurb: BLURB[kind],
    keywords: [...KEYWORDS, kind, `${kind.slice(1)} sided`],
    unitPoints: () => dieUnitPoints(kind),
    defaultSize: [round4(dims[0] * 2 * k), round4(dims[1] * 2 * k), round4(dims[2] * 2 * k)],
    keepAspect: true,
    sizeFields: [{ axis: 0, label: 'Size' }],
    surface: SURFACE(kind),
    mesh: (T) => {
      const layout = dieLayout(kind);
      const m = new PolyMesh();
      for (const face of layout.faces) {
        const uvs = face.verts.map((v): UV => dieUv(layout, face, v));
        m.polygon(face.verts, undefined, uvs);
      }
      return m.build(T);
    },
  });
}

// ── the d6: rounded corners ─────────────────────────────────────────────────────────────────────────

const d6Roundness = (spec: ShapeSpec): number =>
  Math.max(0, Math.min(DIE_MAX_ROUNDNESS, Number(spec.params?.roundness ?? 0.12)));

/** The rounded unit cube (edge 1) the d6 is: its hull, the exact volume and the reach of its corners. */
const d6Solid = (spec: ShapeSpec) => roundedDie(d6Roundness(spec));

const scaleBy = (pts: Vec3[], s: number): Vec3[] => pts.map((p): Vec3 => [p[0] * s, p[1] * s, p[2] * s]);

export const d6: ShapeDef = {
  id: 'd6',
  label: 'D6',
  icon: SHAPE_ICONS.d6,
  category: 'special',
  blurb: BLURB.d6,
  keywords: [...KEYWORDS, 'd6', 'six sided', 'pips', 'cube'],
  defaultSize: [0.5, 0.5, 0.5],
  params: [
    {
      key: 'roundness',
      label: 'Corner roundness',
      kind: 'float',
      min: 0,
      max: DIE_MAX_ROUNDNESS,
      step: 0.01,
      default: 0.12,
      hint: 'Rounding of the edges and corners as a fraction of the die: casino dice are sharp, game dice are rounded',
    },
  ],
  sizeFields: [{ axis: 0, label: 'Size' }],
  normalizeSize: (size, _params, prev) => {
    const s = [Math.max(0.02, size[0]), Math.max(0.02, size[1]), Math.max(0.02, size[2])] as Vec3;
    let axis = 0;
    if (prev) {
      const d = s.map((v, i) => Math.abs(v - prev[i]));
      axis = d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
    }
    return [s[axis], s[axis], s[axis]];
  },
  volume: (spec) => d6Solid(spec).volume * spec.size[0] ** 3,
  boundingRadius: (spec) => d6Solid(spec).reach * spec.size[0],
  halfHeight: ({ size }) => size[1] / 2,
  convexPoints: (spec) => scaleBy(d6Solid(spec).hull.points, spec.size[0]),
  colliders: (R, spec) => hullCollider(R, scaleBy(d6Solid(spec).hull.points, spec.size[0]), spec.size),
  geometryKey: (spec) => `d6:${d6Roundness(spec)}`,
  visualScale: ({ size }) => [size[0], size[0], size[0]],
  surface: SURFACE('d6'),
  geometry: (T, spec) => {
    const { hull, radius } = d6Solid(spec);
    const layout = dieLayout('d6');
    const m = new PolyMesh();
    if (radius < 1e-6) {
      for (const face of layout.faces) {
        const uvs = face.verts.map((v): UV => dieUv(layout, face, v));
        m.polygon(face.verts, undefined, uvs);
      }
      return m.build(T);
    }
    const core = 0.5 - radius;
    const normal = (p: Vec3): Vec3 => {
      const n: Vec3 = [
        p[0] - Math.max(-core, Math.min(core, p[0])),
        p[1] - Math.max(-core, Math.min(core, p[1])),
        p[2] - Math.max(-core, Math.min(core, p[2])),
      ];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      return [n[0] / l, n[1] / l, n[2] / l];
    };
    for (const [i, j, k] of hull.tris) {
      const p = hull.points[i],
        q = hull.points[j],
        r = hull.points[k];
      // the whole triangle takes its uvs from the face of the cube it mostly lies on, so a corner never smears two cells
      const c: Vec3 = [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3];
      const ax = Math.abs(c[0]),
        ay = Math.abs(c[1]),
        az = Math.abs(c[2]);
      const dominant: Vec3 =
        ax >= ay && ax >= az ? [Math.sign(c[0]), 0, 0] : ay >= az ? [0, Math.sign(c[1]), 0] : [0, 0, Math.sign(c[2])];
      const face =
        layout.faces.find(
          (f) => f.normal[0] * dominant[0] + f.normal[1] * dominant[1] + f.normal[2] * dominant[2] > 0.99,
        ) ?? layout.faces[0];
      m.tri(
        p,
        q,
        r,
        [normal(p), normal(q), normal(r)],
        [dieUv(layout, face, p), dieUv(layout, face, q), dieUv(layout, face, r)],
      );
    }
    return m.build(T);
  },
};

export const d4 = numberedDie('d4');
export const d8 = numberedDie('d8');
export const d10 = numberedDie('d10');
export const d12 = numberedDie('d12');
export const d20 = numberedDie('d20');

/** The six dice, in palette order. */
export const DICE: readonly ShapeDef[] = [d4, d6, d8, d10, d12, d20];

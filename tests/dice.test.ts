/**
 * Package SH, chunk 2 — dice (SH-10): the face layout (numbers, atlas cells, uvs), the regularity of the solids, and
 * the real proof of fairness — hundreds of dice of each kind rolled in the engine come to rest on a face, and every
 * face turns up about equally often.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { type Quat, type Vec3 } from '../src/core/math';
import { createBody } from '../src/model/factory';
import { makeShapeSpec, normalizeShapeSize, shapeDef, shapeVolume } from '../src/model/shapeRegistry';
import {
  DIE_FACES,
  DIE_KINDS,
  dieFlatness,
  dieHull,
  dieLayout,
  dieUv,
  dieValueUp,
  pipPositions,
  type DieKind,
} from '../src/model/shapes/diceLayout';
import { DIE_MAX_ROUNDNESS, restingFaces, roundedDie } from '../src/model/shapes/roundedDie';
import { initRapier } from '../src/physics/world';
import { run, worldOf } from './helpers';
import { engineMass, meshVolume } from './shapeTestKit';

beforeAll(async () => {
  await initRapier();
});

const areaOf = (verts: Vec3[]): number => {
  let a = 0;
  for (let i = 1; i + 1 < verts.length; i++) {
    const u: Vec3 = [verts[i][0] - verts[0][0], verts[i][1] - verts[0][1], verts[i][2] - verts[0][2]];
    const v: Vec3 = [verts[i + 1][0] - verts[0][0], verts[i + 1][1] - verts[0][1], verts[i + 1][2] - verts[0][2]];
    a += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  }
  return a;
};

describe('the faces of the dice (SH-10)', () => {
  it.each(DIE_KINDS)('%s: the right number of faces, each number once, opposite faces add up to n + 1', (kind) => {
    const layout = dieLayout(kind);
    const n = DIE_FACES[kind];
    expect(layout.faces).toHaveLength(n);
    if (kind === 'd4') {
      // a d4 reads the corner pointing up: the value of a face is the label of the corner opposite
      expect(layout.faces.map((f) => f.value).sort()).toEqual([1, 2, 3, 4]);
      for (const f of layout.faces) {
        expect(f.corners).toHaveLength(3);
        expect(new Set(f.corners!.map((c) => c.label)).size).toBe(3);
        expect(f.corners!.map((c) => c.label)).not.toContain(f.value);
      }
      return;
    }
    const values = layout.faces.map((f) => f.value).sort((a, b) => a - b);
    const first = kind === 'd10' ? 0 : 1;
    expect(values).toEqual(Array.from({ length: n }, (_, i) => i + first));
    for (const f of layout.faces) {
      const opposite = layout.faces.find((g) => g.normal.every((c, i) => Math.abs(c + f.normal[i]) < 1e-9))!;
      expect(opposite, `${kind}: a face opposite ${f.value}`).toBeDefined();
      expect(f.value + opposite.value).toBe(kind === 'd10' ? 9 : n + 1);
    }
  });

  it.each(DIE_KINDS)(
    '%s: every face is equivalent — equal area, equal distance from the centre (it is regular)',
    (kind) => {
      const layout = dieLayout(kind);
      const areas = layout.faces.map((f) => areaOf(f.verts));
      for (const a of areas) expect(a / areas[0]).toBeCloseTo(1, 9);
      // distance of each face plane from the centroid of the corners (a d4 is not centred on its box)
      const pts = dieHull(kind).points;
      const c = pts.reduce<Vec3>(
        (a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length],
        [0, 0, 0],
      );
      const dist = layout.faces.map(
        (f) =>
          (f.verts[0][0] - c[0]) * f.normal[0] +
          (f.verts[0][1] - c[1]) * f.normal[1] +
          (f.verts[0][2] - c[2]) * f.normal[2],
      );
      for (const d of dist) expect(d / dist[0]).toBeCloseTo(1, 9);
      // all faces planar polygons of the right kind
      const sides = { d4: 3, d6: 4, d8: 3, d10: 4, d12: 5, d20: 3 }[kind];
      for (const f of layout.faces) expect(f.verts).toHaveLength(sides);
    },
  );

  it('the d10 is a pentagonal trapezohedron: 12 corners, ten planar congruent kites', () => {
    const hull = dieHull('d10');
    const layout = dieLayout('d10');
    expect(hull.points).toHaveLength(12); // 2 poles and a zig-zag ring of 10
    expect(layout.faces).toHaveLength(10);
    const sides = layout.faces.map((f) => {
      const v = f.verts;
      return v.map((p, i) => Math.hypot(...p.map((c, k) => c - v[(i + 1) % v.length][k])).toFixed(6));
    });
    for (const f of layout.faces) {
      // planar: every corner on the plane of the face
      const d0 = f.verts[0][0] * f.normal[0] + f.verts[0][1] * f.normal[1] + f.verts[0][2] * f.normal[2];
      for (const p of f.verts) expect(p[0] * f.normal[0] + p[1] * f.normal[1] + p[2] * f.normal[2]).toBeCloseTo(d0, 9);
    }
    // a kite has two long and two short sides, the same ones on every face
    for (const s of sides) expect(new Set(s).size).toBe(2);
    expect(new Set(sides.map((s) => [...s].sort().join('|'))).size).toBe(1);
  });

  it.each(DIE_KINDS)('%s: every face has its own cell and its uvs stay inside it', (kind) => {
    const layout = dieLayout(kind);
    const cells = new Set(layout.faces.map((f) => `${f.col},${f.row}`));
    expect(cells.size).toBe(layout.faces.length);
    for (const f of layout.faces) {
      expect(f.col).toBeLessThan(layout.cols);
      expect(f.row).toBeLessThan(layout.rows);
      for (const v of f.verts) {
        const [u, w] = dieUv(layout, f, v);
        // the cell of the face on the atlas (row 0 at the top, v up)
        const u0 = f.col / layout.cols,
          u1 = (f.col + 1) / layout.cols;
        const v1 = 1 - f.row / layout.rows,
          v0 = 1 - (f.row + 1) / layout.rows;
        expect(u).toBeGreaterThanOrEqual(u0);
        expect(u).toBeLessThanOrEqual(u1);
        expect(w).toBeGreaterThanOrEqual(v0);
        expect(w).toBeLessThanOrEqual(v1);
      }
      // the number is readable: the frame is right-handed (right × up = the outward normal)
      const c: Vec3 = [
        f.right[1] * f.up[2] - f.right[2] * f.up[1],
        f.right[2] * f.up[0] - f.right[0] * f.up[2],
        f.right[0] * f.up[1] - f.right[1] * f.up[0],
      ];
      for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(f.normal[i], 9);
    }
  });

  it('pips: one to six, symmetric, inside the face', () => {
    for (let v = 1; v <= 6; v++) {
      const pips = pipPositions(v);
      expect(pips).toHaveLength(v);
      for (const [x, y] of pips) {
        expect(Math.abs(x)).toBeLessThanOrEqual(0.25);
        expect(Math.abs(y)).toBeLessThanOrEqual(0.25);
      }
      // point symmetric about the centre
      for (const [x, y] of pips)
        expect(pips.some(([a, b]) => Math.abs(a + x) < 1e-9 && Math.abs(b + y) < 1e-9)).toBe(true);
    }
  });

  it('the d6 has the classic arrangement: 1 up, 2 front, 3 right, and opposite faces add to 7', () => {
    const faces = dieLayout('d6').faces;
    const at = (n: Vec3) => faces.find((f) => f.normal.every((c, i) => Math.abs(c - n[i]) < 1e-9))!.value;
    expect(at([0, 1, 0])).toBe(1);
    expect(at([0, 0, 1])).toBe(2);
    expect(at([1, 0, 0])).toBe(3);
    expect(at([-1, 0, 0])).toBe(4);
    expect(at([0, 0, -1])).toBe(5);
    expect(at([0, -1, 0])).toBe(6);
  });

  it('reading a roll: the face with the highest normal wins; a d4 reads the corner up', () => {
    const id: Quat = [0, 0, 0, 1];
    const flipX: Quat = [1, 0, 0, 0]; // 180° about x
    for (const kind of DIE_KINDS) {
      const up = dieValueUp(kind, id);
      const down = dieValueUp(kind, flipX);
      if (kind === 'd4') {
        expect(up).toBe(1); // the apex points up
        expect([2, 3, 4]).toContain(down);
      } else {
        expect(up + down).toBe(kind === 'd10' ? 9 : DIE_FACES[kind] + 1);
      }
      expect(dieFlatness(kind, id)).toBeCloseTo(1, 9);
    }
  });
});

describe('dice shapes (SH-10)', () => {
  it.each(DIE_KINDS)(
    '%s: sizes are one field and keep the proportions; mesh and engine agree on the volume',
    (kind) => {
      const def = shapeDef(kind);
      expect(def.sizeFields).toHaveLength(1);
      expect(def.surface?.painter).toBe('dice');
      expect(def.category).toBe('special');
      const a = def.defaultSize;
      const doubled = normalizeShapeSize(kind, [a[0] * 2, a[1], a[2]], undefined, a);
      expect(doubled[1] / doubled[0]).toBeCloseTo(a[1] / a[0], 6);
      expect(doubled[0]).toBeCloseTo(a[0] * 2, 6);
      const spec = makeShapeSpec(kind);
      const v = shapeVolume(spec);
      expect(meshVolume(kind), kind).toBeCloseTo(v, 6);
      expect(Math.abs(engineMass(kind) - v * 1000) / (v * 1000), kind).toBeLessThan(1e-3);
    },
  );

  it('the d6 rounds its corners: less volume, a rounder hull, still a cube of the right size', () => {
    const sharp = shapeVolume(makeShapeSpec('d6', undefined, { roundness: 0 }));
    const rounded = shapeVolume(makeShapeSpec('d6', undefined, { roundness: 0.2 }));
    expect(sharp).toBeCloseTo(0.5 ** 3, 12);
    expect(rounded).toBeLessThan(sharp);
    expect(rounded).toBeGreaterThan(0.85 * sharp);
    expect(meshVolume('d6', undefined, { roundness: 0.2 })).toBeCloseTo(rounded, 6);
    // asking for more than the limit is clamped
    const way = shapeVolume(makeShapeSpec('d6', undefined, { roundness: 0.9 }));
    expect(way).toBeCloseTo(shapeVolume(makeShapeSpec('d6', undefined, { roundness: DIE_MAX_ROUNDNESS })), 12);
  });

  it('the rounded d6 weighs what its volume says in the engine, at every roundness and size', () => {
    for (const roundness of [0, 0.005, 0.02, 0.035, 0.05, 0.08, 0.12, 0.18, 0.25]) {
      for (const size of [0.08, 0.5, 3] as const) {
        const params = { roundness };
        const v = shapeVolume(makeShapeSpec('d6', [size, size, size], params));
        const m = engineMass('d6', [size, size, size], params);
        expect(Math.abs(m - v * 1000) / (v * 1000), `roundness ${roundness} size ${size}`).toBeLessThan(2e-3);
      }
    }
  });

  it('the rounded d6 can only rest on its six faces: no edge or corner facet carries the centre of mass', () => {
    for (let i = 0; i <= 50; i++) {
      const roundness = (i / 50) * DIE_MAX_ROUNDNESS;
      const die = roundedDie(roundness);
      expect(restingFaces(die.hull), `roundness ${roundness}`).toHaveLength(6);
    }
  });

  it('every other die rests on exactly its faces too', () => {
    for (const kind of DIE_KINDS) {
      if (kind === 'd4') continue; // a d4’s result is the corner up; its four faces are what it can rest on
      const hull = dieHull(kind);
      const centre = hull.points.reduce<Vec3>(
        (a, p) => [
          a[0] + p[0] / hull.points.length,
          a[1] + p[1] / hull.points.length,
          a[2] + p[2] / hull.points.length,
        ],
        [0, 0, 0],
      );
      expect(restingFaces(hull, centre), kind).toHaveLength(DIE_FACES[kind]);
    }
    const hull = dieHull('d4');
    const centre = hull.points.reduce<Vec3>((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]);
    expect(restingFaces(hull, centre)).toHaveLength(4);
  });
});

// ── fairness, in the real engine ─────────────────────────────────────────────────────────────────────

/** Deterministic generator. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A uniformly distributed random rotation (Shoemake). */
function randomRotation(r: () => number): Quat {
  const u1 = r(),
    u2 = r() * 2 * Math.PI,
    u3 = r() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1),
    b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

/** Critical values of chi-square at p = 0.001, by degrees of freedom. */
const CHI2_CRIT: Record<number, number> = { 3: 16.27, 5: 20.52, 7: 24.32, 9: 27.88, 11: 31.26, 19: 43.82 };

async function rollMany(kind: DieKind, rolls: number, seed: number, params?: Record<string, number>) {
  const r = rng(seed);
  const counts = new Map<number, number>();
  let notFlat = 0;
  const batch = 36;
  for (let done = 0; done < rolls; done += batch) {
    const n = Math.min(batch, rolls - done);
    const dice = Array.from({ length: n }, (_, i) =>
      createBody({
        shape: { type: kind, params },
        position: [((i % 6) - 2.5) * 3.2, 0.9 + r() * 0.4, (Math.floor(i / 6) - 2.5) * 3.2],
        rotation: randomRotation(r),
        velocity: [r() - 0.5, 0, r() - 0.5],
        angularVelocity: [(r() - 0.5) * 14, (r() - 0.5) * 14, (r() - 0.5) * 14],
        material: { preset: 'custom', density: 1200, friction: 0.55, restitution: 0.3 },
        linearDamping: 0.05,
        angularDamping: 0.2,
      }),
    );
    const w = await worldOf(dice, { physicsHz: 120 });
    run(w, 6);
    for (const d of dice) {
      const pose = w.getPose(d.id)!;
      const speed = Math.hypot(...pose.linvel) + Math.hypot(...pose.angvel);
      const flat = dieFlatness(kind, pose.rotation);
      if (speed > 0.05 || flat < 0.9995) notFlat++;
      const v = dieValueUp(kind, pose.rotation);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    w.dispose();
  }
  return { counts, notFlat };
}

function chiSquare(counts: Map<number, number>, faces: number, rolls: number): number {
  const expected = rolls / faces;
  let chi = 0;
  const keys = [...counts.keys()];
  // every face counts, including the ones that never came up
  const values = keys.length === faces ? keys : Array.from({ length: faces }, (_, i) => i + (counts.has(0) ? 0 : 1));
  for (const k of values) chi += ((counts.get(k) ?? 0) - expected) ** 2 / expected;
  return chi;
}

describe('fair dice (SH-10): rolled in the engine they lie flat and every face turns up evenly', () => {
  const PLAN: [DieKind, number][] = [
    ['d4', 288],
    ['d6', 360],
    ['d8', 432],
    ['d10', 540],
    ['d12', 648],
    ['d20', 900],
  ];
  it.each(PLAN)('%s: %i rolls', async (kind, rolls) => {
    const { counts, notFlat } = await rollMany(kind, rolls, 1000 + kind.length * 17 + rolls);
    const faces = DIE_FACES[kind];
    // d4 reads corners 1–4, d10 reads 0–9
    expect([...counts.keys()].every((v) => (kind === 'd10' ? v >= 0 && v <= 9 : v >= 1 && v <= faces))).toBe(true);
    expect(counts.size, `${kind}: every number came up`).toBe(faces);
    expect(notFlat, `${kind}: dice not lying flat and still after 6 s`).toBeLessThanOrEqual(
      Math.ceil(rolls * 0.01) + 1,
    );
    const chi = chiSquare(counts, faces, rolls);
    process.stderr.write(
      `${kind}: ${rolls} rolls, chi² = ${chi.toFixed(1)} (limit ${CHI2_CRIT[faces - 1]}), not flat ${notFlat}\n`,
    );
    expect(chi).toBeLessThan(CHI2_CRIT[faces - 1]);
  });

  it('a sharp d6 (roundness 0) is just as fair', async () => {
    const { counts, notFlat } = await rollMany('d6', 360, 4242, { roundness: 0 });
    expect(notFlat).toBeLessThanOrEqual(4);
    expect(chiSquare(counts, 6, 360)).toBeLessThan(CHI2_CRIT[5]);
  });
});

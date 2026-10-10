/**
 * The mesh kit behind the package-SH shape geometries (src/model/shapes/meshKit.ts): ear-clip triangulation of
 * concave outlines, crease-angle normals, the lathe and the outline extrusion — each checked by integrating the
 * volume or the area of what it produced.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import {
  creaseFor,
  ensureCcw,
  extrudeOutline,
  lathe,
  MeshBuilder,
  signedArea,
  triangulate,
  type P2,
} from '../src/model/shapes/meshKit';
import { GEOMETRY_KIT } from '../src/render/geometryKit';

/** Signed enclosed volume of a built (non-indexed) geometry. */
function volumeOf(b: MeshBuilder): number {
  const g = b.build(GEOMETRY_KIT);
  const p = g.getAttribute('position');
  let v = 0;
  for (let i = 0; i + 2 < p.count; i += 3) {
    const a: Vec3 = [p.getX(i), p.getY(i), p.getZ(i)];
    const bb: Vec3 = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
    const c: Vec3 = [p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)];
    v +=
      (a[0] * (bb[1] * c[2] - bb[2] * c[1]) -
        a[1] * (bb[0] * c[2] - bb[2] * c[0]) +
        a[2] * (bb[0] * c[1] - bb[1] * c[0])) /
      6;
  }
  return v;
}

const triArea = (poly: P2[], t: [number, number, number]): number => {
  const [a, b, c] = t.map((i) => poly[i]);
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
};

describe('triangulate (ear clipping)', () => {
  const LSHAPE: P2[] = [
    [0, 0],
    [3, 0],
    [3, 1],
    [1, 1],
    [1, 3],
    [0, 3],
  ];
  const COMB: P2[] = [
    [0, 0],
    [7, 0],
    [7, 3],
    [6, 3],
    [6, 1],
    [5, 1],
    [5, 3],
    [4, 3],
    [4, 1],
    [3, 1],
    [3, 3],
    [2, 3],
    [2, 1],
    [1, 1],
    [1, 3],
    [0, 3],
  ];
  const STAR: P2[] = Array.from({ length: 10 }, (_, i): P2 => {
    const r = i % 2 ? 0.4 : 1;
    const a = (i / 10) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a)];
  });

  it.each([
    ['an L', LSHAPE],
    ['a comb', COMB],
    ['a star', STAR],
  ])('covers %s exactly, with positively oriented triangles', (_name, poly) => {
    const tris = triangulate(poly);
    expect(tris).toHaveLength(poly.length - 2);
    let sum = 0;
    for (const t of tris) {
      const a = triArea(poly, t);
      expect(a).toBeGreaterThan(0);
      sum += a;
    }
    expect(sum).toBeCloseTo(signedArea(poly), 12);
  });

  it('tolerates collinear points (the extra vertices of an arch outline)', () => {
    const poly: P2[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 1],
      [2, 1],
      [1, 1],
      [0, 1],
    ];
    let sum = 0;
    for (const t of triangulate(poly)) sum += triArea(poly, t);
    expect(sum).toBeCloseTo(3, 12);
  });

  it('ensureCcw turns a clockwise outline around and drops repeated points', () => {
    const cw: P2[] = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 1],
      [1, 0],
    ];
    const ccw = ensureCcw(cw);
    expect(ccw).toHaveLength(4);
    expect(signedArea(ccw)).toBeCloseTo(1, 12);
  });
});

describe('extrudeOutline', () => {
  const L: P2[] = [
    [0, 0],
    [3, 0],
    [3, 1],
    [1, 1],
    [1, 3],
    [0, 3],
  ];

  it('encloses area × depth with outward faces, for either winding', () => {
    for (const poly of [L, [...L].reverse()]) {
      const b = new MeshBuilder();
      extrudeOutline(b, poly, 0, 2);
      expect(volumeOf(b)).toBeCloseTo(5 * 2, 9);
    }
  });

  it('stays outward through a mirroring axis map (the stairs and beams use them)', () => {
    const b = new MeshBuilder();
    extrudeOutline(b, L, -1, 1, (u, v, w) => [w, v, u]); // swaps x and z: a reflection
    expect(volumeOf(b)).toBeCloseTo(5 * 2, 9);
    const c = new MeshBuilder();
    extrudeOutline(c, L, -1, 1, (u, v, w) => [w, v, -u]); // a rotation
    expect(volumeOf(c)).toBeCloseTo(5 * 2, 9);
  });
});

describe('lathe', () => {
  it('a cylinder profile encloses the polygon prism volume', () => {
    const n = 24,
      r = 1.5,
      h = 2;
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [0, -h / 2],
        [r, -h / 2],
        [r, h / 2],
        [0, h / 2],
      ],
      n,
    );
    expect(volumeOf(b)).toBeCloseTo(0.5 * n * r * r * Math.sin((Math.PI * 2) / n) * h, 5); // float32 vertices
  });

  it('a closed ring profile (a pipe wall) is a hollow solid', () => {
    const n = 16;
    const b = new MeshBuilder();
    lathe(
      b,
      [
        [1, 0],
        [2, 0],
        [2, 1],
        [1, 1],
      ],
      n,
      true,
    );
    expect(volumeOf(b)).toBeCloseTo(0.5 * n * Math.sin((Math.PI * 2) / n) * (4 - 1), 5);
  });
});

describe('crease-angle normals', () => {
  it('a cube keeps hard edges: each vertex normal is the face normal', () => {
    const b = new MeshBuilder();
    b.crease = 30;
    extrudeOutline(
      b,
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      0,
      1,
    );
    const g = b.build(GEOMETRY_KIT);
    const n = g.getAttribute('normal');
    for (let i = 0; i < n.count; i++) {
      const m = [n.getX(i), n.getY(i), n.getZ(i)].map(Math.abs);
      expect(Math.max(...m)).toBeCloseTo(1, 6); // along an axis
    }
  });

  it('a finely tessellated cylinder is smooth around, hard at the rim', () => {
    const b = new MeshBuilder();
    b.crease = creaseFor(32);
    lathe(
      b,
      [
        [0, -0.5],
        [1, -0.5],
        [1, 0.5],
        [0, 0.5],
      ],
      32,
    );
    const g = b.build(GEOMETRY_KIT);
    const p = g.getAttribute('position'),
      n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      const side = Math.abs(p.getY(i)) < 0.5 || Math.abs(n.getY(i)) < 0.5;
      const r = Math.hypot(p.getX(i), p.getZ(i));
      if (Math.abs(n.getY(i)) > 0.999) continue; // a cap
      if (r > 0.999 && side) {
        // side normal points along the radius (smooth), not along a facet
        const rad = [p.getX(i) / r, p.getZ(i) / r];
        expect(n.getX(i) * rad[0] + n.getZ(i) * rad[1]).toBeGreaterThan(0.999);
      }
    }
  });

  it('few sides stay faceted: creaseFor is tiny below 12 steps and grows with the tessellation', () => {
    expect(creaseFor(8)).toBeLessThan(10);
    expect(creaseFor(11, 64)).toBeLessThan(10);
    expect(creaseFor(12)).toBeGreaterThan(40);
    expect(creaseFor(48)).toBeLessThan(creaseFor(16));
    expect(creaseFor(100)).toBeGreaterThan(5);
  });

  it('degenerate triangles are dropped instead of producing NaN normals', () => {
    const b = new MeshBuilder();
    const a = b.vertex(0, 0, 0),
      c = b.vertex(1, 0, 0),
      d = b.vertex(2, 0, 0),
      e = b.vertex(0, 1, 0);
    b.tri(a, c, d); // collinear
    b.tri(a, c, e);
    const g = b.build(GEOMETRY_KIT);
    expect(g.getAttribute('position').count).toBe(3);
    for (let i = 0; i < 3; i++) expect(Number.isFinite(g.getAttribute('normal').getX(i))).toBe(true);
  });
});

/**
 * Package SH, chunk 2 — ellipsoid (SH-8) and the regular solids: pyramid, tetrahedron, octahedron, dodecahedron
 * (SH-9). Analytic volumes, the engine's integrated mass, bounding boxes, and how each body comes to rest.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, vlen, type Vec3 } from '../src/core/math';
import { createBody } from '../src/model/factory';
import {
  makeShapeSpec,
  normalizeShapeSize,
  shapeBoundingRadius,
  shapeColliders,
  shapeConvexPoints,
  shapeGeometry,
  shapeVisualScale,
  shapeVolume,
} from '../src/model/shapeRegistry';
import { ELLIPSOID_MIN_RATIO } from '../src/model/shapes/ellipsoid';
import { extentOf } from '../src/model/shapes/convexSolid';
import { initRapier } from '../src/physics/world';
import { GEOMETRY_KIT } from '../src/render/geometryKit';
import { run, worldOf } from './helpers';

beforeAll(async () => {
  await initRapier();
});

function engineMass(type: string, size?: Vec3, params?: Record<string, number>): number {
  const spec = makeShapeSpec(type, size, params);
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  for (const c of shapeColliders(RAPIER, spec)) {
    const d = c.desc.setDensity(1000).setTranslation(...c.localPos);
    d.setRotation({ x: c.localRot[0], y: c.localRot[1], z: c.localRot[2], w: c.localRot[3] });
    world.createCollider(d, rb);
  }
  const m = rb.mass();
  world.free();
  return m;
}

/** Signed volume enclosed by a non-indexed triangle mesh. */
function meshVolume(type: string, size?: Vec3, params?: Record<string, number>): number {
  const spec = makeShapeSpec(type, size, params);
  const geo = shapeGeometry(GEOMETRY_KIT, spec);
  const s = shapeVisualScale(spec);
  const p = geo.getAttribute('position');
  let v = 0;
  for (let i = 0; i + 2 < p.count; i += 3) {
    const a = [p.getX(i) * s[0], p.getY(i) * s[1], p.getZ(i) * s[2]];
    const b = [p.getX(i + 1) * s[0], p.getY(i + 1) * s[1], p.getZ(i + 1) * s[2]];
    const c = [p.getX(i + 2) * s[0], p.getY(i + 2) * s[1], p.getZ(i + 2) * s[2]];
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  geo.dispose();
  return v;
}

const plastic = { preset: 'plastic', restitution: 0, friction: 0.8 };

describe('ellipsoid (SH-8)', () => {
  it('fills exactly its size box and its mesh is the collider polyhedron', () => {
    for (const size of [
      [1.4, 0.9, 1],
      [3, 1, 2],
      [0.5, 0.5, 2],
      [1, 1, 1],
    ] as Vec3[]) {
      const spec = makeShapeSpec('ellipsoid', size);
      const pts = shapeConvexPoints(spec)!;
      const e = extentOf(pts);
      for (let a = 0; a < 3; a++) {
        expect(e.dims[a], `axis ${a} of ${size.join('×')}`).toBeCloseTo(size[a], 9);
        expect(e.centre[a]).toBeCloseTo(0, 9);
      }
      expect(meshVolume('ellipsoid', size)).toBeCloseTo(shapeVolume(spec), 6);
    }
  });

  it('every vertex lies on the true ellipsoid', () => {
    const size: Vec3 = [3, 1.2, 2];
    const pts = shapeConvexPoints(makeShapeSpec('ellipsoid', size))!;
    for (const p of pts) {
      const f = (p[0] / 1.5) ** 2 + (p[1] / 0.6) ** 2 + (p[2] / 1) ** 2;
      expect(f).toBeCloseTo(1, 9);
    }
  });

  it('the engine integrates density × volume for balls, eggs and the flattest allowed ellipsoid', () => {
    for (const detail of [4, 8, 12, 16]) {
      for (const size of [
        [1, 1, 1],
        [1.7, 0.7, 1.1],
        [3, 0.75, 3],
        [0.5, 2, 0.5],
        [2, 0.5, 2],
      ] as Vec3[]) {
        const want = shapeVolume(makeShapeSpec('ellipsoid', size, { detail })) * 1000;
        const got = engineMass('ellipsoid', size, { detail });
        expect(Math.abs(got - want) / want, `${size.join('×')} detail ${detail}: ${got} vs ${want}`).toBeLessThan(2e-3);
      }
    }
  });

  it('approaches the smooth volume as the detail grows', () => {
    const smooth = (size: Vec3) => (Math.PI / 6) * size[0] * size[1] * size[2];
    const ratio = (d: number, size: Vec3) =>
      shapeVolume(makeShapeSpec('ellipsoid', size, { detail: d })) / smooth(size);
    expect(ratio(8, [1, 1, 1])).toBeGreaterThan(0.96);
    expect(ratio(16, [1, 1, 1])).toBeGreaterThan(0.99);
    expect(ratio(8, [1.4, 0.9, 1])).toBeGreaterThan(0.95);
    expect(ratio(16, [1.4, 0.9, 1])).toBeGreaterThan(0.985);
    expect(ratio(4, [1, 1, 1])).toBeLessThan(ratio(8, [1, 1, 1]));
    for (const d of [4, 8, 12, 16]) expect(ratio(d, [1.4, 0.9, 1])).toBeLessThan(1); // inscribed, never bigger
  });

  it('no axis may be shorter than a quarter of the longest (the engine would mis-compute a thin lens)', () => {
    expect(ELLIPSOID_MIN_RATIO).toBe(0.25);
    expect(normalizeShapeSize('ellipsoid', [4, 0.1, 2])).toEqual([4, 1, 2]);
    expect(normalizeShapeSize('ellipsoid', [1, 1, 1])).toEqual([1, 1, 1]);
    expect(normalizeShapeSize('ellipsoid', [0, 0, 0])).toEqual([0.02, 0.02, 0.02]);
  });

  it('a prolate egg lies down, an oblate lens settles on its short axis (real physics)', async () => {
    const egg = createBody({
      shape: { type: 'ellipsoid', size: [1.8, 0.9, 0.9] },
      position: [0, 1, 0],
      rotation: qfromAxisAngle([0, 0, 1], 1.2),
      material: plastic,
      angularDamping: 0.6,
    });
    const lens = createBody({
      shape: { type: 'ellipsoid', size: [1.6, 0.5, 1.6] },
      position: [4, 1, 0],
      rotation: qfromAxisAngle([1, 0, 0], 0.9),
      material: plastic,
      angularDamping: 0.6,
    });
    const w = await worldOf([egg, lens]);
    run(w, 12);
    const axisY = (id: string, local: Vec3) => qrot(w.getPose(id)!.rotation, local)[1];
    // the long axis (local x) of the egg is horizontal; the short axis (local y) of the lens is vertical
    expect(Math.abs(axisY(egg.id, [1, 0, 0]))).toBeLessThan(0.15);
    expect(Math.abs(axisY(lens.id, [0, 1, 0]))).toBeGreaterThan(0.98);
    // and each rests on the ground at the height of its short semi-axis (a vertex sits at that height within a facet)
    expect(w.getPose(egg.id)!.position[1]).toBeGreaterThan(0.43);
    expect(w.getPose(egg.id)!.position[1]).toBeLessThan(0.47);
    expect(w.getPose(lens.id)!.position[1]).toBeGreaterThan(0.24);
    expect(w.getPose(lens.id)!.position[1]).toBeLessThan(0.26);
    w.dispose();
  });
});

describe('regular solids (SH-9)', () => {
  const IDS = ['pyramid', 'tetrahedron', 'octahedron', 'dodecahedron'];

  it.each(IDS)('%s: mesh volume = analytic volume = engine mass, bounding box = size', (id) => {
    for (const size of [undefined, [2, 1.2, 0.8] as Vec3, [0.5, 1.9, 1.4] as Vec3]) {
      const spec = makeShapeSpec(id, size);
      const v = shapeVolume(spec);
      expect(meshVolume(id, size), `${id} mesh`).toBeCloseTo(v, 6);
      const m = engineMass(id, size);
      expect(Math.abs(m - v * 1000) / (v * 1000), `${id} ${(size ?? []).join('×')} engine`).toBeLessThan(1e-3);
      const e = extentOf(shapeConvexPoints(spec)!);
      for (let a = 0; a < 3; a++) expect(e.dims[a]).toBeCloseTo(spec.size[a], 8);
      expect(shapeBoundingRadius(spec)).toBeGreaterThanOrEqual(Math.max(...shapeConvexPoints(spec)!.map(vlen)) - 1e-12);
    }
  });

  it('pyramid: volume is a third of base × height for every side count, a square base fills width × depth', () => {
    for (let n = 3; n <= 16; n++) {
      const spec = makeShapeSpec('pyramid', [1.6, 1.1, 1.3], { sides: n });
      const pts = shapeConvexPoints(spec)!;
      const base = pts.filter((p) => Math.abs(p[1] + 0.55) < 1e-9);
      expect(base).toHaveLength(n);
      // shoelace area of the base polygon (the points come back in hull order: sort by angle around the centroid)
      const cx = base.reduce((s, p) => s + p[0], 0) / n,
        cz = base.reduce((s, p) => s + p[2], 0) / n;
      base.sort((a, b) => Math.atan2(a[2] - cz, a[0] - cx) - Math.atan2(b[2] - cz, b[0] - cx));
      let area = 0;
      for (let i = 0; i < n; i++) {
        const p = base[i],
          q = base[(i + 1) % n];
        area += p[0] * q[2] - q[0] * p[2];
      }
      area = Math.abs(area) / 2;
      expect(shapeVolume(spec), `n=${n}`).toBeCloseTo((area * 1.1) / 3, 9);
    }
    const sq = shapeConvexPoints(makeShapeSpec('pyramid', [2, 1, 1]))!;
    // a four-sided pyramid has a rectangular base: 4 corners at (±1, −0.5, ±0.5) and the apex above the centre
    expect(sq.filter((p) => Math.abs(Math.abs(p[0]) - 1) < 1e-9 && Math.abs(Math.abs(p[2]) - 0.5) < 1e-9)).toHaveLength(
      4,
    );
    expect(shapeVolume(makeShapeSpec('pyramid', [2, 1, 1]))).toBeCloseTo((2 * 1 * 1) / 3, 12);
  });

  it('tetrahedron: default is the regular one of edge 1 (volume 1/(6√2)); six equal edges', () => {
    const spec = makeShapeSpec('tetrahedron');
    expect(shapeVolume(spec)).toBeCloseTo(1 / (6 * Math.SQRT2), 3);
    const pts = shapeConvexPoints(spec)!;
    expect(pts).toHaveLength(4);
    const edges: number[] = [];
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++) edges.push(vlen([0, 1, 2].map((k) => pts[i][k] - pts[j][k]) as Vec3));
    for (const e of edges) expect(e).toBeCloseTo(1, 3);
  });

  it('octahedron: volume W·H·D/6 and a regular default (twelve equal edges)', () => {
    const spec = makeShapeSpec('octahedron', [2, 1, 3]);
    expect(shapeVolume(spec)).toBeCloseTo((2 * 1 * 3) / 6, 12);
    const pts = shapeConvexPoints(makeShapeSpec('octahedron'))!;
    expect(pts).toHaveLength(6);
    const d = pts.flatMap((p, i) => pts.slice(i + 1).map((q) => vlen([p[0] - q[0], p[1] - q[1], p[2] - q[2]])));
    const edge = Math.min(...d);
    expect(d.filter((x) => Math.abs(x - edge) < 1e-3)).toHaveLength(12);
  });

  it('dodecahedron: volume (15 + 7√5)/4 · a³ for the edge a of the default; twenty vertices', () => {
    const spec = makeShapeSpec('dodecahedron');
    const pts = shapeConvexPoints(spec)!;
    expect(pts).toHaveLength(20);
    const d = pts.flatMap((p, i) => pts.slice(i + 1).map((q) => vlen([p[0] - q[0], p[1] - q[1], p[2] - q[2]])));
    const a = Math.min(...d);
    expect(shapeVolume(spec)).toBeCloseTo(((15 + 7 * Math.sqrt(5)) / 4) * a ** 3, 3);
    expect(d.filter((x) => Math.abs(x - a) < 1e-3)).toHaveLength(30); // 30 edges
  });

  it('resting: tetrahedron and dodecahedron lie flat on a face; the pyramid on its base; the octahedron topples onto a face', async () => {
    const mk = (type: string, x: number, y = 1.5) =>
      createBody({
        shape: { type },
        position: [x, y, 0],
        rotation: qfromAxisAngle([1, 0.4, 0.2], 0.7),
        material: plastic,
        angularDamping: 0.5,
      });
    const bodies = ['tetrahedron', 'dodecahedron', 'pyramid', 'octahedron'].map((t, i) => mk(t, i * 3));
    const w = await worldOf(bodies);
    run(w, 8);
    for (const b of bodies) {
      const pts = shapeConvexPoints(makeShapeSpec(b.shape.type))!;
      const pose = w.getPose(b.id)!;
      // the lowest world-space vertices all sit on the ground: a face (or the base) lies flat
      const ys = pts.map((p) => qrot(pose.rotation, p)[1] + pose.position[1]).sort((p, q) => p - q);
      expect(ys[0], `${b.shape.type} touches the ground`).toBeGreaterThan(-0.01);
      expect(ys[0], `${b.shape.type} touches the ground`).toBeLessThan(0.01);
      const flat = ys.filter((y) => y < 0.005).length;
      expect(flat, `${b.shape.type} rests on at least three vertices`).toBeGreaterThanOrEqual(3);
    }
    w.dispose();
  });
});

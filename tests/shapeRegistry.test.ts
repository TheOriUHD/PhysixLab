/**
 * The shape registry (src/model/shapeRegistry.ts, src/model/shapes/*.ts): every registered shape is checked
 * against the real engine and the real three.js geometry — analytic volume against the integrated collider
 * mass, bounding radius against the hull and the mesh — plus parameter schemas, sanitising, and registering a
 * brand-new compound shape at run time.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, vlen, type Quat, type Vec3 } from '../src/core/math';
import { newReport } from '../src/model/errors';
import { createBody } from '../src/model/factory';
import { sanitizeDocument } from '../src/model/serialize';
import {
  composeCollider,
  FALLBACK_SHAPE,
  getShape,
  hasShape,
  listShapes,
  makeShapeSpec,
  normalizeShapeSize,
  registerShape,
  resolveParams,
  sanitizeShapeSpec,
  shapeBoundingRadius,
  shapeColliders,
  shapeConvexPoints,
  shapeDef,
  shapeGeometry,
  shapeGeometryKey,
  shapeHalfHeight,
  shapeVisualScale,
  shapeVolume,
  validateShapeDef,
  type ShapeDef,
} from '../src/model/shapeRegistry';
import type { BodyEntity, ShapeSpec } from '../src/model/types';
import { initRapier, PhysicsWorld } from '../src/physics/world';
import { GEOMETRY_KIT } from '../src/render/geometryKit';
import { hasIcon } from '../src/ui/icons';

beforeAll(async () => {
  await initRapier();
});

/** The first eight shapes, in palette order (the 1–9 keys depend on it). */
const CORE = ['box', 'sphere', 'cylinder', 'capsule', 'cone', 'wedge', 'prism', 'icosahedron'];
/** Every shape registered when the module loads: the generic checks below cover each of them automatically. */
const BUILTIN = listShapes().map((d) => d.id);

/** The specs every shape is checked at: its default, a stretched box-ish size, and every prism side count. */
function variants(def: ShapeDef): ShapeSpec[] {
  const base = makeShapeSpec(def.id);
  const out: ShapeSpec[] = [base];
  out.push(makeShapeSpec(def.id, [2.3, 0.7, 1.4], base.params));
  out.push(makeShapeSpec(def.id, [0.3, 3.1, 0.9], base.params));
  for (const p of def.params) {
    if (p.kind === 'int' && p.min !== undefined && p.max !== undefined) {
      for (let v = p.min; v <= p.max; v += Math.max(1, Math.floor((p.max - p.min) / 6))) {
        out.push(makeShapeSpec(def.id, undefined, { ...base.params, [p.key]: v }));
        out.push(makeShapeSpec(def.id, [1.7, 0.4, 1.1], { ...base.params, [p.key]: v }));
      }
    }
  }
  return out;
}

/** Mass the engine integrates for the registry colliders at a uniform density. */
function engineMass(spec: ShapeSpec, density: number): number {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  for (const c of shapeColliders(RAPIER, spec)) {
    const d = c.desc.setDensity(density).setTranslation(...c.localPos);
    d.setRotation({ x: c.localRot[0], y: c.localRot[1], z: c.localRot[2], w: c.localRot[3] });
    world.createCollider(d, rb);
  }
  const m = rb.mass();
  world.free();
  return m;
}

describe('registry contents', () => {
  it('registers the built-in shapes in palette order, each with a valid definition', () => {
    expect(BUILTIN.slice(0, CORE.length)).toEqual(CORE);
    expect(new Set(BUILTIN).size).toBe(BUILTIN.length);
    expect(listShapes().map((d) => d.id)).toEqual(BUILTIN);
    for (const d of listShapes()) {
      expect(() => validateShapeDef(d), d.id).not.toThrow();
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.icon.length).toBeGreaterThan(0);
      // an icon is a key of src/ui/icons.ts or inline SVG
      expect(hasIcon(d.icon) || d.icon.startsWith('<'), `icon of ${d.id}`).toBe(true);
      expect(['basic', 'structural', 'mechanical', 'solids', 'special']).toContain(d.category);
      expect(getShape(d.id)).toBe(d);
    }
  });

  it('never fails on an unknown id: it behaves like a box', () => {
    expect(hasShape('torus-of-doom')).toBe(false);
    expect(shapeDef('torus-of-doom').id).toBe(FALLBACK_SHAPE);
    const spec: ShapeSpec = { type: 'torus-of-doom', size: [1, 2, 3] };
    expect(shapeVolume(spec)).toBe(6);
    expect(shapeBoundingRadius(spec)).toBeCloseTo(Math.hypot(1, 2, 3) / 2, 12);
    expect(shapeColliders(RAPIER, spec)).toHaveLength(1);
    expect(shapeGeometry(GEOMETRY_KIT, spec).getAttribute('position').count).toBeGreaterThan(0);
  });
});

describe.each(BUILTIN)('shape %s', (id) => {
  const def = shapeDef(id);

  it('has a positive analytic volume', () => {
    for (const spec of variants(def)) expect(shapeVolume(spec), JSON.stringify(spec)).toBeGreaterThan(0);
  });

  it('collider mass equals density × volume', () => {
    for (const spec of variants(def)) {
      const expected = shapeVolume(spec) * 1000;
      const got = engineMass(spec, 1000);
      expect(
        Math.abs(got - expected) / expected,
        `${JSON.stringify(spec)}: engine ${got} vs analytic ${expected}`,
      ).toBeLessThan(0.02);
    }
  });

  it('bounding radius encloses the convex points and halfHeight matches the vertical extent', () => {
    for (const spec of variants(def)) {
      const r = shapeBoundingRadius(spec);
      const pts = shapeConvexPoints(spec);
      if (def.convexPoints) expect(pts, 'convex shape reports points').not.toBeNull();
      for (const p of pts ?? []) expect(vlen(p), JSON.stringify(spec)).toBeLessThanOrEqual(r + 1e-9);
      expect(shapeHalfHeight(spec)).toBeCloseTo(spec.size[1] / 2, 12);
      for (const p of pts ?? []) expect(Math.abs(p[1])).toBeLessThanOrEqual(shapeHalfHeight(spec) + 1e-9);
    }
  });

  it('geometry stays inside the size box and the bounding sphere once scaled', () => {
    for (const spec of variants(def)) {
      const geo = shapeGeometry(GEOMETRY_KIT, spec);
      const scale = shapeVisualScale(spec);
      const pos = geo.getAttribute('position');
      expect(pos.count).toBeGreaterThan(0);
      const r = shapeBoundingRadius(spec);
      let maxY = 0;
      for (let i = 0; i < pos.count; i++) {
        const v: Vec3 = [pos.getX(i) * scale[0], pos.getY(i) * scale[1], pos.getZ(i) * scale[2]];
        for (let a = 0; a < 3; a++)
          expect(Math.abs(v[a]), `${JSON.stringify(spec)} axis ${a}`).toBeLessThanOrEqual(spec.size[a] / 2 + 1e-6);
        expect(vlen(v)).toBeLessThanOrEqual(r + 1e-6);
        maxY = Math.max(maxY, Math.abs(v[1]));
      }
      // the mesh really spans the shape (not degenerate or mis-scaled); a regular icosahedron's vertices
      // reach 85% of the half-height of its size box, the other shapes touch it
      expect(maxY).toBeGreaterThan((spec.size[1] / 2) * 0.84);
      geo.dispose();
    }
  });

  it('colliders have a finite pose and every part is a valid desc', () => {
    for (const spec of variants(def)) {
      const parts = shapeColliders(RAPIER, spec);
      expect(parts.length).toBeGreaterThan(0);
      for (const c of parts) {
        expect(c.desc).toBeDefined();
        expect([...c.localPos, ...c.localRot].every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('shares geometry between equal shapes of different size but separates different parameters', () => {
    const a = makeShapeSpec(id, [1, 1, 1]);
    const b = makeShapeSpec(id, [1, 1, 1]);
    expect(shapeGeometryKey(a)).toBe(shapeGeometryKey(b));
    for (const p of def.params) {
      if (p.kind !== 'int' || p.min === undefined || p.max === undefined) continue;
      const other = makeShapeSpec(id, undefined, { [p.key]: p.default === p.min ? p.max : p.min });
      expect(shapeGeometryKey(other)).not.toBe(shapeGeometryKey(makeShapeSpec(id)));
    }
  });
});

describe('size normalisation', () => {
  it('keeps round shapes round and whichever axis changed most wins', () => {
    expect(normalizeShapeSize('sphere', [2, 1, 1], undefined, [1, 1, 1])).toEqual([2, 2, 2]);
    expect(normalizeShapeSize('sphere', [1, 1, 3], undefined, [1, 1, 1])).toEqual([3, 3, 3]);
    expect(normalizeShapeSize('cylinder', [1, 3, 2], undefined, [1, 3, 1])).toEqual([2, 3, 2]);
    const cap = normalizeShapeSize('capsule', [1, 0.2, 1]);
    expect(cap[1]).toBeGreaterThanOrEqual(cap[0]);
  });

  it('clamps to the minimum extent and the global maximum', () => {
    expect(normalizeShapeSize('box', [0, -3, 0.001])).toEqual([0.02, 0.02, 0.02]);
    expect(normalizeShapeSize('box', [1e9, 1, 1])[0]).toBe(100_000);
  });
});

describe('parameters', () => {
  it('prism side count is a schema parameter, defaulted, coerced and clamped', () => {
    const def = shapeDef('prism');
    expect(def.params.map((p) => p.key)).toEqual(['sides']);
    expect(makeShapeSpec('prism').params).toEqual({ sides: 6 });
    expect(resolveParams(def, { sides: 99 })).toEqual({ sides: 32 });
    expect(resolveParams(def, { sides: 2.4 })).toEqual({ sides: 3 });
    expect(resolveParams(def, { sides: 'many', stray: 1 })).toEqual({ sides: 6 });
    expect(resolveParams(def, undefined)).toEqual({ sides: 6 });
    expect(makeShapeSpec('box').params).toBeUndefined();
    expect(createBody({ shape: { type: 'prism' } }).shape.params).toEqual({ sides: 6 });
    expect(createBody({ shape: { type: 'prism', params: { sides: 5 } } }).shape.params).toEqual({ sides: 5 });
  });

  it('change the geometry: more sides, more volume (inscribed N-gon prism)', () => {
    const v = (n: number) => shapeVolume(makeShapeSpec('prism', [1, 1, 1], { sides: n }));
    expect(v(3)).toBeLessThan(v(4));
    expect(v(4)).toBeLessThan(v(8));
    expect(v(32)).toBeCloseTo(Math.PI / 4, 1); // approaches the cylinder of the same diameter
    const pts = (n: number) => shapeConvexPoints(makeShapeSpec('prism', [1, 1, 1], { sides: n }))!.length;
    expect(pts(5)).toBe(10);
  });

  it('a malformed schema is rejected when registering', () => {
    const ok = shapeDef('box');
    const bad = (patch: Partial<ShapeDef>) => () => registerShape({ ...ok, id: 'bad-shape', ...patch });
    expect(bad({ id: 'Not Valid!' })).toThrow(/Invalid shape id/);
    expect(bad({ label: '' })).toThrow(/label/);
    expect(bad({ sizeFields: [] })).toThrow(/size field/);
    expect(bad({ defaultSize: [1, 0, 1] })).toThrow(/default size/);
    expect(bad({ params: [{ key: 'k', label: 'K', kind: 'enum', default: 'a' }] })).toThrow(/without options/);
    expect(bad({ params: [{ key: 'k', label: 'K', kind: 'int', default: 99, min: 1, max: 5 }] })).toThrow(/above max/);
    expect(bad({ params: [{ key: 'k', label: 'K', kind: 'bool', default: 1 }] })).toThrow(/boolean/);
    const dup = { key: 'k', label: 'K', kind: 'int' as const, default: 2, min: 1, max: 5 };
    expect(bad({ params: [dup, dup] })).toThrow(/twice/);
    expect(() => registerShape(ok)).toThrow(/already registered/);
    expect(hasShape('bad-shape')).toBe(false);
  });
});

describe('sanitising shapes from documents', () => {
  it('replaces an unknown shape with a box and says so, keeping its size', () => {
    const report = newReport();
    const doc = sanitizeDocument(
      {
        format: 'physixlab-scene',
        entities: [{ kind: 'body', id: 'a', name: 'Odd one', shape: { type: 'tesseract', size: [2, 3, 4] } }],
      },
      report,
    );
    const b = doc.entities[0] as BodyEntity;
    expect(b.shape).toEqual({ type: 'box', size: [2, 3, 4] });
    expect(report.warnings).toEqual(['Unknown shape "tesseract" on "Odd one" was replaced by a box.']);
    // without a report it is repaired silently
    expect(() => sanitizeShapeSpec({ type: 'tesseract' })).not.toThrow();
    // a hostile shape value is just a box
    for (const raw of [null, 7, 'sphere', [], { type: 5 }, { type: {} }])
      expect(sanitizeShapeSpec(raw).type).toBe('box');
  });

  it('coerces parameters and sizes per the registry', () => {
    const s = sanitizeShapeSpec({ type: 'prism', size: [1, -2, 'x'], params: { sides: 77 } });
    expect(s.params).toEqual({ sides: 32 });
    expect(s.size.every((v) => v >= 0.02 && Number.isFinite(v))).toBe(true);
    expect(sanitizeShapeSpec({ type: 'sphere', size: [3, 1, 1] }).size).toEqual([3, 3, 3]);
    expect(sanitizeShapeSpec({ type: 'box', params: { sides: 5 } }).params).toBeUndefined();
  });

  it('moves the v1 prism `sides` field into params (v1 → v2)', () => {
    const v1 = JSON.parse(readFileSync(new URL('./fixtures/scene-v1.json', import.meta.url), 'utf8')) as {
      entities: { shape?: { sides?: number }; name: string }[];
    };
    expect(v1.entities.find((e) => e.name === 'Pentagon')!.shape!.sides).toBe(5);
    const doc = sanitizeDocument(v1);
    const by = (n: string) => doc.entities.find((e) => e.name === n) as BodyEntity;
    expect(by('Pentagon').shape.params).toEqual({ sides: 5 });
    expect(by('Hexagon').shape.params).toEqual({ sides: 6 });
    expect(by('Crate').shape.params).toBeUndefined();
    expect('sides' in by('Pentagon').shape).toBe(false);
  });
});

describe('a compound shape registered at run time (adding a shape = one file + one line)', () => {
  /** Two spheres joined by a bar, along X: three colliders, one shape. */
  const dumbbell: ShapeDef = {
    id: 'test-dumbbell',
    label: 'Dumbbell',
    icon: 'sphere',
    category: 'mechanical',
    defaultSize: [2, 0.6, 0.6],
    params: [{ key: 'bar', label: 'Bar', kind: 'float', min: 0.05, max: 0.5, default: 0.1, unit: 'm' }],
    sizeFields: [{ axis: 0, label: 'Length' }],
    normalizeSize: ([x, y]) => [Math.max(0.6, x), Math.max(0.1, y), Math.max(0.1, y)],
    volume: ({ size: [x, y], params }) => {
      const r = y / 2;
      const bar = Number(params?.bar ?? 0.1);
      const barLen = x - 2 * r;
      return 2 * ((4 / 3) * Math.PI * r ** 3) + Math.PI * bar * bar * barLen;
    },
    boundingRadius: ({ size }) => size[0] / 2,
    halfHeight: ({ size }) => size[1] / 2,
    colliders: (R, { size: [x, y], params }) => {
      const r = y / 2;
      const bar = Number(params?.bar ?? 0.1);
      const q: Quat = qfromAxisAngle([0, 0, 1], Math.PI / 2); // cylinder axis Y -> X
      return [
        { desc: R.ColliderDesc.ball(r), localPos: [-(x / 2 - r), 0, 0], localRot: [0, 0, 0, 1] },
        { desc: R.ColliderDesc.ball(r), localPos: [x / 2 - r, 0, 0], localRot: [0, 0, 0, 1] },
        { desc: R.ColliderDesc.cylinder((x - 2 * r) / 2, bar), localPos: [0, 0, 0], localRot: q },
      ];
    },
    geometry: (T) => new T.SphereGeometry(0.5, 8, 6),
  };

  it('registers, shows up in the list and sanitises like any other shape', () => {
    registerShape(dumbbell);
    expect(listShapes().map((d) => d.id)).toEqual([...BUILTIN, 'test-dumbbell']);
    const spec = sanitizeShapeSpec({ type: 'test-dumbbell', size: [3, 0.8, 0.8], params: { bar: 9 } });
    expect(spec).toEqual({ type: 'test-dumbbell', size: [3, 0.8, 0.8], params: { bar: 0.5 } });
  });

  it('feeds the engine several colliders whose mass matches the analytic volume', () => {
    const spec = makeShapeSpec('test-dumbbell');
    expect(shapeColliders(RAPIER, spec)).toHaveLength(3);
    // The bar overlaps the spheres, so the engine (which sums the parts) exceeds the union volume slightly.
    const summed = engineMass(spec, 1000);
    expect(summed).toBeGreaterThan(shapeVolume(spec) * 1000 * 0.99);
    expect(summed).toBeLessThan(shapeVolume(spec) * 1000 * 1.2);
  });

  it('builds a compound rigid body in the world, balanced about its centre', async () => {
    const body = createBody({ shape: { type: 'test-dumbbell' }, position: [0, 5, 0] });
    const w = new PhysicsWorld({ ...(await import('../src/model/factory')).newDocument('t'), entities: [body] });
    const rec = w.addBody({ ...body, id: 'again', position: [0, 9, 0] }, false);
    expect(rec.cols).toHaveLength(3);
    const com = rec.rb.localCom();
    expect(Math.abs(com.x) + Math.abs(com.y) + Math.abs(com.z)).toBeLessThan(1e-4);
    w.dispose();
  });

  it('composeCollider moves a collider into its parent frame', () => {
    const c = { desc: RAPIER.ColliderDesc.ball(0.1), localPos: [1, 0, 0] as Vec3, localRot: [0, 0, 0, 1] as Quat };
    const q = qfromAxisAngle([0, 0, 1], Math.PI / 2);
    const out = composeCollider(c, [0, 2, 0], q);
    const expected = qrot(q, [1, 0, 0]);
    expect(out.localPos[0]).toBeCloseTo(expected[0], 9);
    expect(out.localPos[1]).toBeCloseTo(2 + expected[1], 9);
    expect(out.localRot).toEqual(q);
    expect(out.desc).toBe(c.desc);
  });
});

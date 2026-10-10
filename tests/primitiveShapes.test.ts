/**
 * Package SH, chunk 1 — primitive shapes I: torus, ring, tube, arch, stairs, spiral stairs, hemisphere, dome,
 * frustum and the I / L / T beams (src/model/shapes/*.ts, mesh kit in meshKit.ts).
 *
 * The generic checks in `shapeRegistry.test.ts` already loop over every registered shape (mass ≈ density ×
 * volume within 2 %, geometry inside the size box, …). This file is stricter and goes further:
 *
 *  - the mesh of every shape encloses *exactly* the analytic volume (this also proves the triangle winding and
 *    the normals point outward) and the colliders' integrated mass equals density × that volume to 0.1 %;
 *  - the compound shapes really are compounds of the advertised parts, and hollow shapes are hollow in the real
 *    engine: a ball falls through the torus, the ring and the pipe, flies through the arch, rests on a step of
 *    the stairs, a tread of the spiral and in the pocket of an I-beam;
 *  - parameters are coerced, saved and loaded, and the size rules (torus hole, hemisphere ratio, …) hold.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { BufferGeometry } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { qfromAxisAngle, qrot, vlen, type Quat, type Vec3 } from '../src/core/math';
import { newReport } from '../src/model/errors';
import { createBody, newDocument } from '../src/model/factory';
import { parseDocument, serializeDocument } from '../src/model/serialize';
import {
  listShapes,
  makeShapeSpec,
  normalizeShapeSize,
  resolveParams,
  shapeBoundingRadius,
  shapeColliders,
  shapeDef,
  shapeGeometry,
  shapeGeometryKey,
  shapeVisualScale,
  shapeVolume,
} from '../src/model/shapeRegistry';
import { archLayout } from '../src/model/shapes/arch';
import { spiralLayout, treadPolygon, treadTop } from '../src/model/shapes/spiralStairs';
import type { BodyEntity, ShapeSpec } from '../src/model/types';
import { initRapier } from '../src/physics/world';
import { GEOMETRY_KIT } from '../src/render/geometryKit';
import { docOf, run, worldOf } from './helpers';

beforeAll(async () => {
  await initRapier();
});

const NEW_SHAPES = [
  'torus',
  'ring',
  'tube',
  'arch',
  'stairs',
  'spiral-stairs',
  'hemisphere',
  'dome',
  'frustum',
  'i-beam',
  'l-beam',
  't-beam',
];

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────

/** Signed volume enclosed by a non-indexed triangle mesh (divergence theorem), after scaling by `scale`. */
function meshVolume(geo: BufferGeometry, scale: Vec3): number {
  const p = geo.getAttribute('position');
  let v = 0;
  for (let i = 0; i + 2 < p.count; i += 3) {
    const a = [p.getX(i) * scale[0], p.getY(i) * scale[1], p.getZ(i) * scale[2]];
    const b = [p.getX(i + 1) * scale[0], p.getY(i + 1) * scale[1], p.getZ(i + 1) * scale[2]];
    const c = [p.getX(i + 2) * scale[0], p.getY(i + 2) * scale[1], p.getZ(i + 2) * scale[2]];
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return v;
}

/** Mass of the registry colliders at a uniform density, straight from the engine. */
function engineMass(spec: ShapeSpec, density = 1000): number {
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

/** Specs every shape is exercised at: the default, two stretched sizes, and the extremes of each parameter. */
function variants(id: string): ShapeSpec[] {
  const def = shapeDef(id);
  const base = makeShapeSpec(id);
  const out: ShapeSpec[] = [
    base,
    makeShapeSpec(id, [2.6, 1.1, 1.7], base.params),
    makeShapeSpec(id, [0.4, 2.2, 0.9], base.params),
  ];
  for (const p of def.params) {
    const values: (number | boolean | string)[] = [];
    if (p.kind === 'int' || p.kind === 'float') values.push(p.min as number, p.max as number);
    if (p.kind === 'bool') values.push(true, false);
    for (const v of values) out.push(makeShapeSpec(id, undefined, { ...base.params, [p.key]: v }));
  }
  return out;
}

const free = { linearDamping: 0, angularDamping: 0 };
const ballMat = { preset: 'plastic', restitution: 0, friction: 0.8 };
const ball = (r: number, position: Vec3, extra: Partial<BodyEntity> = {}) =>
  createBody({ shape: { type: 'sphere', size: [2 * r, 2 * r, 2 * r] }, position, material: ballMat, ...extra });
const fixed = (
  type: string,
  size: Vec3 | undefined,
  position: Vec3,
  params?: Record<string, number | boolean>,
  rotation?: Quat,
) =>
  createBody({
    shape: { type, size, params },
    position,
    bodyType: 'static',
    rotation,
    material: { preset: 'concrete', restitution: 0 },
  });
const yOf = (w: Awaited<ReturnType<typeof worldOf>>, id: string) => w.getPose(id)!.position[1];

// ── the mesh encloses the analytic volume ────────────────────────────────────────────────────────────

describe('every new shape: analytic volume, mesh and engine mass agree', () => {
  it('registers exactly these twelve shapes after the original eight, in this order', () => {
    // later chunks append further shapes after these (the palette order is the registry order)
    expect(
      listShapes()
        .slice(0, 8 + NEW_SHAPES.length)
        .map((d) => d.id),
    ).toEqual(['box', 'sphere', 'cylinder', 'capsule', 'cone', 'wedge', 'prism', 'icosahedron', ...NEW_SHAPES]);
  });

  describe.each(NEW_SHAPES)('%s', (id) => {
    it('the mesh encloses the analytic volume (outward winding, right figure)', () => {
      const tol = id === 'spiral-stairs' ? 0.012 : 1e-3; // the spiral's column is a true cylinder, its mesh a 32-gon
      for (const spec of variants(id)) {
        const geo = shapeGeometry(GEOMETRY_KIT, spec);
        const got = meshVolume(geo, shapeVisualScale(spec));
        const want = shapeVolume(spec);
        expect(got, JSON.stringify(spec)).toBeGreaterThan(0);
        expect(Math.abs(got - want) / want, `${JSON.stringify(spec)}: mesh ${got} vs analytic ${want}`).toBeLessThan(
          tol,
        );
        geo.dispose();
      }
    });

    // The engine's hull builder merges near-coplanar vertices in the finest dome / hemisphere rings (32+ sides),
    // which moves their mass by up to 0.3 %; everything else is the exact polyhedron to float precision.
    const massTol = id === 'hemisphere' || id === 'dome' ? 5e-3 : 1e-3;
    it(`the engine integrates density × volume from the colliders to ${massTol * 100} %`, () => {
      for (const spec of variants(id)) {
        const want = shapeVolume(spec) * 1000;
        const got = engineMass(spec);
        expect(Math.abs(got - want) / want, `${JSON.stringify(spec)}: engine ${got} vs analytic ${want}`).toBeLessThan(
          massTol,
        );
      }
    });

    it('the geometry has unit-length, finite normals and uvs', () => {
      const geo = shapeGeometry(GEOMETRY_KIT, makeShapeSpec(id));
      const n = geo.getAttribute('normal'),
        uv = geo.getAttribute('uv'),
        pos = geo.getAttribute('position');
      expect(n.count).toBe(pos.count);
      expect(uv.count).toBe(pos.count);
      for (let i = 0; i < n.count; i++) {
        expect(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1)).toBeLessThan(1e-4);
        expect(Number.isFinite(uv.getX(i) + uv.getY(i))).toBe(true);
      }
    });

    it('stays within the bounding radius and the size box, and the bounding radius is tight', () => {
      for (const spec of variants(id)) {
        const geo = shapeGeometry(GEOMETRY_KIT, spec);
        const s = shapeVisualScale(spec);
        const pos = geo.getAttribute('position');
        let far = 0;
        for (let i = 0; i < pos.count; i++) {
          far = Math.max(far, vlen([pos.getX(i) * s[0], pos.getY(i) * s[1], pos.getZ(i) * s[2]]));
        }
        const r = shapeBoundingRadius(spec);
        expect(far, JSON.stringify(spec)).toBeLessThanOrEqual(r + 1e-6);
        expect(far, `${JSON.stringify(spec)} bounding radius too loose`).toBeGreaterThan(r * 0.9);
      }
    });
  });

  it('outward normals on the convex solids (dome, hemisphere, frustum): every face looks away from the centre', () => {
    for (const id of ['dome', 'hemisphere', 'frustum']) {
      for (const spec of variants(id)) {
        const geo = shapeGeometry(GEOMETRY_KIT, spec);
        const s = shapeVisualScale(spec);
        const p = geo.getAttribute('position'),
          n = geo.getAttribute('normal');
        for (let i = 0; i < p.count; i++) {
          // a normal transforms by the inverse scale; the position by the scale
          const dot =
            (n.getX(i) / s[0]) * p.getX(i) * s[0] +
            (n.getY(i) / s[1]) * p.getY(i) * s[1] +
            (n.getZ(i) / s[2]) * p.getZ(i) * s[2];
          expect(dot, `${id} ${JSON.stringify(spec)} vertex ${i}`).toBeGreaterThan(-1e-5);
        }
      }
    }
  });
});

// ── compound structure ───────────────────────────────────────────────────────────────────────────────

describe('compound colliders have the advertised parts', () => {
  const parts = (id: string, params?: Record<string, number | boolean>, size?: Vec3) =>
    shapeColliders(RAPIER, makeShapeSpec(id, size, params)).length;

  it('torus: one hull per ring segment', () => {
    expect(parts('torus')).toBe(24);
    expect(parts('torus', { segments: 8 })).toBe(8);
    expect(parts('torus', { segments: 64 })).toBe(64);
  });
  it('ring and tube: one wedge per segment', () => {
    expect(parts('ring', { segments: 20 })).toBe(20);
    expect(parts('tube', { segments: 12 })).toBe(12);
  });
  it('arch: a deck, two legs and one slab per arc segment', () => {
    expect(parts('arch')).toBe(3 + 12);
    expect(parts('arch', { segments: 5 })).toBe(3 + 5);
  });
  it('stairs: one cuboid per step', () => {
    expect(parts('stairs')).toBe(6);
    expect(parts('stairs', { steps: 17 })).toBe(17);
  });
  it('spiral stairs: the column plus one hull per step (turns × steps per turn)', () => {
    expect(parts('spiral-stairs')).toBe(1 + 12);
    expect(parts('spiral-stairs', { turns: 2, stepsPerTurn: 10 })).toBe(1 + 20);
    expect(parts('spiral-stairs', { turns: 0.25, stepsPerTurn: 6 })).toBe(1 + 2); // at least two steps
  });
  it('beams: I has three rectangles, L and T two', () => {
    expect(parts('i-beam')).toBe(3);
    expect(parts('l-beam')).toBe(2);
    expect(parts('t-beam')).toBe(2);
  });
  it('hemisphere, dome and frustum are a single convex hull', () => {
    expect(parts('hemisphere')).toBe(1);
    expect(parts('dome')).toBe(1);
    expect(parts('frustum')).toBe(1);
  });
});

// ── size rules, parameters, saving ───────────────────────────────────────────────────────────────────

describe('size rules and parameters', () => {
  it('torus: round in plan, tube never wider than 40 % of the outer diameter (the hole stays open)', () => {
    expect(normalizeShapeSize('torus', [2, 0.5, 1])).toEqual([2, 0.5, 2].map((v, i) => (i === 1 ? 0.5 : v)));
    expect(normalizeShapeSize('torus', [2, 1.9, 2])[1]).toBeCloseTo(0.8, 12);
    expect(normalizeShapeSize('torus', [1.2, 0.3, 1], undefined, [1, 0.3, 1])).toEqual([1.2, 0.3, 1.2]);
    // shrinking the diameter below the tube drags the tube down with it
    expect(normalizeShapeSize('torus', [0.5, 0.3, 0.5], undefined, [1, 0.3, 1])[1]).toBeCloseTo(0.2, 12);
  });

  it('hemisphere: the height is the radius, whichever axis was edited', () => {
    expect(normalizeShapeSize('hemisphere', [2, 5, 2], undefined, [1, 0.5, 1])).toEqual([10, 5, 10]); // 5 is the new radius
    expect(normalizeShapeSize('hemisphere', [3, 0.5, 1], undefined, [1, 0.5, 1])).toEqual([3, 1.5, 3]);
    expect(normalizeShapeSize('hemisphere', [1, 0.5, 4], undefined, [1, 0.5, 1])).toEqual([4, 2, 4]);
    expect(normalizeShapeSize('hemisphere', [2, 2, 2])).toEqual([2, 1, 2]);
  });

  it('dome: height held between 5 % and 50 % of the base diameter', () => {
    expect(normalizeShapeSize('dome', [2, 5, 2], undefined, [2, 1, 2])).toEqual([2, 1, 2]);
    expect(normalizeShapeSize('dome', [2, 0.001, 2])[1]).toBeCloseTo(0.1, 12);
    expect(normalizeShapeSize('dome', [2, 0.7, 3], undefined, [2, 0.7, 2])).toEqual([3, 0.7, 3]);
  });

  it('arch: tall enough for an opening under a crown of the chosen thickness', () => {
    const s = makeShapeSpec('arch', [2, 0.1, 1]);
    expect(s.size[1]).toBeGreaterThan(0.22 * 2); // at least the crown thickness
    const l = archLayout(...s.size, 0.22, 12);
    expect(l.arc[Math.floor(l.arc.length / 2)][1]).toBeCloseTo(s.size[1] - l.t, 6); // crown sits one thickness below the top
  });

  it('every shape is stable under normalisation and keeps the size box centred (halfHeight = size y / 2)', () => {
    for (const id of NEW_SHAPES) {
      for (const spec of variants(id)) {
        expect(normalizeShapeSize(id, spec.size, spec.params), id).toEqual(spec.size);
        expect(shapeDef(id).halfHeight(spec)).toBeCloseTo(spec.size[1] / 2, 12);
      }
    }
  });

  it('parameters are coerced into range, unknown keys dropped, defaults filled', () => {
    expect(resolveParams(shapeDef('torus'), { segments: 1000, tubeSides: 2, stray: 1 })).toEqual({
      segments: 64,
      tubeSides: 6,
    });
    expect(resolveParams(shapeDef('ring'), { hole: 5 })).toEqual({ hole: 0.95, segments: 32 });
    expect(resolveParams(shapeDef('tube'), { wall: -1, segments: 'x' })).toEqual({ wall: 0.03, segments: 32 });
    expect(resolveParams(shapeDef('stairs'), { steps: 2.6 })).toEqual({ steps: 3 });
    expect(resolveParams(shapeDef('spiral-stairs'), { clockwise: 'yes', turns: 9 })).toEqual({
      turns: 3,
      stepsPerTurn: 12,
      core: 0.2,
      tread: 0.6,
      clockwise: false,
    });
    expect(resolveParams(shapeDef('frustum'), { top: 0 })).toEqual({ top: 0.05, segments: 32 });
    expect(resolveParams(shapeDef('i-beam'), { flange: 0.9, web: 0 })).toEqual({ flange: 0.4, web: 0.04 });
    expect(shapeDef('hemisphere').params.map((p) => p.key)).toEqual(['segments']);
  });

  it('default sizes are already normal and every new shape has a label, blurb, icon and category', () => {
    for (const id of NEW_SHAPES) {
      const d = shapeDef(id);
      expect(normalizeShapeSize(id, d.defaultSize, undefined)).toEqual(d.defaultSize);
      expect(d.blurb && d.blurb.length > 8).toBeTruthy();
      expect(d.icon.startsWith('<')).toBe(true);
      expect(d.label.length).toBeGreaterThan(2);
    }
  });

  it('save → load keeps every shape, size and parameter', () => {
    const doc = newDocument('shapes');
    doc.entities = NEW_SHAPES.map((id, i) => {
      const def = shapeDef(id);
      // a non-default value for every parameter
      const params: Record<string, number | boolean> = {};
      for (const p of def.params) {
        if (p.kind === 'int' || p.kind === 'float')
          params[p.key] = (p.min as number) + ((p.max as number) - (p.min as number)) / 3;
        if (p.kind === 'bool') params[p.key] = !p.default;
      }
      const spec = makeShapeSpec(id, undefined, params);
      return createBody({ name: id, shape: spec, position: [i * 3, 1, 0] });
    });
    const report = newReport();
    const back = parseDocument(serializeDocument(doc), report);
    expect(report.warnings).toEqual([]);
    for (const e of doc.entities as BodyEntity[]) {
      const loaded = back.entities.find((x) => x.id === e.id) as BodyEntity;
      expect(loaded.shape, e.name).toEqual(e.shape);
    }
  });

  it('meshes are shared between equal shapes of different size, and separated by what changes the mesh', () => {
    const key = (id: string, size?: Vec3, params?: Record<string, number | boolean>) =>
      shapeGeometryKey(makeShapeSpec(id, size, params));
    expect(key('torus', [1, 0.3, 1])).toBe(key('torus', [2, 0.6, 2])); // same tube ratio
    expect(key('torus', [1, 0.3, 1])).not.toBe(key('torus', [1, 0.2, 1]));
    expect(key('arch', [2, 2, 0.8])).toBe(key('arch', [4, 4, 3])); // depth is free, height ratio equal
    expect(key('arch', [2, 2, 0.8])).not.toBe(key('arch', [2, 3, 0.8]));
    expect(key('dome', [1, 0.3, 1])).toBe(key('dome', [3, 0.9, 3]));
    expect(key('dome', [1, 0.3, 1])).not.toBe(key('dome', [1, 0.4, 1]));
    expect(key('stairs', [1, 1, 1])).toBe(key('stairs', [3, 2, 5]));
    expect(key('stairs', undefined, { steps: 4 })).not.toBe(key('stairs', undefined, { steps: 5 }));
  });
});

// ── real physics: hollow shapes are hollow ───────────────────────────────────────────────────────────

describe('torus (SH-1): a real hole', () => {
  // outer diameter 1, tube diameter 0.3: tube radius 0.15, centre line 0.35, hole radius 0.2
  const torusAt = (y: number, rotation?: Quat) => fixed('torus', [1, 0.3, 1], [0, y, 0], undefined, rotation);

  it('a small ball dropped over the hole falls through it to the ground', async () => {
    const t = torusAt(1);
    const b = ball(0.12, [0, 2.5, 0], free);
    const w = await worldOf([t, b]);
    let lowestAboveGround = Infinity;
    let passedThrough = false;
    for (let i = 0; i < 4 * 120; i++) {
      w.stepOnce();
      const y = yOf(w, b.id);
      if (y < 0.8) passedThrough = true; // below the torus' underside (1 − 0.15)
      lowestAboveGround = Math.min(lowestAboveGround, y);
    }
    expect(passedThrough).toBe(true);
    expect(yOf(w, b.id)).toBeCloseTo(0.12, 2); // resting on the ground
    expect(Math.abs(w.getPose(b.id)!.position[0])).toBeLessThan(0.05); // went straight down the middle
    w.dispose();
  });

  it('a ball wider than the hole rests on top of the ring', async () => {
    const b = ball(0.3, [0, 2.5, 0], free);
    const w = await worldOf([torusAt(1), b]);
    run(w, 4);
    const y = yOf(w, b.id);
    // sits in the hole's rim: above the torus' top (1.15) minus the sag of a ball in a hole of radius 0.2
    expect(y).toBeGreaterThan(1.0);
    expect(y).toBeLessThan(1.5);
    w.dispose();
  });

  it('a ball dropped onto the tube itself lands on it instead of falling through', async () => {
    const b = ball(0.08, [0.35, 2, 0], free); // over the centre line of the tube
    const w = await worldOf([torusAt(1), b]);
    run(w, 3);
    expect(yOf(w, b.id)).toBeCloseTo(1 + 0.15 + 0.08, 1); // on top of the tube, within the polygon's tolerance
    w.dispose();
  });

  it('a ball flies through a standing torus along its axis (no gravity)', async () => {
    const stand = qfromAxisAngle([1, 0, 0], Math.PI / 2); // axis now along z
    const b = ball(0.12, [0, 1, -3], { ...free, velocity: [0, 0, 5] });
    const w = await worldOf([torusAt(1, stand), b], { gravity: [0, 0, 0] });
    run(w, 1.2);
    const p = w.getPose(b.id)!;
    expect(p.position[2]).toBeGreaterThan(2.5); // passed through and kept going
    expect(p.linvel[2]).toBeGreaterThan(4.9);
    expect(Math.abs(p.position[0]) + Math.abs(p.position[1] - 1)).toBeLessThan(0.02);
    w.dispose();
  });

  it('a ball off-centre by more than the hole is stopped by the ring', async () => {
    const stand = qfromAxisAngle([1, 0, 0], Math.PI / 2);
    const b = ball(0.12, [0.3, 1, -3], { ...free, velocity: [0, 0, 5] }); // hits the tube (centre line at 0.35)
    const w = await worldOf([torusAt(1, stand), b], { gravity: [0, 0, 0] });
    run(w, 1.2);
    expect(w.getPose(b.id)!.position[2]).toBeLessThan(0);
    w.dispose();
  });

  it('a dynamic torus lands flat and comes to rest on its tube', async () => {
    const t = createBody({
      shape: { type: 'torus', size: [1, 0.3, 1] },
      position: [0, 0.6, 0],
      rotation: qfromAxisAngle([1, 0, 0], 0.4),
    });
    const w = await worldOf([t]);
    run(w, 4);
    const p = w.getPose(t.id)!;
    expect(p.position[1]).toBeCloseTo(0.15, 1); // flat on the ground: centre one tube radius up
    expect(vlen(p.linvel)).toBeLessThan(0.05);
    w.dispose();
  });

  it('mass = density × analytic volume, within 0.1 %', async () => {
    const t = createBody({
      shape: { type: 'torus', size: [1, 0.3, 1] },
      position: [0, 1, 0],
      material: { preset: 'custom', density: 800 },
    });
    const w = await worldOf([t]);
    const m = w.builtInfo().mass[t.id];
    expect(Math.abs(m - 800 * shapeVolume(t.shape)) / m).toBeLessThan(1e-3);
    // approaches the smooth torus 2π²Rr² as the polygons get finer
    const fine = makeShapeSpec('torus', [1, 0.3, 1], { segments: 64, tubeSides: 32 });
    expect(Math.abs(shapeVolume(fine) - 2 * Math.PI ** 2 * 0.35 * 0.15 ** 2) / shapeVolume(fine)).toBeLessThan(0.009);
    w.dispose();
  });
});

describe('ring (SH-2): a washer has a hole', () => {
  it('a ball smaller than the hole falls through a raised ring, a larger one rests on it', async () => {
    // outer diameter 1, hole 0.55 → hole radius 0.275
    const r = fixed('ring', [1, 0.1, 1], [0, 1, 0]);
    const small = ball(0.2, [0, 2.5, 0], free);
    const big = ball(0.4, [0, 4, 0], free);
    const w = await worldOf([r, small, big]);
    run(w, 3);
    expect(yOf(w, small.id)).toBeCloseTo(0.2, 2); // fell through to the ground
    expect(yOf(w, big.id)).toBeGreaterThan(1.05); // caught by the ring
    w.dispose();
  });

  it('a wider hole lets a wider ball through (the hole parameter works)', async () => {
    const r = fixed('ring', [1, 0.1, 1], [0, 1, 0], { hole: 0.9 });
    const b = ball(0.35, [0, 2.5, 0], free);
    const w = await worldOf([r, b]);
    run(w, 3);
    expect(yOf(w, b.id)).toBeCloseTo(0.35, 2);
    w.dispose();
  });

  it('a dynamic washer lies flat', async () => {
    const r = createBody({
      shape: { type: 'ring', size: [1, 0.1, 1] },
      position: [0, 0.5, 0],
      rotation: qfromAxisAngle([0, 0, 1], 0.3),
    });
    const w = await worldOf([r]);
    run(w, 4);
    expect(w.getPose(r.id)!.position[1]).toBeCloseTo(0.05, 2);
    w.dispose();
  });
});

describe('tube (SH-2): a hollow pipe, open at both ends', () => {
  // outer diameter 0.6, wall 0.15 of the radius → inner radius 0.255
  it('a ball dropped down a raised pipe falls out of the bottom', async () => {
    const p = fixed('tube', [0.6, 1.5, 0.6], [0, 1.5, 0]);
    const b = ball(0.15, [0, 3.5, 0], free);
    const w = await worldOf([p, b]);
    run(w, 3);
    expect(yOf(w, b.id)).toBeCloseTo(0.15, 2);
    expect(Math.hypot(...(w.getPose(b.id)!.position.filter((_, i) => i !== 1) as [number, number]))).toBeLessThan(0.05);
    w.dispose();
  });

  it('a ball dropped into a pipe standing on the ground rests inside it, enclosed by the wall', async () => {
    const p = fixed('tube', [0.6, 1.5, 0.6], [0, 0.75, 0]);
    const b = ball(0.15, [0.05, 3, 0.05], free);
    const w = await worldOf([p, b]);
    run(w, 3);
    const pos = w.getPose(b.id)!.position;
    expect(pos[1]).toBeCloseTo(0.15, 2);
    expect(Math.hypot(pos[0], pos[2])).toBeLessThan(0.255 - 0.15 + 0.02); // inside the bore
    w.dispose();
  });

  it('a ball wider than the bore is stopped by the rim', async () => {
    const p = fixed('tube', [0.6, 1.5, 0.6], [0, 1.5, 0]);
    const b = ball(0.28, [0, 3.5, 0], free);
    const w = await worldOf([p, b]);
    run(w, 3);
    expect(yOf(w, b.id)).toBeGreaterThan(2.3); // resting on the rim at y = 2.25 (+ the sag into the bore)
    w.dispose();
  });

  it('a thick wall narrows the bore', async () => {
    const p = fixed('tube', [0.6, 1.5, 0.6], [0, 1.5, 0], { wall: 0.6 }); // inner radius 0.12
    const b = ball(0.15, [0, 3.5, 0], free);
    const w = await worldOf([p, b]);
    run(w, 3);
    expect(yOf(w, b.id)).toBeGreaterThan(2.3);
    w.dispose();
  });

  it('a ball flies through a pipe lying on its side, in one end and out of the other', async () => {
    const lie = qfromAxisAngle([0, 0, 1], Math.PI / 2); // axis along x
    const p = fixed('tube', [0.6, 2, 0.6], [0, 1, 0], undefined, lie);
    const b = ball(0.1, [-3, 1, 0], { ...free, velocity: [4, 0, 0] });
    const w = await worldOf([p, b], { gravity: [0, 0, 0] });
    run(w, 1.8);
    expect(w.getPose(b.id)!.position[0]).toBeGreaterThan(3.5);
    w.dispose();
    // a ball wider than the bore (0.51) is stopped by the rim
    const c = ball(0.28, [-3, 1, 0], { ...free, velocity: [4, 0, 0] });
    const w2 = await worldOf([p, c], { gravity: [0, 0, 0] });
    run(w2, 1.8);
    expect(w2.getPose(c.id)!.position[0]).toBeLessThan(-0.9);
    w2.dispose();
  });

  it('a pipe on its side rolls along the ground like a cylinder', async () => {
    const lie = qfromAxisAngle([1, 0, 0], Math.PI / 2); // axis along z, so it rolls along x
    const p = createBody({
      shape: { type: 'tube', size: [0.6, 1.5, 0.6] },
      position: [0, 0.3, 0],
      rotation: lie,
      velocity: [2, 0, 0],
      angularVelocity: [0, 0, -2 / 0.3], // rolling without slipping: ω = v / R
      ...free,
      material: { preset: 'wood', friction: 0.8, restitution: 0 },
    });
    const w = await worldOf([p]);
    run(w, 2);
    const q = w.getPose(p.id)!;
    // 4 m at a steady 2 m/s on a true cylinder; a 32-gon loses a little speed at every facet it rolls onto
    expect(q.position[0]).toBeGreaterThan(2.5);
    expect(q.linvel[0]).toBeGreaterThan(0.8);
    expect(q.position[1]).toBeCloseTo(0.3, 1);
    w.dispose();
  });
});

describe('arch (SH-3): walkable and stackable, with an opening to pass through', () => {
  // span 2, height 2, depth 0.8; thickness 0.22 → legs 0.44, opening half width 0.56, crown at 1.56 (a stilted semicircle)
  const archAt = () => fixed('arch', [2, 2, 0.8], [0, 1, 0]);

  it('a ball flies through the opening', async () => {
    const b = ball(0.2, [0, 0.5, -3], { ...free, velocity: [0, 0, 4] });
    const w = await worldOf([archAt(), b], { gravity: [0, 0, 0] });
    run(w, 2);
    const p = w.getPose(b.id)!;
    expect(p.position[2]).toBeGreaterThan(3.5);
    expect(Math.abs(p.position[0]) + Math.abs(p.position[1] - 0.5)).toBeLessThan(0.02);
    w.dispose();
  });

  it('a ball under the curve passes at the height of the crown, too wide a ball does not', async () => {
    const under = ball(0.2, [0, 1.2, -3], { ...free, velocity: [0, 0, 4] }); // crown at 1.56, ball top 1.4
    const w = await worldOf([archAt(), under], { gravity: [0, 0, 0] });
    run(w, 2);
    expect(w.getPose(under.id)!.position[2]).toBeGreaterThan(3.5);
    w.dispose();
    const wide = ball(0.4, [0, 0.45, -3], { ...free, velocity: [0, 0, 4] }); // 0.8 wide, opening 1.12 wide but crown low at the sides
    const high = ball(0.4, [0, 1.4, -3], { ...free, velocity: [0, 0, 4] }); // top at 1.8 > crown 1.56: blocked
    const w2 = await worldOf([archAt(), high], { gravity: [0, 0, 0] });
    run(w2, 2);
    expect(w2.getPose(high.id)!.position[2]).toBeLessThan(0);
    w2.dispose();
    void wide;
  });

  it('a ball aimed at a leg is stopped by it', async () => {
    const b = ball(0.2, [0.8, 0.5, -3], { ...free, velocity: [0, 0, 4] });
    const w = await worldOf([archAt(), b], { gravity: [0, 0, 0] });
    run(w, 2);
    expect(w.getPose(b.id)!.position[2]).toBeLessThan(0);
    w.dispose();
  });

  it('a box dropped on the deck rests on it (stackable)', async () => {
    const box = createBody({
      shape: { type: 'box', size: [0.5, 0.5, 0.5] },
      position: [0.3, 3, 0],
      material: ballMat,
      ...free,
    });
    const w = await worldOf([archAt(), box]);
    run(w, 3);
    expect(yOf(w, box.id)).toBeCloseTo(2.25, 2); // deck at 2 + half the box
    w.dispose();
  });

  it('a ball rolls the length of the deck without catching on a seam (walkable)', async () => {
    const b = ball(0.1, [-0.9, 2.1, 0], { ...free, velocity: [3, 0, 0], angularVelocity: [0, 0, -30] }); // rolling
    const w = await worldOf([archAt(), b]);
    let maxDev = 0;
    for (let i = 0; i < 120; i++) {
      w.stepOnce();
      const p = w.getPose(b.id)!;
      if (p.position[0] > -0.8 && p.position[0] < 0.8) maxDev = Math.max(maxDev, Math.abs(p.position[1] - 2.1));
    }
    expect(w.getPose(b.id)!.position[0]).toBeGreaterThan(0.9);
    expect(maxDev).toBeLessThan(0.005);
    w.dispose();
  });

  it('a low segmental arch still has a real opening', async () => {
    // height 0.9: the crown is 0.68 above the base, flatter than a semicircle of the 0.56 half width
    const a = fixed('arch', [2, 0.9, 0.8], [0, 0.45, 0]);
    const b = ball(0.12, [0, 0.3, -3], { ...free, velocity: [0, 0, 4] });
    const w = await worldOf([a, b], { gravity: [0, 0, 0] });
    run(w, 2);
    expect(w.getPose(b.id)!.position[2]).toBeGreaterThan(3.5);
    w.dispose();
  });

  it('a dynamic arch settles on its legs', async () => {
    const a = createBody({ shape: { type: 'arch', size: [2, 2, 0.8] }, position: [0, 1.2, 0] });
    const w = await worldOf([a]);
    run(w, 4);
    const p = w.getPose(a.id)!;
    expect(p.position[1]).toBeCloseTo(1, 2);
    expect(vlen(p.linvel)).toBeLessThan(0.02);
    w.dispose();
  });
});

describe('stairs (SH-4): a ball comes to rest on a step', () => {
  // 1.2 wide, 1.2 high, 1.8 deep, 6 steps: rise 0.2, run 0.3; the low end is toward +z, a step's tread at (i+1)·0.2
  const stairsAt = () => fixed('stairs', [1.2, 1.2, 1.8], [0, 0.6, 0]);
  const treadCentreZ = (i: number) => 0.9 - (i + 0.5) * 0.3;

  it.each([0, 2, 3, 5])('a ball dropped on the tread of step %i rests on it', async (i) => {
    const b = ball(0.08, [0, 3, treadCentreZ(i)], free);
    const w = await worldOf([stairsAt(), b]);
    run(w, 3);
    const p = w.getPose(b.id)!;
    expect(p.position[1]).toBeCloseTo((i + 1) * 0.2 + 0.08, 2);
    expect(Math.abs(p.position[2] - treadCentreZ(i))).toBeLessThan(0.02);
    expect(vlen(p.linvel)).toBeLessThan(0.02);
    w.dispose();
  });

  it('a ball rolled up the flight is stopped by the riser of the next step', async () => {
    const b = ball(0.08, [0, 0.08, 2.2], { ...free, velocity: [0, 0, -3] });
    const w = await worldOf([stairsAt(), b]);
    run(w, 1);
    expect(w.getPose(b.id)!.position[2]).toBeGreaterThan(0.6); // never gets past the first riser at z = 0.6
    w.dispose();
  });

  it('a ball rolls down the flight step by step, ending on the ground', async () => {
    const b = ball(0.08, [0, 1.35, -0.8], { ...free, velocity: [0, 0, 0.6] });
    const w = await worldOf([stairsAt(), b]);
    run(w, 6);
    expect(yOf(w, b.id)).toBeLessThan(0.3); // down at the foot (or on the first step)
    expect(w.getPose(b.id)!.position[2]).toBeGreaterThan(0.5);
    w.dispose();
  });

  it('a dynamic flight rests flat on the ground', async () => {
    const s = createBody({ shape: { type: 'stairs', size: [1.2, 1.2, 1.8] }, position: [0, 0.9, 0] });
    const w = await worldOf([s]);
    run(w, 4);
    expect(w.getPose(s.id)!.position[1]).toBeCloseTo(0.6, 2);
    w.dispose();
  });

  it('the volume is that of a staircase: W·H·D·(n+1)/(2n)', () => {
    expect(shapeVolume(makeShapeSpec('stairs', [1.2, 1.2, 1.8], { steps: 6 }))).toBeCloseTo(
      1.2 * 1.2 * 1.8 * (7 / 12),
      12,
    );
    expect(shapeVolume(makeShapeSpec('stairs', [1, 1, 1], { steps: 48 }))).toBeCloseTo(49 / 96, 12);
  });
});

describe('spiral stairs (SH-4): treads wind around a column', () => {
  const size: Vec3 = [2, 2.4, 2];
  const at: Vec3 = [0, 1.2, 0];

  /** A point inside tread `i` (the mean of its corners) and the world height of its top. */
  function onTread(i: number, params?: Record<string, number | boolean>) {
    const spec = makeShapeSpec('spiral-stairs', size, params);
    const s = spiralLayout(spec);
    const poly = treadPolygon(s, i);
    const x = poly.reduce((a, p) => a + p[0], 0) / poly.length;
    const z = poly.reduce((a, p) => a + p[1], 0) / poly.length;
    return { x, z, top: at[1] + treadTop(s, i), spec: s };
  }

  it.each([0, 4, 7, 11])('a ball dropped on tread %i rests on it', async (i) => {
    const t = onTread(i);
    const b = ball(0.07, [t.x, 4, t.z], free);
    const w = await worldOf([fixed('spiral-stairs', size, at), b]);
    run(w, 3);
    const p = w.getPose(b.id)!;
    expect(p.position[1]).toBeCloseTo(t.top + 0.07, 2);
    expect(vlen(p.linvel)).toBeLessThan(0.02);
    w.dispose();
  });

  it('the stair climbs to the top of its size box and the top tread is where the height says', () => {
    const s = spiralLayout(makeShapeSpec('spiral-stairs', size));
    expect(treadTop(s, s.steps - 1)).toBeCloseTo(size[1] / 2, 12);
    expect(treadTop(s, 0) - s.tt).toBeCloseTo(-size[1] / 2, 12);
    expect(s.steps).toBe(12);
    expect(s.rise * (s.steps - 1) + s.tt).toBeCloseTo(size[1], 12);
  });

  it('turns × steps per turn sets the step count; clockwise mirrors the stair', () => {
    expect(spiralLayout(makeShapeSpec('spiral-stairs', size, { turns: 2, stepsPerTurn: 8 })).steps).toBe(16);
    const ccw = spiralLayout(makeShapeSpec('spiral-stairs', size, { clockwise: false }));
    const cw = spiralLayout(makeShapeSpec('spiral-stairs', size, { clockwise: true }));
    expect(ccw.dir).toBe(-1);
    expect(cw.dir).toBe(1);
    const a = treadPolygon(ccw, 3),
      b = treadPolygon(cw, 3);
    // mirror images about the plane x = 0 (the first tread starts on the +z axis)
    expect(a[1][0]).toBeCloseTo(-b[1][0], 9);
    expect(a[1][1]).toBeCloseTo(b[1][1], 9);
  });

  it('a second turn clears the first: the gap between turns exceeds the tread thickness', () => {
    for (const tread of [0.2, 0.6, 1.5]) {
      for (const perTurn of [6, 12, 32]) {
        const s = spiralLayout(makeShapeSpec('spiral-stairs', size, { turns: 2, stepsPerTurn: perTurn, tread }));
        expect(s.perTurn * s.rise).toBeGreaterThan(s.tt);
      }
    }
  });

  it('a ball dropped beside the column cannot sink into it', async () => {
    const t = onTread(0);
    const b = ball(0.07, [t.x, 5, t.z], free);
    const w = await worldOf([fixed('spiral-stairs', size, at), b]);
    run(w, 3);
    const p = w.getPose(b.id)!;
    expect(Math.hypot(p.position[0], p.position[2])).toBeGreaterThan(0.2 * 1 - 0.01); // outside the column radius 0.2
    w.dispose();
  });

  it('a dynamic spiral stair lands upright on its column and treads', async () => {
    // set down gently: with its treads out to the full radius it is top-heavy on a 0.2 m column, so a drop tips it
    const s = createBody({ shape: { type: 'spiral-stairs', size }, position: [0, 1.2 + 0.004, 0] });
    const w = await worldOf([s]);
    run(w, 4);
    expect(w.getPose(s.id)!.position[1]).toBeCloseTo(1.2, 2);
    expect(vlen(w.getPose(s.id)!.angvel)).toBeLessThan(0.01);
    w.dispose();
  });
});

describe('hemisphere, dome, frustum (SH-5)', () => {
  it('hemisphere volume approaches 2/3 π r³ as the rings get finer', () => {
    const v = (n: number) => shapeVolume(makeShapeSpec('hemisphere', [2, 1, 2], { segments: n }));
    expect(v(48) / ((2 / 3) * Math.PI)).toBeGreaterThan(0.98);
    expect(v(48) / ((2 / 3) * Math.PI)).toBeLessThan(1);
    expect(v(8)).toBeLessThan(v(24));
    expect(v(24)).toBeLessThan(v(48));
  });

  it('dome volume approaches the spherical cap π h (3a² + h²) / 6', () => {
    const spec = makeShapeSpec('dome', [2, 0.6, 2], { segments: 48 });
    const cap = (Math.PI * 0.6 * (3 * 1 + 0.36)) / 6;
    expect(shapeVolume(spec) / cap).toBeGreaterThan(0.97);
    expect(shapeVolume(spec) / cap).toBeLessThan(1);
    // at the maximum height the dome is the hemisphere
    const full = makeShapeSpec('dome', [2, 1, 2], { segments: 24 });
    const half = makeShapeSpec('hemisphere', [2, 1, 2], { segments: 24 });
    expect(shapeVolume(full) / shapeVolume(half)).toBeGreaterThan(0.98);
    expect(shapeVolume(full) / shapeVolume(half)).toBeLessThan(1.02);
  });

  it('frustum volume is the frustum-of-a-pyramid formula and a cylinder at ratio 1', () => {
    const spec = makeShapeSpec('frustum', [2, 1, 2], { top: 0.5, segments: 64 });
    const exact = (Math.PI / 3) * (1 + 0.5 + 0.25); // π h/3 (R² + R r + r²)
    expect(shapeVolume(spec) / exact).toBeGreaterThan(0.99);
    expect(shapeVolume(spec) / exact).toBeLessThan(1);
    const cyl = makeShapeSpec('frustum', [2, 1, 2], { top: 1, segments: 64 });
    expect(shapeVolume(cyl) / Math.PI).toBeGreaterThan(0.99);
    // top above 1: the top is the wide end; same volume as flipped
    const flipped = makeShapeSpec('frustum', [2, 1, 2], { top: 2, segments: 64 });
    const narrow = makeShapeSpec('frustum', [1, 1, 1], { top: 0.5, segments: 64 });
    expect(shapeVolume(flipped) / (shapeVolume(narrow) * 4)).toBeCloseTo(1, 9);
  });

  it('hemisphere stands on its flat face and a frustum pot rests on its wide end', async () => {
    const h = createBody({ shape: { type: 'hemisphere', size: [1, 0.5, 1] }, position: [0, 0.5, 0] });
    const f = createBody({ shape: { type: 'frustum', size: [1, 1, 1], params: { top: 0.6 } }, position: [3, 0.6, 0] });
    const w = await worldOf([h, f]);
    run(w, 4);
    expect(w.getPose(h.id)!.position[1]).toBeCloseTo(0.25, 2);
    expect(w.getPose(f.id)!.position[1]).toBeCloseTo(0.5, 2);
    w.dispose();
  });

  it('a hemisphere placed round side down rocks back to rest on its pole (weeble), centre of mass below the centre of curvature', async () => {
    const flip = qfromAxisAngle([1, 0, 0], Math.PI + 0.3); // pole down, tipped 17° from upright
    const h = createBody({
      shape: { type: 'hemisphere', size: [1, 0.5, 1] },
      position: [0, 0.27, 0],
      rotation: flip,
      angularDamping: 0.6,
    });
    const w = await worldOf([h]);
    run(w, 10);
    const p = w.getPose(h.id)!;
    // local +y is the pole; upside down means the pole points down
    const up = qrot(p.rotation, [0, 1, 0]);
    // it is a polyhedron: it settles on the facet around its pole, tilted by half a ring step (7.5° at 24 segments)
    expect(up[1]).toBeLessThan(-Math.cos((8 * Math.PI) / 180));
    expect(p.position[1]).toBeCloseTo(0.25, 2); // pole on the ground: the shape's centre is a quarter diameter up
    w.dispose();
  });

  it('a ball dropped on a dome rolls off its crown, on a hemisphere flat side up it stays put', async () => {
    const d = fixed('dome', [1.6, 0.6, 1.6], [0, 0.3, 0]);
    const b = ball(0.1, [0.05, 2, 0.02], free);
    const w = await worldOf([d, b]);
    run(w, 4);
    expect(Math.hypot(w.getPose(b.id)!.position[0], w.getPose(b.id)!.position[2])).toBeGreaterThan(0.6); // rolled down
    w.dispose();
  });
});

describe('beams (SH-6): real sections, not bounding boxes', () => {
  it('an I-beam on its side has an open pocket: a ball rests on the web, between the flanges', async () => {
    // I-beam [2, 0.4, 0.3]: flange 0.048, web 0.042 thick. Turned 90° about x, the web is horizontal and the flanges
    // are two vertical walls 0.304 apart.
    const turn = qfromAxisAngle([1, 0, 0], Math.PI / 2);
    const beam = fixed('i-beam', [2, 0.4, 0.3], [0, 0.3, 0], undefined, turn);
    const b = ball(0.06, [0, 3, 0], free);
    const w = await worldOf([beam, b]);
    run(w, 3);
    // web top = beam centre + half the web thickness; a bounding-box collider would hold the ball 0.15 higher
    const webTop = 0.3 + 0.021;
    expect(yOf(w, b.id)).toBeCloseTo(webTop + 0.06, 2);
    w.dispose();
  });

  it('an L-beam: a ball rests on the base leg beside the upright leg', async () => {
    // [2, 0.5, 0.5]: legs 0.08 thick; upright on the −z side
    const beam = fixed('l-beam', [2, 0.5, 0.5], [0, 0.25, 0]);
    const b = ball(0.08, [0, 2, 0.1], free);
    const w = await worldOf([beam, b]);
    run(w, 3);
    expect(yOf(w, b.id)).toBeCloseTo(0.08 + 0.08, 2);
    // and it cannot pass through the upright leg: roll it toward −z
    const c = ball(0.08, [0, 0.16, 0.2], { ...free, velocity: [0, 0, -2] });
    const w2 = await worldOf([beam, c]);
    run(w2, 1);
    expect(w2.getPose(c.id)!.position[2]).toBeGreaterThan(-0.25 + 0.08 - 0.01);
    w.dispose();
    w2.dispose();
  });

  it('a T-beam: a ball slides under the flange up to the stem', async () => {
    // [2, 0.5, 0.5], flange 0.08 thick, stem 0.1 wide and 0.42 tall, stands on the ground
    const beam = fixed('t-beam', [2, 0.5, 0.5], [0, 0.25, 0]);
    const b = ball(0.1, [0, 0.1, 0.22], { ...free, velocity: [0, 0, -1] });
    const w = await worldOf([beam, b]);
    run(w, 1);
    expect(w.getPose(b.id)!.position[2]).toBeGreaterThan(0.05 + 0.1 - 0.01); // blocked by the stem face at z = 0.05
    w.dispose();
    // a ball falling onto the flange rests on top of it
    const c = ball(0.1, [0, 2, 0.2], free);
    const w2 = await worldOf([beam, c]);
    run(w2, 2);
    expect(yOf(w2, c.id)).toBeCloseTo(0.5 + 0.1, 2);
    w2.dispose();
  });

  it('the I-beam section is smaller than its bounding box', () => {
    const spec = makeShapeSpec('i-beam', [2, 0.4, 0.3]);
    const box = 2 * 0.4 * 0.3;
    expect(shapeVolume(spec)).toBeLessThan(box * 0.5);
    expect(shapeVolume(spec)).toBeCloseTo(2 * (2 * 0.3 * 0.048 + 0.042 * (0.4 - 0.096)), 12);
  });
});

// ── dynamic bodies settle (mesh and collider agree where the ground is) ──────────────────────────────

describe('every new shape, dropped, comes to rest with its lowest mesh point on the ground', () => {
  it.each(NEW_SHAPES)('%s', async (id) => {
    const spec = makeShapeSpec(id);
    const rot = qfromAxisAngle([1, 0.4, 0.2], 0.5); // tumble in from an arbitrary attitude
    const body = createBody({
      shape: spec,
      position: [0, shapeBoundingRadius(spec) + 0.6, 0],
      rotation: rot,
      material: { preset: 'wood' },
    });
    const w = await worldOf([body]);
    run(w, 12);
    const p = w.getPose(body.id)!;
    expect(p.position.every(Number.isFinite)).toBe(true);
    expect(vlen(p.linvel)).toBeLessThan(0.1);
    expect(vlen(p.angvel)).toBeLessThan(0.5);
    // lowest vertex of the mesh in the world
    const geo = shapeGeometry(GEOMETRY_KIT, spec);
    const s = shapeVisualScale(spec);
    const pos = geo.getAttribute('position');
    let lowest = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const v = qrot(p.rotation, [pos.getX(i) * s[0], pos.getY(i) * s[1], pos.getZ(i) * s[2]]);
      lowest = Math.min(lowest, v[1] + p.position[1]);
    }
    expect(Math.abs(lowest), `${id} lowest mesh point ${lowest}`).toBeLessThan(0.012);
    w.dispose();
  });
});

describe('live edits', () => {
  it('changing a shape parameter or size while the world runs rebuilds the compound body with the new volume', async () => {
    const t = createBody({
      shape: { type: 'torus', size: [1, 0.3, 1] },
      position: [0, 3, 0],
      material: { preset: 'custom', density: 900 },
    });
    const w = await worldOf([t]);
    run(w, 0.2);
    const mass = () => w.builtInfo().mass[t.id];
    expect(Math.abs(mass() - 900 * shapeVolume(t.shape)) / mass()).toBeLessThan(1e-3);
    const coarse: BodyEntity = { ...t, shape: makeShapeSpec('torus', [1.2, 0.4, 1.2], { segments: 12, tubeSides: 8 }) };
    w.updateBody(coarse);
    run(w, 0.2);
    expect(Math.abs(mass() - 900 * shapeVolume(coarse.shape)) / mass()).toBeLessThan(1e-3);
    expect(mass()).not.toBeCloseTo(900 * shapeVolume(t.shape), 0);
    // the edited body keeps simulating: it is still falling and has not been duplicated
    expect(w.bodyIds).toEqual([t.id]);
    expect(w.getPose(t.id)!.position[1]).toBeLessThan(3);
    w.dispose();
  });
});

describe('documents', () => {
  it('a scene made of the new shapes loads and builds without warnings', async () => {
    const doc = docOf(
      NEW_SHAPES.map((id, i) => createBody({ shape: { type: id }, position: [(i % 4) * 3, 2, Math.floor(i / 4) * 3] })),
    );
    const report = newReport();
    const back = parseDocument(serializeDocument(doc), report);
    expect(report.warnings).toEqual([]);
    const w = await worldOf(back.entities);
    run(w, 1);
    for (const e of back.entities as BodyEntity[]) expect(w.getPose(e.id)!.position.every(Number.isFinite)).toBe(true);
    w.dispose();
  });
});

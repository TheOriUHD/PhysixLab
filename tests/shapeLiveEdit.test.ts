/**
 * Package SH, chunk 2 — SH-13: the inspector edits every parameter of every shape, with live resizing. For all the
 * registered shapes this drives the same edit path the inspector uses (`normalizeShapeSize`, `coerceParam`,
 * `applyQuantity`) into a running world (`updateBody`: the engine body is rebuilt in place at its live pose) and
 * checks that the body survives, stays finite, weighs density × volume of the new shape, and that its mesh builds.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/core/math';
import { createBody, defaultGround } from '../src/model/factory';
import {
  applyQuantity,
  coerceParam,
  completeSpec,
  listShapes,
  makeShapeSpec,
  normalizeShapeSize,
  shapeBoundingRadius,
  shapeDef,
  shapeGeometry,
  shapeVolume,
  type ParamDef,
} from '../src/model/shapeRegistry';
import type { ShapeSpec } from '../src/model/types';
import { GEOMETRY_KIT } from '../src/render/geometryKit';
import { initRapier } from '../src/physics/world';
import { run, worldOf } from './helpers';

beforeAll(async () => {
  await initRapier();
});

/** The values the inspector can give a parameter: the ends of its range, the middle and the default. */
function paramValues(p: ParamDef): (number | string | boolean)[] {
  if (p.kind === 'bool') return [true, false];
  if (p.kind === 'enum') return (p.options ?? []).map((o) => o.value);
  const lo = p.min ?? Number(p.default) / 2,
    hi = p.max ?? Number(p.default) * 2;
  const mid = (lo + hi) / 2;
  return [lo, hi, mid, p.default].map((v) => coerceParam(p, v) as number);
}

/** Every edited spec the inspector can produce from the default of a shape. */
function edits(id: string): { label: string; spec: ShapeSpec }[] {
  const def = shapeDef(id);
  const base = completeSpec(makeShapeSpec(id));
  const out: { label: string; spec: ShapeSpec }[] = [];
  for (const f of def.sizeFields)
    for (const k of [0.5, 2]) {
      const next: Vec3 = [...base.size];
      next[f.axis] = base.size[f.axis] * k;
      out.push({
        label: `${f.label} ×${k}`,
        spec: { ...base, size: normalizeShapeSize(id, next, base.params, base.size) },
      });
    }
  for (const p of def.params)
    for (const v of paramValues(p)) {
      const params = { ...base.params, [p.key]: v };
      out.push({
        label: `${p.label} = ${String(v)}`,
        spec: { ...base, params, size: normalizeShapeSize(id, base.size, params, base.size) },
      });
    }
  for (const q of def.quantities ?? [])
    for (const f of [0.6, 1.4]) {
      const target = Math.min(q.max ?? Infinity, Math.max(q.min ?? 0, q.get(base) * f));
      out.push({ label: `${q.label} → ${target.toPrecision(3)}`, spec: applyQuantity(base, q, target) });
    }
  return out;
}

const SHAPES = listShapes().map((d) => d.id);

describe('live editing of every shape (SH-13)', () => {
  it('covers every built-in shape (38 of them in this build)', () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(38);
  });

  it.each(SHAPES)('%s: every size field and parameter resizes the running body', async (id) => {
    const body = createBody({
      shape: makeShapeSpec(id),
      position: [0, 3, 0],
      gravityScale: 0,
      material: { preset: 'custom', density: 1000, friction: 0.5, restitution: 0.1 },
    });
    const w = await worldOf([body], { ground: { ...defaultGround(), enabled: false } });
    run(w, 0.05);
    for (const { label, spec } of edits(id)) {
      const where = `${id}: ${label}`;
      expect(shapeVolume(spec), where).toBeGreaterThan(0);
      expect(Number.isFinite(shapeBoundingRadius(spec)), where).toBe(true);
      w.updateBody({ ...body, shape: spec });
      run(w, 0.05);
      const pose = w.getPose(body.id);
      expect(pose, where).not.toBeNull();
      for (const v of [...pose!.position, ...pose!.rotation, ...pose!.linvel])
        expect(Number.isFinite(v), where).toBe(true);
      const mass = w.builtInfo().mass[body.id];
      const expected = shapeVolume(spec) * 1000;
      expect(Math.abs(mass - expected) / expected, `${where}: mass ${mass} vs ${expected}`).toBeLessThan(0.02);
      // the mesh builds, is finite and non-empty
      const geo = shapeGeometry(GEOMETRY_KIT, spec);
      const p = geo.getAttribute('position');
      expect(p.count, where).toBeGreaterThan(0);
      for (let i = 0; i < p.array.length; i++) expect(Number.isFinite(p.array[i]), where).toBe(true);
      geo.dispose();
    }
    w.dispose();
  });

  it('derived quantities read back what was set (within their limits)', () => {
    let checked = 0;
    for (const def of listShapes())
      for (const q of def.quantities ?? []) {
        const base = completeSpec(makeShapeSpec(def.id));
        const target = Math.min(q.max ?? Infinity, Math.max(q.min ?? 0, q.get(base) * 1.25));
        const out = completeSpec(applyQuantity(base, q, target));
        // a quantity can be limited by another constraint of the shape (a corner radius by the shortest side);
        // otherwise it reads back exactly what was set
        const back = q.get(out);
        expect(Math.abs(back - target) / Math.max(1e-9, Math.abs(target)), `${def.id}: ${q.label}`).toBeLessThan(0.02);
        checked++;
      }
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});

/**
 * Fuzzing `sanitizeParams` (JT-A): whatever a file or a share link holds in `JointEntity.params` — NaN, Infinity, strings,
 * wrong-length arrays, missing or damaged `dof` rows — comes out as valid, finite values inside the documented ranges,
 * is stable under a second sanitising, and a joint written before `params` existed loads with the defaults.
 */
import { describe, expect, it } from 'vitest';
import { createBody, createJoint, newDocument } from '../src/model/factory';
import { newReport } from '../src/model/errors';
import { defaultParams, JT_A_TYPES, sanitizeParams, type JointParams } from '../src/model/jointParams';
import { parseDocument, serializeDocument } from '../src/model/serialize';
import type { JointEntity } from '../src/model/types';

const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

/** A random value that is rarely what the field wants. */
function junk(r: () => number): unknown {
  switch (Math.floor(r() * 14)) {
    case 0:
      return NaN;
    case 1:
      return Infinity;
    case 2:
      return -Infinity;
    case 3:
      return 'abc';
    case 4:
      return null;
    case 5:
      return undefined;
    case 6:
      return {};
    case 7:
      return [1, 2]; // wrong length for a vector
    case 8:
      return [1, 2, 3, 4];
    case 9:
      return ['a', 'b', 'c'];
    case 10:
      return [NaN, 0, 1];
    case 11:
      return (r() - 0.5) * 1e12; // far outside every range
    case 12:
      return true;
    default:
      return (r() - 0.5) * 20; // plausible
  }
}

const FIELDS: (keyof JointParams)[] = [
  'swing',
  'twistMin',
  'twistMax',
  'dof',
  'ratio',
  'reverse',
  'radiusA',
  'radiusB',
  'axisB',
  'slipTorque',
  'chain',
  'pulleyA',
  'pulleyB',
  'pitch',
  'loadRating',
  'refOffset',
  'refLocked',
  'linStiffness',
  'linDamping',
  'angStiffness',
  'angDamping',
];
const DOF_FIELDS = ['mode', 'min', 'max', 'stiffness', 'damping', 'motorVelocity', 'motorForce'];

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const inRange = (x: number, lo: number, hi: number) => x >= lo && x <= hi;
const finiteVec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(finite);

/** The documented ranges of every field (`src/model/jointParams.ts`). */
function expectValid(p: JointParams, label: string): void {
  expect(inRange(p.swing, 0.001, Math.PI), `${label} swing`).toBe(true);
  expect(inRange(p.twistMin, -Math.PI, Math.PI), `${label} twistMin`).toBe(true);
  expect(inRange(p.twistMax, -Math.PI, Math.PI), `${label} twistMax`).toBe(true);
  expect(inRange(p.ratio, 0.01, 1000), `${label} ratio`).toBe(true);
  expect(inRange(p.radiusA, 0.005, 100), `${label} radiusA`).toBe(true);
  expect(inRange(p.radiusB, 0.005, 100), `${label} radiusB`).toBe(true);
  expect(inRange(p.slipTorque, 0, 1e9), `${label} slipTorque`).toBe(true);
  expect(inRange(p.loadRating, 0, 1e9), `${label} loadRating`).toBe(true);
  expect(inRange(p.refOffset, -1e4, 1e4), `${label} refOffset`).toBe(true);
  expect(p.pitch !== 0 && inRange(p.pitch, -100, 100), `${label} pitch is a non-zero thread`).toBe(true);
  for (const k of ['linStiffness', 'linDamping', 'angStiffness', 'angDamping'] as const)
    expect(finite(p[k]) && inRange(p[k], 0, 1e9), `${label} ${k}`).toBe(true);
  for (const k of ['axisB', 'pulleyA', 'pulleyB'] as const) expect(finiteVec(p[k]), `${label} ${k}`).toBe(true);
  for (const k of ['reverse', 'chain', 'refLocked'] as const) expect(typeof p[k], `${label} ${k}`).toBe('boolean');
  expect(p.dof, `${label} dof`).toHaveLength(6);
  p.dof.forEach((d, i) => {
    expect(['free', 'limited', 'locked'], `${label} dof[${i}].mode`).toContain(d.mode);
    expect(finite(d.min) && inRange(d.min, -1e4, 1e4), `${label} dof[${i}].min`).toBe(true);
    expect(finite(d.max) && inRange(d.max, -1e4, 1e4), `${label} dof[${i}].max`).toBe(true);
    expect(finite(d.stiffness) && inRange(d.stiffness, 0, 1e9), `${label} dof[${i}].stiffness`).toBe(true);
    expect(finite(d.damping) && inRange(d.damping, 0, 1e9), `${label} dof[${i}].damping`).toBe(true);
    expect(finite(d.motorVelocity) && inRange(d.motorVelocity, -1e4, 1e4), `${label} dof[${i}].motorVelocity`).toBe(
      true,
    );
    expect(finite(d.motorForce) && inRange(d.motorForce, 0, 1e9), `${label} dof[${i}].motorForce`).toBe(true);
  });
  // nothing but the documented fields survives
  expect(Object.keys(p).sort()).toEqual(Object.keys(defaultParams()).sort());
}

describe('sanitizeParams under fuzzing', () => {
  it('turns thousands of damaged params objects into valid ones, and is idempotent', () => {
    const r = lcg(20240611);
    for (let n = 0; n < 4000; n++) {
      const raw: Record<string, unknown> = {};
      // start from valid defaults half of the time so the fields are damaged one by one
      if (r() < 0.5) Object.assign(raw, JSON.parse(JSON.stringify(defaultParams())));
      for (const f of FIELDS) if (r() < 0.45) raw[f] = junk(r);
      raw.unknownField = junk(r);
      // damage the dof rows: a list of the wrong length, junk rows, rows with junk fields
      if (r() < 0.5) {
        const rows = Array.from({ length: Math.floor(r() * 9) }, () => {
          if (r() < 0.25) return junk(r);
          const row: Record<string, unknown> = {};
          for (const k of DOF_FIELDS) if (r() < 0.8) row[k] = k === 'mode' && r() < 0.5 ? 'free' : junk(r);
          return row;
        });
        raw.dof = r() < 0.15 ? junk(r) : rows;
      }
      const once = sanitizeParams(raw);
      expectValid(once, `case ${n}`);
      expect(sanitizeParams(JSON.parse(JSON.stringify(once))), `case ${n} is stable`).toEqual(once);
    }
  });

  it('accepts anything that is not an object', () => {
    for (const raw of [undefined, null, NaN, 0, 'x', true, [], [1, 2, 3], () => 1, Symbol.iterator])
      expectValid(sanitizeParams(raw), String(raw));
  });

  it('missing dof rows and unknown modes become locked rows with the default limits', () => {
    const p = sanitizeParams({ dof: [{ mode: 'free', min: 3, max: 4 }, { mode: 'floating' }, 7, null] });
    expect(p.dof[0]).toMatchObject({ mode: 'free', min: 3, max: 4 });
    for (let i = 1; i < 6; i++) expect(p.dof[i].mode).toBe('locked');
    expect(p.dof[1].min).toBe(defaultParams().dof[1].min);
    expect(p.dof).toHaveLength(6);
  });

  it('keeps every valid value of a hand-made set unchanged', () => {
    const d = defaultParams();
    const mine: JointParams = {
      ...d,
      swing: 1.2,
      twistMin: -0.5,
      twistMax: 0.9,
      ratio: 2.5,
      reverse: false,
      radiusA: 0.3,
      radiusB: 0.9,
      axisB: [0, 1, 0],
      slipTorque: 12,
      chain: true,
      pulleyA: [-1, 5, 2],
      pulleyB: [1, 5, 2],
      pitch: -0.4,
      loadRating: 300,
      refOffset: -0.25,
      refLocked: true,
      linStiffness: 1e5,
      linDamping: 900,
      angStiffness: 7000,
      angDamping: 120,
      dof: d.dof.map((x, i) => ({
        ...x,
        mode: (['free', 'limited', 'locked'] as const)[i % 3],
        min: -i - 1,
        max: i + 1,
        stiffness: 10 * i,
        damping: i,
        motorVelocity: i === 0 ? 0 : -i,
        motorForce: 5 * i,
      })),
    };
    expect(sanitizeParams(JSON.parse(JSON.stringify(mine)))).toEqual(mine);
  });
});

describe('joints from before `params` existed', () => {
  it('load with the default params for their type and no warning', () => {
    const doc = newDocument('old file');
    const a = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [0, 1, 0] });
    const b = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [2, 1, 0] });
    const types = ['fixed', 'hinge', 'slider', 'ball', 'spring', 'rope', ...JT_A_TYPES] as const;
    const joints = types.map((type) => createJoint({ type, bodyA: a.id, bodyB: b.id, anchorA: [1, 1, 0] }));
    doc.entities = [a, b, ...joints];
    const raw = JSON.parse(serializeDocument(doc)) as { entities: Record<string, unknown>[] };
    for (const e of raw.entities) if (e.kind === 'joint') delete e.params; // what an old build wrote
    const report = newReport();
    const loaded = parseDocument(JSON.stringify(raw), report);
    expect(report.warnings).toEqual([]);
    const got = loaded.entities.filter((e): e is JointEntity => e.kind === 'joint');
    expect(got.map((j) => j.type)).toEqual([...types]);
    for (const j of got) {
      expectValid(j.params, j.type);
      expect(j.params, `${j.type} gets the defaults`).toEqual(defaultParams());
    }
  });

  it('a 6-DOF joint without params starts fully locked (it behaves like a weld, not like a free body)', () => {
    const doc = newDocument('old sixdof');
    const a = createBody({ shape: { type: 'box', size: [1, 1, 1] } });
    const b = createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [2, 0, 0] });
    doc.entities = [a, b, createJoint({ type: 'sixdof', bodyA: a.id, bodyB: b.id, anchorA: [1, 0, 0] })];
    const raw = JSON.parse(serializeDocument(doc)) as { entities: Record<string, unknown>[] };
    delete raw.entities[2].params;
    const j = parseDocument(JSON.stringify(raw)).entities[2] as JointEntity;
    expect(j.params.dof.map((d) => d.mode)).toEqual(Array(6).fill('locked'));
  });
});

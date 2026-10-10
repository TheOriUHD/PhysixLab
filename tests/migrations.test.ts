/**
 * The scene format version, the migration chain and the loader's limits (src/model/migrations.ts,
 * limits.ts, serialize.ts). The v1 fixtures were produced by the first release of the app
 * (tests/fixtures/scene-v1*.json) and must keep loading for as long as the chain starts at v1.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newDocument } from '../src/model/factory';
import { SceneFormatError } from '../src/model/errors';
import { LIMITS } from '../src/model/limits';
import {
  assertChainIntegrity,
  migrateDocument,
  MIGRATIONS,
  SCENE_VERSION,
  type Migration,
  type Raw,
} from '../src/model/migrations';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import type { BodyEntity, JointEntity } from '../src/model/types';

const fixture = (name: string): Raw =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Raw;

/** Deep-freeze so any mutation by a migration throws in strict mode. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const expectError = (fn: () => unknown, code: string, message?: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SceneFormatError);
    expect((e as SceneFormatError).code).toBe(code);
    if (message) expect((e as Error).message).toMatch(message);
    return;
  }
  throw new Error(`expected a SceneFormatError(${code})`);
};

describe('migration chain', () => {
  it('is contiguous from v1 to the current scene version', () => {
    expect(SCENE_VERSION).toBe(2);
    expect(() => assertChainIntegrity()).not.toThrow();
    expect(MIGRATIONS.map((m) => `${m.from}>${m.to}`)).toEqual(['1>2']);
    // a gap or a wrong end is detected
    expect(() => assertChainIntegrity([{ from: 2, to: 3, migrate: (d) => d }], 3)).toThrow(/broken/);
    expect(() => assertChainIntegrity(MIGRATIONS, SCENE_VERSION + 1)).toThrow(/ends at/);
  });

  it('runs every step in order for an arbitrarily long chain, without mutating its input', () => {
    const chain: Migration[] = [
      { from: 1, to: 2, migrate: (d) => ({ ...d, version: 2, trail: [...((d.trail as string[]) ?? []), '1>2'] }) },
      { from: 2, to: 3, migrate: (d) => ({ ...d, version: 3, trail: [...((d.trail as string[]) ?? []), '2>3'] }) },
      { from: 3, to: 4, migrate: (d) => ({ ...d, version: 4, trail: [...((d.trail as string[]) ?? []), '3>4'] }) },
    ];
    const input = deepFreeze({ format: 'physicslab-scene', version: 1, entities: [] });
    const out = migrateDocument(input, chain, 4);
    expect(out.version).toBe(4);
    expect(out.trail).toEqual(['1>2', '2>3', '3>4']);
    // starting part-way only applies the remaining steps
    expect(migrateDocument({ ...input, version: 3 }, chain, 4).trail).toEqual(['3>4']);
    // a chain with a missing link is a clear error, not a crash
    expectError(() => migrateDocument(input, [chain[0], chain[2]], 4), 'missing-migration', /v2/);
  });
});

describe('v1 → v2', () => {
  it('loads a scene written by the first release and upgrades it to the current version', () => {
    const v1 = fixture('scene-v1.json');
    expect(v1.version).toBe(1);
    const doc = sanitizeDocument(v1);
    expect(doc.version).toBe(SCENE_VERSION);
    expect(doc.name).toBe('Legacy kitchen sink');
    expect(doc.entities).toHaveLength((v1.entities as unknown[]).length);
    expect(doc.assets).toEqual({});
  });

  it('is lossless: every v1 value survives, only new fields are added', () => {
    const v1 = fixture('scene-v1.json');
    const doc = sanitizeDocument(v1);
    // settings the user had tuned are untouched ...
    expect(doc.settings).toMatchObject(v1.settings as object);
    expect(doc.settings.gravity).toEqual([0, -3.7, 0]);
    expect(doc.settings.physicsHz).toBe(240);
    // ... and the new ones start at the v1 behaviour
    expect(doc.settings.substeps).toBe(1);
    expect(doc.settings.seed).toBe(1);
    expect(doc.settings.bounds.enabled).toBe(false);
    expect(doc.settings.environment.fog.enabled).toBe(false);
    // every entity keeps its v1 fields (shape.sides is handled in the shape-registry tests)
    const stripSides = (e: unknown) => {
      const c = JSON.parse(JSON.stringify(e)) as { shape?: { sides?: number } };
      if (c.shape) delete c.shape.sides;
      return c;
    };
    (v1.entities as { id: string }[]).forEach((e, i) => {
      expect(doc.entities[i], `entity ${e.id}`).toMatchObject(stripSides(e));
    });
    const wheel = doc.entities.find((e) => e.kind === 'body' && e.name === 'Wheel') as BodyEntity;
    expect(wheel.lockRotation).toEqual([true, false, false]);
    const hinge = doc.entities.find((e) => e.kind === 'joint' && e.type === 'hinge') as JointEntity;
    expect(hinge.limit).toEqual({ enabled: true, min: -1, max: 1 });
  });

  it('upgrades the example car scene and gives identical results when saved and re-loaded', () => {
    const doc = sanitizeDocument(fixture('scene-v1-car.json'));
    expect(doc.version).toBe(SCENE_VERSION);
    expect(doc.entities.filter((e) => e.kind === 'joint').length).toBeGreaterThan(3);
    const again = parseDocument(serializeDocument(doc));
    expect(again).toEqual(doc);
  });

  it('treats a file without a version as v1', () => {
    const v1 = fixture('scene-v1.json');
    delete v1.version;
    expect(sanitizeDocument(v1).version).toBe(SCENE_VERSION);
  });

  it('does not mutate the document it is given', () => {
    const v1 = deepFreeze(fixture('scene-v1.json'));
    expect(() => sanitizeDocument(v1)).not.toThrow();
  });
});

describe('versions the app cannot read', () => {
  it('rejects a newer format with a message that says what to do', () => {
    const future = { ...fixture('scene-v1.json'), version: SCENE_VERSION + 1 };
    expectError(() => sanitizeDocument(future), 'too-new', /newer version of PhysicsLab/);
    expectError(() => parseDocument(JSON.stringify(future)), 'too-new', new RegExp(`v${SCENE_VERSION + 1}`));
  });

  it.each([0, -1, 1.5, 'two', null, NaN, true, [2]])('rejects the invalid version %j', (v) => {
    const bad = { ...fixture('scene-v1.json'), version: v };
    expectError(() => sanitizeDocument(JSON.parse(JSON.stringify(bad))), 'invalid-version');
  });
});

describe('garbage input', () => {
  it.each([undefined, null, 0, 42, 'text', true, [], [1, 2], {}, { format: 'nope' }, { format: 'physicslab-scene' }])(
    'rejects %j as "not a scene"',
    (v) => {
      expectError(() => sanitizeDocument(v), 'not-a-scene', /scene/i);
    },
  );

  it('rejects text that is not JSON with a friendly error', () => {
    expectError(() => parseDocument('not json'), 'invalid-json', /not valid JSON/);
    expectError(() => parseDocument(''), 'invalid-json');
    expectError(() => parseDocument('{"format":'), 'invalid-json');
  });

  it('survives hostile entity lists: wrong types, duplicates, prototype keys', () => {
    const doc = sanitizeDocument({
      format: 'physicslab-scene',
      version: 2,
      name: 42,
      entities: [
        null,
        7,
        'x',
        [],
        { kind: 'mystery' },
        { kind: 'body', id: 'a', shape: 'round' },
        { kind: 'body', id: 'a', position: [1, 2, 3] }, // duplicate id is dropped
        { kind: 'body', id: '__proto__', name: { toString: 1 } },
        { kind: 'joint', id: 'j', type: 'hinge', bodyA: 'a', bodyB: 'gone' },
      ],
      settings: 'nope',
    });
    expect(doc.name).toBe('Untitled scene');
    expect(doc.entities.map((e) => e.id)).toEqual(['a', '__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('limits', () => {
  it('rejects scenes with too many objects, naming both numbers', () => {
    const doc = newDocument('big');
    const bodies = Array.from({ length: LIMITS.maxEntities + 1 }, (_, i) => ({ kind: 'body', id: `b${i}` }));
    expectError(() => sanitizeDocument({ ...doc, entities: bodies }), 'limit', /20,001 objects.*20,000/);
    // exactly at the limit is fine
    const ok = sanitizeDocument({ ...doc, entities: bodies.slice(0, LIMITS.maxEntities) });
    expect(ok.entities).toHaveLength(LIMITS.maxEntities);
  });

  it('rejects oversized files before parsing them', () => {
    const text = ' '.repeat(LIMITS.maxDocumentChars + 1);
    expectError(() => parseDocument(text), 'limit', /MB/);
  });

  it('truncates over-long strings and clamps absurd coordinates', () => {
    const long = 'x'.repeat(10_000);
    const doc = sanitizeDocument({
      format: 'physicslab-scene',
      name: long,
      entities: [{ kind: 'body', id: long, name: long, position: [1e12, -1e12, 0], material: { color: long } }],
    });
    expect(doc.name.length).toBe(LIMITS.maxNameLength);
    const b = doc.entities[0] as BodyEntity;
    expect(b.id.length).toBe(LIMITS.maxIdLength);
    expect(b.name.length).toBe(LIMITS.maxNameLength);
    expect(b.material.color.length).toBe(LIMITS.maxStringLength);
    expect(b.position).toEqual([LIMITS.maxCoordinate, -LIMITS.maxCoordinate, 0]);
  });
});

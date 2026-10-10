/**
 * Scene format versions and the migration chain.
 *
 * Every persisted scene (file, autosave, library entry, share link) carries `version`. Loading runs the
 * document through the ordered chain `v → v+1 → … → SCENE_VERSION` *before* it is sanitised, so the
 * sanitiser only ever has to understand the current format, and files written by any older release keep
 * loading. A document from a *newer* release is rejected with a clear message instead of being half-read.
 *
 * Adding a format change:
 *   1. bump `SCENE_VERSION`;
 *   2. append `{ from: <old>, to: <new>, migrate }` to `MIGRATIONS` — `migrate` is a pure structural
 *      transform of the raw JSON (it must not mutate its input and must not depend on today's defaults:
 *      anything it leaves out is filled in by `sanitizeDocument`);
 *   3. keep a fixture of the old format in `tests/fixtures/` and extend `tests/migrations.test.ts`.
 *
 * History
 *   v1  first release. Prisms stored their side count as `shape.sides`.
 *   v2  shape parameters generalised into `shape.params` (`sides` moved there); `assets` store added;
 *       per-body collision / drag / mass-override / tag fields, compound `parts`, and the `seed`,
 *       `substeps`, `environment`, `bounds` and `units` scene settings. All additions default to the
 *       v1 behaviour, so the upgrade needs no data rewrite beyond `sides` and an empty `assets` map.
 */
import { SceneFormatError } from './errors';
import { obj } from './sanitize/primitives';

export const SCENE_FORMAT = 'physicslab-scene';
export const SCENE_VERSION = 2;

/** A raw (untrusted) document or entity: only ever read through the coercion helpers. */
export type Raw = Record<string, unknown>;

export interface Migration {
  from: number;
  to: number;
  /** Pure transform of the raw document; must not mutate `doc`. */
  migrate(doc: Raw): Raw;
}

function v1ToV2(doc: Raw): Raw {
  const entities = Array.isArray(doc.entities)
    ? (doc.entities as unknown[]).map((e) => {
        const r = obj(e);
        const shape = obj(r.shape);
        if (r.kind !== 'body' || !('sides' in shape)) return e;
        // `sides` (prism only in v1) becomes a generic shape parameter.
        const { sides, ...rest } = shape;
        const params = { ...obj(shape.params) };
        if (typeof sides === 'number' && !('sides' in params)) params.sides = sides;
        return { ...r, shape: { ...rest, params } };
      })
    : doc.entities;
  return { ...doc, version: 2, entities, assets: obj(doc.assets) };
}

/** Ordered, contiguous chain from the oldest supported version to `SCENE_VERSION`. */
export const MIGRATIONS: Migration[] = [{ from: 1, to: 2, migrate: v1ToV2 }];

/** Throws if the chain has a gap or does not end at `SCENE_VERSION` (checked by the unit tests). */
export function assertChainIntegrity(chain: readonly Migration[] = MIGRATIONS, target = SCENE_VERSION): void {
  let v = 1;
  for (const m of chain) {
    if (m.from !== v || m.to !== v + 1) throw new Error(`Migration chain broken at v${v}: found v${m.from}→v${m.to}`);
    v = m.to;
  }
  if (v !== target) throw new Error(`Migration chain ends at v${v}, expected v${target}`);
}

/**
 * Validate the envelope of an untrusted document and upgrade it to `SCENE_VERSION`.
 * Throws `SceneFormatError` with a user-facing message for garbage and for newer-than-supported files.
 */
export function migrateDocument(input: unknown, chain: readonly Migration[] = MIGRATIONS, target = SCENE_VERSION): Raw {
  if (!input || typeof input !== 'object' || Array.isArray(input) || (input as Raw).format !== SCENE_FORMAT) {
    throw new SceneFormatError('not-a-scene', 'Not a PhysicsLab scene file.');
  }
  let doc = input as Raw;
  if (!Array.isArray(doc.entities)) {
    throw new SceneFormatError('not-a-scene', 'Not a PhysicsLab scene file (it has no list of objects).');
  }
  // The first release always wrote 1; a hand-made file without a version is treated the same way.
  const found = doc.version === undefined ? 1 : doc.version;
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    throw new SceneFormatError(
      'invalid-version',
      `This scene file has an invalid format version (${JSON.stringify(found)}).`,
    );
  }
  if (found > target) {
    throw new SceneFormatError(
      'too-new',
      `This scene was saved by a newer version of PhysicsLab (scene format v${found}); this version reads up to v${target}. Reload the page to get the latest version, then open the file again.`,
    );
  }
  for (let v = found; v < target; v++) {
    const step = chain.find((m) => m.from === v);
    if (!step) {
      throw new SceneFormatError(
        'missing-migration',
        `This scene file uses an unsupported old format (v${v}) and cannot be upgraded.`,
      );
    }
    doc = step.migrate(doc);
  }
  return doc.version === target ? doc : { ...doc, version: target };
}

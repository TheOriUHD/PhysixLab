/**
 * DT-32: turns the calls a sandboxed scene script recorded into a validated `SceneDocument`.
 *
 * The worker only records `{ f, a }` calls (see dslPrelude.mjs); this module replays them on the real `Builder`
 * and then runs the result through `sanitizeDocument`, the single gate every scene passes through. Nothing the
 * script produced is trusted: argument shapes are checked here, unknown shapes / bad numbers are repaired or dropped
 * by the sanitiser, and the limits of `src/model/limits.ts` apply.
 */
import { Builder } from '../model/builder';
import { LIMITS } from '../model/limits';
import { newReport, type LoadReport } from '../model/errors';
import { sanitizeDocument } from '../model/serialize';
import type { BodyEntity, SceneDocument, SceneSettings } from '../model/types';

export interface ScriptOp {
  f: string;
  a: unknown[];
}

export interface ScriptResult {
  ops: ScriptOp[];
  name?: string | null;
  settings?: Record<string, unknown>;
}

export class ScriptError extends Error {}

export const MAX_SCRIPT_OPS = 20_000;

type Ref = { __ref: number };
const isRef = (v: unknown): v is Ref => typeof v === 'object' && v !== null && typeof (v as Ref).__ref === 'number';

export interface BuiltScene {
  doc: SceneDocument;
  report: LoadReport;
  ops: number;
}

/** Replay recorded calls. Throws `ScriptError` for a malformed recording; repairs go to `report.warnings`. */
export function buildFromOps(result: ScriptResult, fallbackName = 'Scripted scene'): BuiltScene {
  if (!result || !Array.isArray(result.ops)) throw new ScriptError('The script produced no scene');
  if (result.ops.length > MAX_SCRIPT_OPS) throw new ScriptError(`Too many calls (${result.ops.length})`);
  const b = new Builder(typeof result.name === 'string' && result.name.trim() ? result.name : fallbackName);
  const refs = new Map<number, unknown>();
  let nextRef = 0;
  const resolve = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (!isRef(v)) return v;
    if (!refs.has(v.__ref)) throw new ScriptError('A joint refers to an object that does not exist');
    return refs.get(v.__ref);
  };
  const body = (v: unknown): BodyEntity | null => {
    const r = resolve(v);
    if (r === null) return null;
    if (typeof r !== 'object' || (r as BodyEntity).kind !== 'body')
      throw new ScriptError('A joint can only connect bodies (or null for the world)');
    return r as BodyEntity;
  };
  const vec = (v: unknown, what: string): [number, number, number] => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)))
      throw new ScriptError(`${what} must be an array of three numbers`);
    return v as [number, number, number];
  };
  const str = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !v) throw new ScriptError(`${what} must be a non-empty string`);
    return v.slice(0, 120);
  };
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

  for (const op of result.ops) {
    if (!op || typeof op.f !== 'string' || !Array.isArray(op.a)) throw new ScriptError('Malformed recorded call');
    const a = op.a;
    switch (op.f) {
      case 'body':
        refs.set(
          nextRef++,
          b.body(
            str(a[0], 'body name'),
            str(a[1], 'body shape'),
            vec(a[2], 'body size'),
            vec(a[3], 'body position'),
            obj(a[4]),
          ),
        );
        break;
      case 'soft':
        refs.set(
          nextRef++,
          b.soft(str(a[0], 'soft name'), str(a[1], 'soft type') as never, vec(a[2], 'soft position'), obj(a[3])),
        );
        break;
      case 'joint':
        refs.set(
          nextRef++,
          b.joint(
            str(a[0], 'joint type') as never,
            body(a[1]),
            body(a[2]),
            vec(a[3], 'joint point'),
            vec(a[4], 'joint axis'),
            obj(a[5]),
          ),
        );
        break;
      case 'tether': {
        const type = str(a[0], 'tether type');
        if (type !== 'spring' && type !== 'rope') throw new ScriptError('tether type must be "spring" or "rope"');
        refs.set(
          nextRef++,
          b.tether(type, body(a[1]), vec(a[2], 'tether point'), body(a[3]), vec(a[4], 'tether point'), obj(a[5])),
        );
        break;
      }
      default:
        throw new ScriptError(`Unknown call "${op.f.slice(0, 30)}"`);
    }
    if (b.doc.entities.length > LIMITS.maxEntities)
      throw new ScriptError(`The scene would exceed ${LIMITS.maxEntities} objects`);
  }
  const doc = b.done();
  if (result.settings && typeof result.settings === 'object') {
    const patch = result.settings;
    const merged: Record<string, unknown> = { ...doc.settings };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in doc.settings)) throw new ScriptError(`Unknown setting "${k.slice(0, 40)}"`);
      merged[k] = v;
    }
    doc.settings = merged as unknown as SceneSettings;
  }
  const report = newReport();
  const clean = sanitizeDocument(doc, report);
  return { doc: clean, report, ops: result.ops.length };
}

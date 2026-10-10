/**
 * The component registry — every behaviour that can be attached to a body or joint is one `ComponentDef`.
 *
 * A def is the *document-side* description of a component type: id, label, icon, category, what it applies to,
 * and a declarative field schema (`FieldDef[]`) that drives three things at once — the defaults of a new
 * component, the sanitising of whatever a file or share link carries, and the inspector, which generates one
 * editor per field (number, bool, enum, vec3, colour, key, text, entity reference, path reference, curve). The
 * *runtime* half — what the component does every step in the physics worker — is registered separately in
 * `src/physics/components/registry.ts` under the same `type`.
 *
 * Adding a component = one def file under `src/model/components/` + one entry in `components/index.ts`, and one
 * runtime file under `src/physics/components/` registered in its `index.ts`. Both thread's entry modules import
 * these indexes, so the worker, the main thread and the Node tests all see the same registry.
 *
 * No dependency on three.js or Rapier: the document model stays usable from the worker, the page and tests.
 */
import { clamp, type Vec3 } from '../core/math';
import { warn, type LoadReport } from './errors';
import { uid } from './factory';
import { BUILTIN_COMPONENTS } from './components/index';
import { LIMITS } from './limits';
import { hexColor, idStr, isFiniteVec, num, obj, oneOf, str } from './sanitize/primitives';
import type { BodyEntity, ComponentParams, ComponentSpec, ComponentValue, Entity, JointEntity } from './types';
import { isBody, isJoint } from './types';

export type { ComponentParams, ComponentSpec, ComponentValue };

/** What a component can be attached to. */
export type ComponentTarget = 'body' | 'joint' | 'any';

/** Properties every field has. */
interface FieldBase {
  /** Key in `ComponentSpec.params`. */
  key: string;
  label: string;
  /** Tooltip / inline help. */
  hint?: string;
  /** Show the editor only while this holds for the component's current params (default: always). */
  showIf?: (params: ComponentParams) => boolean;
}

export interface NumberField extends FieldBase {
  kind: 'number';
  default: number;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  unit?: string;
}
export interface BoolField extends FieldBase {
  kind: 'bool';
  default: boolean;
}
export interface EnumField extends FieldBase {
  kind: 'enum';
  default: string;
  options: readonly { value: string; label: string }[];
}
export interface Vec3Field extends FieldBase {
  kind: 'vec3';
  default: Vec3;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  unit?: string;
}
export interface ColorField extends FieldBase {
  kind: 'color';
  default: string;
}
/** A `KeyboardEvent.code` ("KeyW", "Space" …), or '' for none. */
export interface KeyField extends FieldBase {
  kind: 'key';
  default: string;
}
export interface TextField extends FieldBase {
  kind: 'text';
  default: string;
  maxLength?: number;
  placeholder?: string;
}
/** The id of another entity: `filter` says which kinds the picker offers. '' = none. */
export interface EntityField extends FieldBase {
  kind: 'entity';
  default: string;
  filter?: 'body' | 'joint' | 'any';
}
/** The id of a `PathEntity`, '' = none. */
export interface PathField extends FieldBase {
  kind: 'path';
  default: string;
}
/** A piecewise-linear curve y(x): sorted [x, y] points inside the given ranges (torque curves, easing, envelopes). */
export interface CurveField extends FieldBase {
  kind: 'curve';
  default: [number, number][];
  xRange: [number, number];
  yRange: [number, number];
  xLabel?: string;
  yLabel?: string;
}

export type FieldDef =
  | NumberField
  | BoolField
  | EnumField
  | Vec3Field
  | ColorField
  | KeyField
  | TextField
  | EntityField
  | PathField
  | CurveField;

/** A value the runtime publishes through `ctx.state` and the inspector shows live. */
export interface StateLabel {
  label: string;
  unit?: string;
  digits?: number;
}

export interface ComponentDef {
  /** Registered id, stored in `ComponentSpec.type`. */
  type: string;
  label: string;
  /** Key of `src/ui/icons.ts`. */
  icon: string;
  /** Group in the Add-component menu ("Forces", "Movers" …). */
  category: string;
  /** One line for the menu and the tooltip. */
  blurb: string;
  appliesTo: ComponentTarget;
  fields: readonly FieldDef[];
  /** At most one component of this type per owner. */
  unique?: boolean;
  /** Labels of the numbers the runtime reports through `ctx.state.set([...])` (the inspector shows them live). */
  state?: readonly StateLabel[];
  /** Cross-field repair run after every field is coerced (e.g. min ≤ max). Must return the params to keep. */
  sanitise?(params: ComponentParams): ComponentParams;
  /** A warning for the inspector when the component cannot do its job on this owner (null = fine). */
  check?(owner: BodyEntity | JointEntity, params: ComponentParams): string | null;
}

// ── registry ────────────────────────────────────────────────────────────────────────────────────────

const defs = new Map<string, ComponentDef>();

const KEY_PATTERN = /^[A-Za-z0-9_]{0,32}$/;

/** Register a component type. Throws on a malformed def or a duplicate id so mistakes surface at start-up. */
export function registerComponent(def: ComponentDef): void {
  const fail = (m: string): never => {
    throw new Error(`component "${def.type}": ${m}`);
  };
  if (!def.type || !/^[A-Za-z][A-Za-z0-9_]*$/.test(def.type)) fail('type must be an identifier');
  if (defs.has(def.type)) fail('already registered');
  if (!def.label || !def.category || !def.icon) fail('label, icon and category are required');
  const keys = new Set<string>();
  for (const f of def.fields) {
    if (!f.key || keys.has(f.key)) fail(`field key "${f.key}" is empty or duplicated`);
    keys.add(f.key);
    if (!f.label) fail(`field "${f.key}" has no label`);
    switch (f.kind) {
      case 'number':
        if (!Number.isFinite(f.default)) fail(`field "${f.key}" default is not a number`);
        if (f.min !== undefined && f.max !== undefined && f.min > f.max) fail(`field "${f.key}" min > max`);
        // the default must survive its own sanitising, or a fresh component would differ from a reloaded one
        if ((f.min !== undefined && f.default < f.min) || (f.max !== undefined && f.default > f.max))
          fail(`field "${f.key}" default is outside its range`);
        break;
      case 'bool':
        if (typeof (f.default as unknown) !== 'boolean') fail(`field "${f.key}" default is not a boolean`);
        break;
      case 'enum':
        if (!f.options.length || !f.options.some((o) => o.value === f.default))
          fail(`field "${f.key}" default is not one of its options`);
        break;
      case 'vec3':
        if (!isFiniteVec(f.default, 3)) fail(`field "${f.key}" default is not a vec3`);
        if (f.default.some((v) => v < (f.min ?? -Infinity) || v > (f.max ?? Infinity)))
          fail(`field "${f.key}" default is outside its range`);
        break;
      case 'curve':
        if (f.default.length < 2) fail(`field "${f.key}" needs at least two default points`);
        if (f.xRange[0] >= f.xRange[1] || f.yRange[0] >= f.yRange[1]) fail(`field "${f.key}" has an empty range`);
        if (
          f.default.some(
            ([x, y], i) =>
              x < f.xRange[0] ||
              x > f.xRange[1] ||
              y < f.yRange[0] ||
              y > f.yRange[1] ||
              (i > 0 && x <= f.default[i - 1][0]),
          )
        )
          fail(`field "${f.key}" default points are outside the ranges or not increasing in x`);
        break;
      case 'key':
        if (!KEY_PATTERN.test(f.default)) fail(`field "${f.key}" default is not a key code`);
        break;
      case 'color':
      case 'text':
      case 'entity':
      case 'path':
        break;
    }
  }
  defs.set(def.type, def);
}

export function componentDef(type: string): ComponentDef | undefined {
  return defs.get(type);
}

export function hasComponent(type: string): boolean {
  return defs.has(type);
}

/** Every registered component, in registration order. */
export function listComponents(): ComponentDef[] {
  return [...defs.values()];
}

/** Components that can be attached to the given owner kind. */
export function componentsFor(owner: 'body' | 'joint'): ComponentDef[] {
  return listComponents().filter((d) => d.appliesTo === 'any' || d.appliesTo === owner);
}

/** Categories in first-seen order. */
export function componentCategories(owner?: 'body' | 'joint'): string[] {
  const out: string[] = [];
  for (const d of owner ? componentsFor(owner) : listComponents()) if (!out.includes(d.category)) out.push(d.category);
  return out;
}

export function ownerKind(e: BodyEntity | JointEntity): 'body' | 'joint' {
  return isBody(e) ? 'body' : 'joint';
}

// ── values ──────────────────────────────────────────────────────────────────────────────────────────

const clone = (v: ComponentValue): ComponentValue =>
  Array.isArray(v) ? (v.map((x) => (Array.isArray(x) ? [...x] : x)) as ComponentValue) : v;

/** The default params of a component type (fresh arrays every call). */
export function defaultParams(def: ComponentDef): ComponentParams {
  const out: ComponentParams = {};
  for (const f of def.fields) out[f.key] = clone(f.default);
  return out;
}

/** Coerce one raw value to what the field's kind allows (falling back to the default). Never throws. */
export function coerceField(f: FieldDef, raw: unknown): ComponentValue {
  switch (f.kind) {
    case 'number':
      return clamp(num(raw, f.default), f.min ?? -1e9, f.max ?? 1e9);
    case 'bool':
      return typeof raw === 'boolean' ? raw : f.default;
    case 'enum':
      return oneOf(
        raw,
        f.options.map((o) => o.value),
        f.default,
      );
    case 'vec3': {
      if (!isFiniteVec(raw, 3)) return [...f.default];
      const lo = f.min ?? -1e9;
      const hi = f.max ?? 1e9;
      return [clamp(raw[0], lo, hi), clamp(raw[1], lo, hi), clamp(raw[2], lo, hi)];
    }
    case 'color':
      return hexColor(raw, f.default);
    case 'key':
      return typeof raw === 'string' && KEY_PATTERN.test(raw) ? raw : f.default;
    case 'text':
      return str(raw, f.default, f.maxLength ?? LIMITS.maxStringLength);
    case 'entity':
    case 'path':
      return typeof raw === 'string' ? idStr(raw, '') : f.default;
    case 'curve':
      return coerceCurve(f, raw);
  }
}

function coerceCurve(f: CurveField, raw: unknown): number[][] {
  const pts: number[][] = [];
  if (Array.isArray(raw)) {
    for (const p of (raw as unknown[]).slice(0, LIMITS.maxCurvePoints)) {
      if (!isFiniteVec(p, 2)) continue;
      pts.push([clamp(p[0], f.xRange[0], f.xRange[1]), clamp(p[1], f.yRange[0], f.yRange[1])]);
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  // x must be strictly increasing so the curve is a function
  const out = pts.filter((p, i) => i === 0 || p[0] > pts[i - 1][0]);
  return out.length >= 2 ? out : f.default.map((p) => [...p]);
}

/** Params of a component with every field coerced and unknown keys dropped. */
export function sanitizeParams(def: ComponentDef, raw: unknown): ComponentParams {
  const r = obj(raw);
  const out: ComponentParams = {};
  for (const f of def.fields) out[f.key] = coerceField(f, r[f.key]);
  return def.sanitise ? def.sanitise(out) : out;
}

/** A new component of a registered type (ids come from `uid`, so they are unique across the scene). */
export function makeComponent(type: string, params: Partial<ComponentParams> = {}, enabled = true): ComponentSpec {
  const def = defs.get(type);
  if (!def) throw new Error(`unknown component type "${type}"`);
  return { id: uid('c'), type, enabled, params: sanitizeParams(def, { ...defaultParams(def), ...params }) };
}

/**
 * The components of one entity as read from a file: unknown types, types that do not apply to the owner,
 * a second copy of a `unique` type and anything beyond the per-entity limit are dropped with a warning; the rest
 * keep their order, with sanitised params and an id that is unique within the entity.
 */
export function sanitizeComponents(
  raw: unknown,
  target: 'body' | 'joint',
  report: LoadReport | undefined,
  owner: string,
): ComponentSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ComponentSpec[] = [];
  const ids = new Set<string>();
  for (const item of (raw as unknown[]).slice(0, LIMITS.maxComponentsPerEntity + 64)) {
    const r = obj(item);
    const type = typeof r.type === 'string' ? r.type : '';
    const def = defs.get(type);
    if (!def) {
      warn(report, `Unknown component "${str(type, '?', 40)}" on ${owner} was removed.`);
      continue;
    }
    if (def.appliesTo !== 'any' && def.appliesTo !== target) {
      warn(report, `${def.label} cannot be attached to a ${target}; it was removed from ${owner}.`);
      continue;
    }
    if (def.unique && out.some((c) => c.type === type)) {
      warn(report, `${owner} had two "${def.label}" components; only the first was kept.`);
      continue;
    }
    if (out.length >= LIMITS.maxComponentsPerEntity) {
      warn(report, `${owner} has more than ${LIMITS.maxComponentsPerEntity} components; the extra ones were removed.`);
      break;
    }
    let id = idStr(r.id, '');
    if (!id || ids.has(id)) id = uid('c');
    ids.add(id);
    out.push({
      id,
      type,
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      params: sanitizeParams(def, r.params),
    });
  }
  return out;
}

// ── references between entities ─────────────────────────────────────────────────────────────────────

/** Entities that can carry components. */
const owners = (entities: readonly Entity[]): (BodyEntity | JointEntity)[] =>
  entities.filter((e): e is BodyEntity | JointEntity => isBody(e) || isJoint(e));

/** The `[field, value]` pairs of a component that name another entity (`entity` and `path` fields). */
function refFields(c: ComponentSpec): FieldDef[] {
  const def = defs.get(c.type);
  return def ? def.fields.filter((f) => f.kind === 'entity' || f.kind === 'path') : [];
}

/** Rewrite every reference a component holds through `map` (a reference the map answers `undefined` for is cleared). */
function mapRefs(
  components: ComponentSpec[],
  map: (id: string, field: FieldDef) => string | undefined,
): ComponentSpec[] {
  let changed = false;
  const next = components.map((c) => {
    let params = c.params;
    for (const f of refFields(c)) {
      const cur = c.params[f.key];
      if (typeof cur !== 'string' || !cur) continue;
      const to = map(cur, f) ?? '';
      if (to !== cur) {
        if (params === c.params) params = { ...c.params };
        params[f.key] = to;
      }
    }
    if (params === c.params) return c;
    changed = true;
    return { ...c, params };
  });
  return changed ? next : components;
}

/**
 * Drop references to entities that do not exist (or, for a `path` field, are not paths) from every component.
 * Mutates the (freshly sanitised) entities; returns how many references were cleared.
 */
export function repairComponentRefs(entities: Entity[]): number {
  const byId = new Map(entities.map((e) => [e.id, e]));
  let cleared = 0;
  for (const o of owners(entities)) {
    if (!o.components.length) continue;
    o.components = mapRefs(o.components, (id, f) => {
      const target = byId.get(id);
      const ok = f.kind === 'path' ? target?.kind === 'path' : !!target && entityFilterOk(f, target);
      if (!ok) cleared++;
      return ok ? id : undefined;
    });
  }
  return cleared;
}

function entityFilterOk(f: FieldDef, e: Entity): boolean {
  const filter = f.kind === 'entity' ? (f.filter ?? 'body') : 'any';
  return filter === 'any' || e.kind === filter;
}

/**
 * Patches that clear references to `removed` ids from the components of the entities that stay — applied by the
 * store in the same undo step as the removal, so the document never holds a dangling reference.
 */
export function releaseComponentRefs(
  entities: Iterable<Entity>,
  removed: ReadonlySet<string>,
): [string, Partial<Entity>][] {
  const patches: [string, Partial<Entity>][] = [];
  for (const e of entities) {
    if (!(isBody(e) || isJoint(e)) || removed.has(e.id) || !e.components.length) continue;
    const next = mapRefs(e.components, (id) => (removed.has(id) ? undefined : id));
    if (next !== e.components) patches.push([e.id, { components: next }]);
  }
  return patches;
}

/**
 * The components of a clone: new ids, and references to entities that were cloned together follow the copies
 * (`map` is old id → new id). References to entities outside the clone keep pointing at the originals.
 */
export function cloneComponents(components: ComponentSpec[], map: ReadonlyMap<string, string>): ComponentSpec[] {
  const fresh = components.map((c) => ({ ...c, id: uid('c'), params: { ...c.params } }));
  return mapRefs(fresh, (id) => map.get(id) ?? id);
}

/** Make component ids unique across the whole scene (a hand-edited or merged file may repeat them). */
export function dedupeComponentIds(entities: Entity[]): number {
  const seen = new Set<string>();
  let renamed = 0;
  for (const o of owners(entities)) {
    o.components = o.components.map((c) => {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        return c;
      }
      renamed++;
      const id = uid('c');
      seen.add(id);
      return { ...c, id };
    });
  }
  return renamed;
}

for (const def of BUILTIN_COMPONENTS) registerComponent(def);

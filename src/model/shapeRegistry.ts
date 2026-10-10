/**
 * The shape registry — every primitive the app can place is one `ShapeDef` registered here.
 *
 * A `ShapeDef` is the single place that knows everything about a shape: its id, label, icon and palette
 * category, default size and how a size is normalised, the declarative parameter schema that drives the
 * inspector (and is stored in `ShapeSpec.params`), analytic volume / bounding radius / half height, the
 * convex point cloud (if it has one), the Rapier collider factory and the three.js geometry factory. The
 * model, the physics world, the renderer and the UI call the functions below and never switch on a shape id.
 *
 * Adding a shape = one new file under `src/model/shapes/` exporting a `ShapeDef` + one entry in the array
 * of `src/model/shapes/index.ts`. The physics worker has its own copy of this registry, so a shape must be
 * registered by a module the worker imports too — `shapes/index.ts` is one. A `registerShape()` call that
 * only runs on the main thread would be drawn correctly but simulated as a box (the unknown-id fallback).
 *
 * This module has no runtime dependency on three.js or Rapier — the factories receive the libraries as
 * arguments (`RapierModule`, `GeometryKit`) — so the document model stays usable from the worker, the
 * main thread and Node tests alike.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import type { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { clamp, qmul, qrot, vadd, type Quat, type Vec3 } from '../core/math';
import { LIMITS } from './limits';
import { warn, type LoadReport } from './errors';
import { MIN_DIM } from './shapes/helpers';
import { BUILTIN_SHAPES } from './shapes/index';
import { int, num, obj, vec3 } from './sanitize/primitives';
import type { ParamValue, ShapeParams, ShapeSpec } from './types';

export type { ParamValue, ShapeParams };

/** The Rapier module (`import RAPIER from '@dimforge/rapier3d-compat'`), passed in by whoever builds colliders. */
export type RapierModule = typeof RAPIER;

/**
 * The three.js constructors a geometry factory may use. Passing them in (instead of importing three here)
 * keeps three.js out of the physics worker bundle. Add a name to this list and to `render/geometryKit.ts`
 * when a new shape needs another constructor.
 */
export type GeometryKit = Pick<
  typeof THREE,
  | 'BufferGeometry'
  | 'BufferAttribute'
  | 'Float32BufferAttribute'
  | 'Vector2'
  | 'Vector3'
  | 'Matrix4'
  | 'BoxGeometry'
  | 'SphereGeometry'
  | 'CylinderGeometry'
  | 'ConeGeometry'
  | 'CapsuleGeometry'
> & { ConvexGeometry: typeof ConvexGeometry };

export type ShapeCategory = 'basic' | 'structural' | 'mechanical' | 'solids' | 'special';

export const SHAPE_CATEGORY_LABELS: Record<ShapeCategory, string> = {
  basic: 'Basic',
  structural: 'Structural',
  mechanical: 'Mechanical',
  solids: 'Solids',
  special: 'Special',
};

// -- ED-B: 'text' kind (string payloads such as the chunk's point list) --
export type ParamKind = 'int' | 'float' | 'bool' | 'enum' | 'text';

/** One entry of a shape's parameter schema. */
export interface ParamDef {
  key: string;
  label: string;
  kind: ParamKind;
  default: ParamValue;
  /** int / float only. */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** enum only: the allowed values. */
  options?: readonly { value: string; label: string }[];
  hint?: string;
  // -- ED-B: text params --
  /** text only: longest accepted string (longer input is cut). */
  maxLength?: number;
  /** Stored and sanitised like any parameter, but the inspector shows no field for it. */
  hidden?: boolean;
}

/** A labelled size axis the inspector edits for this shape. */
export interface SizeField {
  axis: 0 | 1 | 2;
  label: string;
}

/** One Rapier collider of a shape, with its pose relative to the shape's origin. */
export interface ShapeCollider {
  /** Shape only — the world adds density, friction, restitution, groups and sensor flags. */
  desc: RAPIER.ColliderDesc;
  localPos: Vec3;
  localRot: Quat;
}

// -- SH: editable derived quantities and painted surfaces (optional parts of a ShapeDef) --

/**
 * A number the inspector shows and edits that is *derived* from the size and parameters rather than stored — a
 * gear's module, a rounded box's corner radius in metres. Editing it asks the shape for the size and / or
 * parameters that realise the value, so it behaves like any other field (undo, live resize, gizmo, saving).
 */
export interface QuantityDef {
  key: string;
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Decimals shown in the field. */
  digits?: number;
  hint?: string;
  /** The current value for a (complete) spec. */
  get(spec: ShapeSpec): number;
  /** The size and / or parameters that make `get` return `value`; anything left out stays as it is. */
  set(spec: ShapeSpec, value: number): { size?: Vec3; params?: Partial<ShapeParams> };
}

/**
 * A painted surface: the renderer draws the shape with a texture produced by the painter registered under `painter`
 * (`src/render/shapeSurface.ts`), e.g. the pips and numbers of a die. The geometry's uvs address the texture.
 */
export interface ShapeSurface {
  painter: string;
  /** Texture variant for a spec (default: one texture per painter). */
  variant?(spec: ShapeSpec): string;
}

export interface ShapeDef {
  id: string;
  label: string;
  /** Key of `src/ui/icons.ts`, or an inline SVG body (a string starting with `<`). */
  icon: string;
  category: ShapeCategory;
  /** One line for the palette tooltip. */
  blurb?: string;
  defaultSize: Vec3;
  /** Parameter schema; stored in `ShapeSpec.params`. Empty for shapes without parameters. */
  params: readonly ParamDef[];
  /** Size axes the inspector shows, in order. */
  sizeFields: readonly SizeField[];
  /** The shape has a natural axle along local Y (cylinder, cone, capsule): hinges / sliders default to it. */
  axial?: boolean;

  /** Force a size into the shape's constraints (uniform axes …). `prev` is the size before the edit. */
  normalizeSize(size: Vec3, params: ShapeParams, prev?: Vec3): Vec3;
  /** Analytic volume, m³. */
  volume(spec: ShapeSpec): number;
  /** Radius of a sphere around the origin that encloses the whole shape. */
  boundingRadius(spec: ShapeSpec): number;
  /** Half height along local Y (resting a new object on the ground). */
  halfHeight(spec: ShapeSpec): number;
  /** Vertices of the convex hull, local space, if the shape is convex. */
  convexPoints?(spec: ShapeSpec): Vec3[];
  /** The colliders that make up the shape (one for primitives, several for compound shapes). */
  colliders(R: RapierModule, spec: ShapeSpec): ShapeCollider[];

  /** Key under which the renderer shares one geometry between bodies (default: id + params). */
  geometryKey?(spec: ShapeSpec): string;
  /** Scale applied to the shared geometry to realise `spec.size` (default: the size). */
  visualScale?(spec: ShapeSpec): Vec3;
  /** The geometry the renderer scales by `visualScale` (a unit-size mesh for most shapes). */
  geometry(T: GeometryKit, spec: ShapeSpec): THREE.BufferGeometry;

  // -- SH: optional extras --
  /** Extra search words for the Add tab ("cog" finds the gear). */
  keywords?: readonly string[];
  /** Derived numbers the inspector can edit besides the size and parameters. */
  quantities?: readonly QuantityDef[];
  /** A painted texture over the geometry's uvs. */
  surface?: ShapeSurface;
}

// ── registry ────────────────────────────────────────────────────────────────────────────────────────

const defs = new Map<string, ShapeDef>();

/** Id used when a document names a shape this build does not know. */
export const FALLBACK_SHAPE = 'box';

const ID_RE = /^[a-z][a-z0-9_-]*$/;

/** Throws a descriptive Error when a definition is malformed (a programming error, not user input). */
export function validateShapeDef(def: ShapeDef): void {
  const where = `shape "${def.id}"`;
  if (!ID_RE.test(def.id)) throw new Error(`Invalid shape id "${def.id}" (lowercase letters, digits, - and _ only)`);
  if (!def.label) throw new Error(`${where} needs a label`);
  if (!def.icon) throw new Error(`${where} needs an icon`);
  if (def.defaultSize.length !== 3 || !def.defaultSize.every((v) => v > 0))
    throw new Error(`${where} needs a positive default size`);
  if (!def.sizeFields.length) throw new Error(`${where} needs at least one size field`);
  // -- SH: quantity keys are unique and do not shadow a parameter --
  const qkeys = new Set<string>(def.params.map((p) => p.key));
  for (const q of def.quantities ?? []) {
    if (qkeys.has(q.key)) throw new Error(`${where} declares "${q.key}" twice (parameter or quantity)`);
    qkeys.add(q.key);
  }
  const keys = new Set<string>();
  for (const p of def.params) {
    if (keys.has(p.key)) throw new Error(`${where} declares parameter "${p.key}" twice`);
    keys.add(p.key);
    if (p.kind === 'enum') {
      if (!p.options?.length) throw new Error(`${where} parameter "${p.key}" is an enum without options`);
      if (!p.options.some((o) => o.value === p.default))
        throw new Error(`${where} parameter "${p.key}": default is not an option`);
    } else if (p.kind === 'text') {
      if (typeof p.default !== 'string') throw new Error(`${where} parameter "${p.key}": default must be a string`);
    } else if (p.kind === 'bool') {
      if (typeof p.default !== 'boolean') throw new Error(`${where} parameter "${p.key}": default must be a boolean`);
    } else {
      if (typeof p.default !== 'number') throw new Error(`${where} parameter "${p.key}": default must be a number`);
      if (p.min !== undefined && p.default < p.min) throw new Error(`${where} parameter "${p.key}": default below min`);
      if (p.max !== undefined && p.default > p.max) throw new Error(`${where} parameter "${p.key}": default above max`);
    }
  }
}

export function registerShape(def: ShapeDef): void {
  validateShapeDef(def);
  if (defs.has(def.id)) throw new Error(`Shape "${def.id}" is already registered`);
  defs.set(def.id, def);
}

export function getShape(id: string): ShapeDef | undefined {
  return defs.get(id);
}

export function hasShape(id: string): boolean {
  return defs.has(id);
}

/** All shapes in registration order (the palette order). */
export function listShapes(): readonly ShapeDef[] {
  return [...defs.values()];
}

/** The definition for `id`, or the fallback shape when the id is unknown — rendering and physics never crash. */
export function shapeDef(id: string): ShapeDef {
  return defs.get(id) ?? (defs.get(FALLBACK_SHAPE) as ShapeDef);
}

export function shapeLabel(id: string): string {
  return shapeDef(id).label;
}

// ── parameters ──────────────────────────────────────────────────────────────────────────────────────

/** Coerce one raw value to the parameter's kind and range. */
export function coerceParam(p: ParamDef, raw: unknown): ParamValue {
  switch (p.kind) {
    case 'bool':
      return typeof raw === 'boolean' ? raw : p.default;
    case 'enum':
      return typeof raw === 'string' && p.options?.some((o) => o.value === raw) ? raw : p.default;
    case 'text':
      return typeof raw === 'string' ? raw.trim().slice(0, p.maxLength ?? 1000) : p.default;
    case 'int':
      return int(raw, p.default as number, p.min ?? -Infinity, p.max ?? Infinity);
    case 'float':
      return clamp(num(raw, p.default as number), p.min ?? -Infinity, p.max ?? Infinity);
  }
}

/** Defaults for every declared parameter, or undefined for a shape without a schema. */
export function defaultParams(def: ShapeDef): ShapeParams | undefined {
  if (!def.params.length) return undefined;
  const out: ShapeParams = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

/** Every declared parameter present and in range, unknown keys dropped. Undefined without a schema. */
export function resolveParams(def: ShapeDef, raw: unknown): ShapeParams | undefined {
  if (!def.params.length) return undefined;
  const src = obj(raw);
  const out: ShapeParams = {};
  for (const p of def.params) out[p.key] = coerceParam(p, src[p.key]);
  return out;
}

/** `spec` with its params completed — a no-op (same object) when they already are. */
function resolved(def: ShapeDef, spec: ShapeSpec): ShapeSpec {
  if (!def.params.length) return spec;
  const have = spec.params;
  if (have && def.params.every((p) => p.key in have)) return spec;
  return { ...spec, params: resolveParams(def, have) };
}

// ── specs ───────────────────────────────────────────────────────────────────────────────────────────

/** Normalise a size through the shape's rules, within the global dimension limits. */
export function normalizeShapeSize(type: string, size: Vec3, params?: ShapeParams, prev?: Vec3): Vec3 {
  const def = shapeDef(type);
  const cap = (v: number) => Math.min(LIMITS.maxDimension, v);
  const s: Vec3 = [cap(size[0]), cap(size[1]), cap(size[2])];
  return def
    .normalizeSize(s, resolveParams(def, params) ?? {}, prev)
    .map((v) => clamp(v, MIN_DIM, LIMITS.maxDimension)) as Vec3;
}

/** A complete, normalised spec for a shape id: default size and parameters unless given. */
export function makeShapeSpec(type: string, size?: Vec3, params?: Partial<ShapeParams>): ShapeSpec {
  const def = shapeDef(type);
  const merged = resolveParams(def, { ...defaultParams(def), ...params });
  const spec: ShapeSpec = { type, size: normalizeShapeSize(type, size ?? def.defaultSize, merged) };
  if (merged) spec.params = merged;
  return spec;
}

/**
 * Turn an untrusted shape object into a valid `ShapeSpec`. An unknown shape id falls back to a box (with a
 * warning naming `owner`), a bad size to the shape's default, parameters are coerced per the schema.
 */
export function sanitizeShapeSpec(raw: unknown, report?: LoadReport, owner = 'an object'): ShapeSpec {
  const r = obj(raw);
  let type = typeof r.type === 'string' ? r.type : FALLBACK_SHAPE;
  if (!defs.has(type)) {
    warn(report, `Unknown shape "${String(r.type)}" on ${owner} was replaced by a box.`);
    type = FALLBACK_SHAPE;
  }
  const def = shapeDef(type);
  const params = resolveParams(def, r.params);
  const spec: ShapeSpec = { type, size: normalizeShapeSize(type, vec3(r.size, def.defaultSize), params) };
  if (params) spec.params = params;
  return spec;
}

// -- SH: derived quantities --

/** `spec` with its parameters completed and in range (the form quantities and factories expect). */
export function completeSpec(spec: ShapeSpec): ShapeSpec {
  return resolved(shapeDef(spec.type), spec);
}

/** The spec after setting a derived quantity: its new size (normalised) and parameters (coerced). */
export function applyQuantity(spec: ShapeSpec, q: QuantityDef, value: number): ShapeSpec {
  const full = completeSpec(spec);
  const def = shapeDef(spec.type);
  const patch = q.set(full, value);
  const params = patch.params ? resolveParams(def, { ...full.params, ...patch.params }) : full.params;
  const size = normalizeShapeSize(spec.type, patch.size ?? full.size, params, full.size);
  const out: ShapeSpec = { type: spec.type, size };
  if (params) out.params = params;
  return out;
}

// ── queries (always through the registry, always crash-free) ────────────────────────────────────────

export function shapeVolume(spec: ShapeSpec): number {
  const d = shapeDef(spec.type);
  return d.volume(resolved(d, spec));
}

export function shapeBoundingRadius(spec: ShapeSpec): number {
  const d = shapeDef(spec.type);
  return d.boundingRadius(resolved(d, spec));
}

export function shapeHalfHeight(spec: ShapeSpec): number {
  const d = shapeDef(spec.type);
  return d.halfHeight(resolved(d, spec));
}

export function shapeConvexPoints(spec: ShapeSpec): Vec3[] | null {
  const d = shapeDef(spec.type);
  return d.convexPoints ? d.convexPoints(resolved(d, spec)) : null;
}

export function shapeColliders(R: RapierModule, spec: ShapeSpec): ShapeCollider[] {
  const d = shapeDef(spec.type);
  return d.colliders(R, resolved(d, spec));
}

export function shapeGeometry(T: GeometryKit, spec: ShapeSpec): THREE.BufferGeometry {
  const d = shapeDef(spec.type);
  return d.geometry(T, resolved(d, spec));
}

/** Cache key of the shared geometry for this spec (bodies with equal keys share one mesh geometry). */
export function shapeGeometryKey(spec: ShapeSpec): string {
  const d = shapeDef(spec.type);
  const s = resolved(d, spec);
  if (d.geometryKey) return d.geometryKey(s);
  return s.params ? `${d.id}:${d.params.map((p) => String(s.params?.[p.key])).join(',')}` : d.id;
}

/** Scale that turns the shared geometry into the spec's actual shape. */
export function shapeVisualScale(spec: ShapeSpec): Vec3 {
  const d = shapeDef(spec.type);
  return d.visualScale ? d.visualScale(resolved(d, spec)) : spec.size;
}

/**
 * Express a collider given in a part's frame in the body's frame: the part sits at `pos` / `rot` inside the
 * body, so the collider's own local pose is rotated by `rot` and moved by `pos`.
 */
export function composeCollider(c: ShapeCollider, pos: Vec3, rot: Quat): ShapeCollider {
  return { desc: c.desc, localPos: vadd(pos, qrot(rot, c.localPos)), localRot: qmul(rot, c.localRot) };
}

// ── built-ins ───────────────────────────────────────────────────────────────────────────────────────

for (const def of BUILTIN_SHAPES) registerShape(def);

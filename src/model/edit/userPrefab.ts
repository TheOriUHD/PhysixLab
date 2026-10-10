/**
 * ED-22 — user prefabs: the pure model.
 *
 * A *prefab* is a reusable assembly the user captured from a selection: entities stored relative to an anchor (the
 * centre of the assembly in x/z, its lowest point on the ground plane y = 0), the assets they use, the parametric
 * *variables* that drive their geometry / material, named *variants* (a material / size override set) and
 * *nested* references to other user prefabs. Everything here is pure data in, data out — no DOM, no three.js, no
 * Rapier — so it is unit-tested in Node and shared by the library, the dialogs and the pack import / export.
 *
 * Instantiating never touches the stored prefab: variables and the variant are applied to a copy, the copy is
 * re-identified (`cloneEntities`), nested prefabs are expanded (cycle-safe, depth- and size-limited) and the
 * result is posed at the requested place.
 */
import { clamp, DEG, qfromAxisAngle, qmul, qnorm, qrot, vadd, type Quat, type Vec3 } from '../../core/math';
import { countAssetRefs, remapAssetRefs } from '../assets';
import { SceneFormatError } from '../errors';
import { uid } from '../factory';
import { LIMITS, formatBytes, formatCount } from '../limits';
import { MATERIAL_PRESETS, PRESET_BY_ID, materialFromPreset } from '../materials';
import { sanitizeDocument } from '../serialize';
import { hexColor, idStr, nameStr, num, obj, oneOf, position3, str } from '../sanitize/primitives';
import { normalizeShapeSize, shapeBoundingRadius, shapeConvexPoints } from '../shapeRegistry';
import { cloneEntities } from '../store';
import { SCENE_FORMAT, SCENE_VERSION } from '../migrations';
import type { Asset, BodyEntity, Entity, ShapeSpec } from '../types';
import { isBody, isJoint, isLight, isPath, isPosed, isSoft } from '../types';

// ── limits & formats ────────────────────────────────────────────────────────────────────────────────

export const PREFAB_LIMITS = {
  /** Entities one stored prefab may hold (before nested prefabs expand). */
  maxEntities: 5_000,
  maxVariables: 32,
  maxBindings: 64,
  maxVariants: 32,
  maxNested: 32,
  /** How deep prefabs may nest (a prefab inside a prefab inside …). */
  maxNestDepth: 6,
  /** Prefabs in a pack / in the library. */
  maxPrefabs: 500,
  /** Size of a pack file accepted by `importPack`, characters. */
  maxPackChars: 96 * 1024 * 1024,
  /** Thumbnail data URL length. */
  maxThumbnailChars: 96 * 1024,
  maxVariableName: 40,
} as const;

export const PACK_FORMAT = 'physicslab-prefab-pack';
export const PACK_VERSION = 1;

/** A pack that cannot be imported; the message is written for the user. */
export class PrefabPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrefabPackError';
  }
}

// ── types ───────────────────────────────────────────────────────────────────────────────────────────

export type VariableKind = 'number' | 'material' | 'color';
export type VariableValue = number | string;

/**
 * What a variable changes. `scale` (number) scales the whole assembly about its anchor when no entity is named, or
 * just that body's size when one is; `size.x|y|z` (number) sets one size axis of the named body (or of every body)
 * in metres, keeping its lowest point where it was; `material` (material) swaps the material preset; `color` (color)
 * sets the colour.
 */
export type BindProp = 'scale' | 'size.x' | 'size.y' | 'size.z' | 'material' | 'color';

export interface VariableBinding {
  prop: BindProp;
  /** Id of an entity of the prefab; omitted = every body. */
  entityId?: string;
}

export interface PrefabVariable {
  /** Unique within the prefab; it is also the key of the values map. */
  name: string;
  kind: VariableKind;
  default: VariableValue;
  min?: number;
  max?: number;
  bindings: VariableBinding[];
}

export interface VariantOverrides {
  /** Id from `MATERIAL_PRESETS` applied to every body. */
  materialPreset?: string;
  /** Colour applied to every body / soft body (after the material). */
  color?: string;
  /** Uniform scale of the whole assembly. */
  sizeScale?: number;
  variableValues?: Record<string, VariableValue>;
}

export interface PrefabVariant {
  id: string;
  name: string;
  overrides: VariantOverrides;
}

export interface NestedRef {
  id: string;
  prefabId: string;
  /** Offset from the parent prefab's anchor, metres. */
  position: Vec3;
  /** Rotation about the vertical axis, degrees. */
  yaw: number;
  variantId?: string;
  variableValues?: Record<string, VariableValue>;
}

export interface StoredPrefab {
  id: string;
  name: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  entities: Entity[];
  assets: Record<string, Asset>;
  variables: PrefabVariable[];
  variants: PrefabVariant[];
  nested: NestedRef[];
  /** `data:image/…` URL, or '' when none could be rendered. */
  thumbnail: string;
}

export interface PrefabPack {
  format: typeof PACK_FORMAT;
  version: number;
  prefabs: StoredPrefab[];
}

// ── small helpers ───────────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SIZE_AXIS: Record<string, 0 | 1 | 2> = { 'size.x': 0, 'size.y': 1, 'size.z': 2 };
const clampScale = (s: number): number => clamp(Number.isFinite(s) ? s : 1, 0.01, 100);

/** Lowest world y of a body (rotated convex hull when the shape has one, else its bounding sphere). */
function bodyBottom(b: BodyEntity): number {
  const pts = shapeConvexPoints(b.shape);
  if (!pts) return b.position[1] - shapeBoundingRadius(b.shape);
  let lo = Infinity;
  for (const p of pts) lo = Math.min(lo, b.position[1] + qrot(b.rotation, p)[1]);
  return Number.isFinite(lo) ? lo : b.position[1] - shapeBoundingRadius(b.shape);
}

/** Horizontal reach of a body about its position (bounding radius — cheap and never too small). */
const reach = (e: Entity): number => (isBody(e) ? shapeBoundingRadius(e.shape) : 0);

/** The yaw quaternion of `deg` degrees about +Y. */
export const yawQuat = (deg: number): Quat => qfromAxisAngle([0, 1, 0], deg * DEG);

function sizeOf(spec: ShapeSpec, scale: number): ShapeSpec {
  const s: Vec3 = [spec.size[0] * scale, spec.size[1] * scale, spec.size[2] * scale];
  return { ...spec, size: normalizeShapeSize(spec.type, s, spec.params, spec.size) };
}

// ── capture ─────────────────────────────────────────────────────────────────────────────────────────

export interface CaptureOptions {
  tags?: string[];
  /** Assets of the scene; the ones the captured entities use are copied into the prefab. */
  assets?: Readonly<Record<string, Asset>>;
  now?: number;
  id?: string;
}

/**
 * Capture the `selection` (with group descendants and the joints between captured bodies) of `all` as a prefab.
 * Entities get fresh ids and are moved so that the assembly is centred on x = z = 0 with its lowest point on y = 0.
 * Returns null when the selection holds nothing that can be captured.
 */
export function capturePrefab(
  all: readonly Entity[],
  selection: readonly string[],
  name: string,
  opts: CaptureOptions = {},
): StoredPrefab | null {
  const copies = cloneEntities([...all], [...selection]);
  if (!copies.length) return null;
  if (copies.length > PREFAB_LIMITS.maxEntities) {
    throw new PrefabPackError(
      `A prefab holds up to ${formatCount(PREFAB_LIMITS.maxEntities)} objects; the selection has ${formatCount(copies.length)}.`,
    );
  }
  const [dx, dy, dz] = anchorOffset(copies);
  const moved = copies.map((e) => translateRaw(e, [-dx, -dy, -dz]));
  const used = countAssetRefs(moved);
  const assets: Record<string, Asset> = {};
  for (const id of used.keys()) {
    const a = opts.assets?.[id];
    if (a) assets[id] = a;
  }
  const now = opts.now ?? Date.now();
  return {
    id: opts.id ?? uid('pf'),
    name: nameStr(name.trim(), 'Prefab') || 'Prefab',
    tags: cleanTags(opts.tags ?? []),
    createdAt: now,
    updatedAt: now,
    entities: moved,
    assets,
    variables: [],
    variants: [],
    nested: [],
    thumbnail: '',
  };
}

/** Centre (x, z) of the posed entities and the lowest point of the bodies (y). */
function anchorOffset(list: readonly Entity[]): Vec3 {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity,
    base = Infinity;
  let any = false;
  for (const e of list) {
    if (!isPosed(e)) continue;
    any = true;
    const r = reach(e);
    minX = Math.min(minX, e.position[0] - r);
    maxX = Math.max(maxX, e.position[0] + r);
    minZ = Math.min(minZ, e.position[2] - r);
    maxZ = Math.max(maxZ, e.position[2] + r);
    base = Math.min(base, isBody(e) ? bodyBottom(e) : e.position[1]);
  }
  if (!any) return [0, 0, 0];
  return [(minX + maxX) / 2, Number.isFinite(base) ? base : 0, (minZ + maxZ) / 2];
}

function translateRaw(e: Entity, d: Vec3): Entity {
  if (!isJoint(e)) return { ...e, position: vadd(e.position, d) };
  return {
    ...e,
    anchorA: e.bodyA ? e.anchorA : vadd(e.anchorA, d),
    anchorB: e.bodyB ? e.anchorB : vadd(e.anchorB, d),
  };
}

/** Pose a set of entities: rotate about the origin by `q`, then translate by `at`. Joints follow their world anchors. */
export function placeEntities(list: readonly Entity[], at: Vec3, q: Quat | undefined): Entity[] {
  const rot = !q || (q[0] === 0 && q[1] === 0 && q[2] === 0 && Math.abs(q[3] - 1) < 1e-12) ? null : qnorm(q);
  const move = (p: Vec3): Vec3 => vadd(rot ? qrot(rot, p) : p, at);
  return list.map((e): Entity => {
    if (isJoint(e)) {
      return {
        ...e,
        anchorA: e.bodyA ? e.anchorA : move(e.anchorA),
        anchorB: e.bodyB ? e.anchorB : move(e.anchorB),
        axis: rot && !e.bodyA ? qrot(rot, e.axis) : e.axis,
      };
    }
    const placed = { ...e, position: move(e.position), rotation: rot ? qmul(rot, e.rotation) : e.rotation };
    // A body's initial velocities turn with the placement (like they do for an array copy).
    if (rot && isBody(placed))
      return { ...placed, velocity: qrot(rot, placed.velocity), angularVelocity: qrot(rot, placed.angularVelocity) };
    return placed;
  });
}

// ── scaling / variables / variants ──────────────────────────────────────────────────────────────────

/** Uniformly scale one entity (positions, sizes, joint anchors and lengths) about the origin. */
function scaleEntity(e: Entity, s: number): Entity {
  const sv = (v: Vec3): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
  if (isBody(e)) {
    const out: BodyEntity = { ...e, position: sv(e.position), shape: sizeOf(e.shape, s) };
    if (e.parts) out.parts = e.parts.map((p) => ({ ...p, position: sv(p.position), shape: sizeOf(p.shape, s) }));
    if (e.comOverride) out.comOverride = sv(e.comOverride);
    if (e.massOverride !== undefined) out.massOverride = e.massOverride * s ** 3;
    return out;
  }
  if (isSoft(e)) return { ...e, position: sv(e.position), size: sv(e.size), mass: e.mass * s ** 3 };
  if (isPath(e)) return { ...e, position: sv(e.position), points: e.points.map(sv) };
  if (isLight(e)) return { ...e, position: sv(e.position), range: e.range * s };
  if (isJoint(e)) {
    return {
      ...e,
      anchorA: sv(e.anchorA),
      anchorB: sv(e.anchorB),
      ropeLength: e.ropeLength * s,
      spring: { ...e.spring, restLength: e.spring.restLength * s },
      limit: e.type === 'slider' ? { ...e.limit, min: e.limit.min * s, max: e.limit.max * s } : e.limit,
    };
  }
  return { ...e, position: sv(e.position) };
}

/** Scale the whole assembly about the anchor. `s` is clamped to 0.01 … 100. */
export function scaleEntities(list: readonly Entity[], s: number): Entity[] {
  const k = clampScale(s);
  return k === 1 ? [...list] : list.map((e) => scaleEntity(e, k));
}

function mapBodies(list: Entity[], entityId: string | undefined, fn: (b: BodyEntity) => BodyEntity): Entity[] {
  return list.map((e) => (isBody(e) && (entityId === undefined || e.id === entityId) ? fn(e) : e));
}

/** Set one size axis of a body to `value` metres, keeping its lowest point (grouped bodies keep their position). */
function withSizeAxis(b: BodyEntity, axis: 0 | 1 | 2, value: number): BodyEntity {
  const next: Vec3 = [...b.shape.size];
  next[axis] = value;
  const size = normalizeShapeSize(b.shape.type, next, b.shape.params, b.shape.size);
  const out: BodyEntity = { ...b, shape: { ...b.shape, size } };
  if (axis === 1 && b.parent === undefined) {
    // The size box grows symmetrically about the body's centre; lift the centre by half the growth.
    out.position = [b.position[0], b.position[1] + (size[1] - b.shape.size[1]) / 2, b.position[2]];
  }
  return out;
}

/** The value a variable takes: the given one when valid for its kind, else the default; numbers are clamped. */
export function resolveVariableValue(v: PrefabVariable, raw: unknown): VariableValue {
  if (v.kind === 'number') {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(v.default);
    return clamp(n, v.min ?? -LIMITS.maxDimension, v.max ?? LIMITS.maxDimension);
  }
  if (v.kind === 'material') return typeof raw === 'string' && PRESET_BY_ID.has(raw) ? raw : String(v.default);
  return typeof raw === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : String(v.default);
}

/** All values of `variables`, defaults overlaid by each layer of `layers` (later wins), validated. */
export function resolveVariableValues(
  variables: readonly PrefabVariable[],
  ...layers: (Record<string, VariableValue> | undefined)[]
): Record<string, VariableValue> {
  const out: Record<string, VariableValue> = {};
  for (const v of variables) {
    let raw: unknown = v.default;
    for (const l of layers) if (l && Object.prototype.hasOwnProperty.call(l, v.name)) raw = l[v.name];
    out[v.name] = resolveVariableValue(v, raw);
  }
  return out;
}

/** Apply every variable (in list order) to a copy of `entities`. Unknown bindings are ignored. */
export function applyVariables(
  entities: readonly Entity[],
  variables: readonly PrefabVariable[],
  values: Record<string, VariableValue>,
): Entity[] {
  let list: Entity[] = [...entities];
  for (const v of variables) {
    const value = resolveVariableValue(
      v,
      Object.prototype.hasOwnProperty.call(values, v.name) ? values[v.name] : undefined,
    );
    for (const b of v.bindings) {
      if (b.prop === 'scale' && typeof value === 'number') {
        if (b.entityId === undefined) list = scaleEntities(list, value);
        else list = mapBodies(list, b.entityId, (body) => ({ ...body, shape: sizeOf(body.shape, clampScale(value)) }));
      } else if (b.prop in SIZE_AXIS && typeof value === 'number') {
        list = mapBodies(list, b.entityId, (body) => withSizeAxis(body, SIZE_AXIS[b.prop], value));
      } else if (b.prop === 'material' && typeof value === 'string') {
        list = mapBodies(list, b.entityId, (body) => ({ ...body, material: materialFromPreset(value) }));
      } else if (b.prop === 'color' && typeof value === 'string') {
        list = list.map((e) =>
          (isBody(e) || isSoft(e)) && (b.entityId === undefined || e.id === b.entityId)
            ? isBody(e)
              ? { ...e, material: { ...e.material, color: value } }
              : { ...e, color: value }
            : e,
        );
      }
    }
  }
  return list;
}

/** Apply a variant's material / colour / scale overrides (not its variable values — see `instantiatePrefab`). */
export function applyVariant(entities: readonly Entity[], variant: PrefabVariant | undefined): Entity[] {
  let list: Entity[] = [...entities];
  const o = variant?.overrides;
  if (!o) return list;
  if (o.sizeScale !== undefined) list = scaleEntities(list, o.sizeScale);
  const preset = o.materialPreset;
  if (preset && PRESET_BY_ID.has(preset))
    list = mapBodies(list, undefined, (b) => ({ ...b, material: materialFromPreset(preset) }));
  const color = o.color;
  if (color) {
    list = list.map((e) =>
      isBody(e) ? { ...e, material: { ...e.material, color } } : isSoft(e) ? { ...e, color } : e,
    );
  }
  return list;
}

// ── instantiate ─────────────────────────────────────────────────────────────────────────────────────

export type PrefabLookup = (id: string) => StoredPrefab | undefined;

export interface InstantiateOptions {
  variantId?: string;
  variableValues?: Record<string, VariableValue>;
  /** World position of the anchor (default the origin). */
  at?: Vec3;
  rotation?: Quat;
  /** Names already used in the scene; the new entities get names unique among these and each other. */
  takenNames?: Iterable<string>;
  /** Entity budget for the whole expansion (default `LIMITS.maxEntities`). */
  maxEntities?: number;
}

export interface Instantiated {
  entities: Entity[];
  /** Assets the entities reference, under fresh ids, content-deduplicated. */
  assets: Record<string, Asset>;
  warnings: string[];
}

interface Expansion {
  entities: Entity[];
  assets: Record<string, Asset>;
  warnings: string[];
  budget: { left: number };
}

/** Would adding a nested reference from `ownerId` to `targetId` create a cycle (or exceed the depth limit)? */
export function nestingProblem(lookup: PrefabLookup, ownerId: string, targetId: string): string | null {
  if (ownerId === targetId) return 'A prefab cannot contain itself.';
  /** prefab id → the shallowest depth it was already walked at without a problem (a DAG is walked once per node). */
  const clean = new Map<string, number>();
  const walk = (id: string, depth: number, path: Set<string>): string | null => {
    const seen = clean.get(id);
    if (seen !== undefined && seen <= depth) return null;
    if (depth > PREFAB_LIMITS.maxNestDepth)
      return `Prefabs may nest at most ${PREFAB_LIMITS.maxNestDepth} levels deep.`;
    if (path.has(id)) return 'That would make the prefab contain itself.';
    const p = lookup(id);
    if (!p) return null;
    const next = new Set(path).add(id);
    for (const n of p.nested) {
      if (n.prefabId === ownerId) return 'That would make the prefab contain itself.';
      const r = walk(n.prefabId, depth + 1, next);
      if (r) return r;
    }
    clean.set(id, depth);
    return null;
  };
  return walk(targetId, 1, new Set([ownerId]));
}

function expand(
  prefab: StoredPrefab,
  lookup: PrefabLookup,
  o: { variantId?: string; variableValues?: Record<string, VariableValue> },
  ancestors: readonly string[],
  exp: Expansion,
): Entity[] {
  const variant = o.variantId ? prefab.variants.find((v) => v.id === o.variantId) : undefined;
  const values = resolveVariableValues(prefab.variables, variant?.overrides.variableValues, o.variableValues);
  let ents = applyVariables(prefab.entities, prefab.variables, values);
  ents = applyVariant(ents, variant);
  exp.budget.left -= ents.length;
  if (exp.budget.left < 0) {
    throw new PrefabPackError(
      `Inserting “${prefab.name}” would exceed the scene limit of ${formatCount(LIMITS.maxEntities)} objects.`,
    );
  }
  // Fresh ids; joints between captured bodies come along.
  const fresh = cloneEntities(
    ents,
    ents.map((e) => e.id),
  );
  // This prefab's assets under fresh ids (deduplicated by content hash across the whole expansion).
  const idMap = new Map<string, string>();
  for (const [id, a] of Object.entries(prefab.assets)) {
    const twin = Object.values(exp.assets).find((x) => x.hash === a.hash);
    if (twin) idMap.set(id, twin.id);
    else {
      const nid = uid('as');
      exp.assets[nid] = { ...a, id: nid };
      idMap.set(id, nid);
    }
  }
  const out = remapAssetRefs(fresh, (id) => idMap.get(id));
  const chain = [...ancestors, prefab.id];
  for (const ref of prefab.nested) {
    const child = lookup(ref.prefabId);
    if (!child) {
      exp.warnings.push(`A nested prefab of “${prefab.name}” no longer exists and was skipped.`);
      continue;
    }
    if (chain.includes(child.id) || chain.length >= PREFAB_LIMITS.maxNestDepth) {
      exp.warnings.push(`“${child.name}” inside “${prefab.name}” was skipped: prefabs cannot contain themselves.`);
      continue;
    }
    const inner = expand(child, lookup, { variantId: ref.variantId, variableValues: ref.variableValues }, chain, exp);
    out.push(...placeEntities(inner, ref.position, yawQuat(ref.yaw)));
  }
  return out;
}

/** Give every entity a name unique among `taken` and the entities before it ("Box", "Box 2", …). */
export function uniqueNames(list: readonly Entity[], taken: Iterable<string> = []): Entity[] {
  const used = new Set(taken);
  return list.map((e) => {
    let name = e.name;
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${e.name} ${i}`)) i++;
      name = `${e.name} ${i}`;
    }
    used.add(name);
    return name === e.name ? e : { ...e, name };
  });
}

/**
 * Fresh entities for one insertion of `prefab`: variant and variable values applied, nested prefabs expanded,
 * posed at `at` / `rotation`, uniquely named. Throws `PrefabPackError` when the result would exceed the scene limit.
 */
export function instantiatePrefab(
  prefab: StoredPrefab,
  lookup: PrefabLookup,
  opts: InstantiateOptions = {},
): Instantiated {
  const exp: Expansion = {
    entities: [],
    assets: {},
    warnings: [],
    budget: { left: opts.maxEntities ?? LIMITS.maxEntities },
  };
  const list = expand(prefab, lookup, opts, [], exp);
  const placed = placeEntities(list, opts.at ?? [0, 0, 0], opts.rotation);
  const lights = placed.filter(isLight).length;
  if (lights > LIMITS.maxLights)
    exp.warnings.push(`The prefab holds ${lights} lights; only ${LIMITS.maxLights} are kept per scene.`);
  return { entities: uniqueNames(placed, opts.takenNames), assets: exp.assets, warnings: exp.warnings };
}

// ── sanitising ──────────────────────────────────────────────────────────────────────────────────────

export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().replace(/\s+/g, ' ').slice(0, LIMITS.maxTagLength);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= LIMITS.maxTags) break;
  }
  return out;
}

const BIND_PROPS: Record<VariableKind, readonly BindProp[]> = {
  number: ['scale', 'size.x', 'size.y', 'size.z'],
  material: ['material'],
  color: ['color'],
};

function sanitizeValueMap(raw: unknown, variables: readonly PrefabVariable[]): Record<string, VariableValue> {
  const r = obj(raw);
  const out: Record<string, VariableValue> = {};
  for (const v of variables) {
    if (Object.prototype.hasOwnProperty.call(r, v.name)) out[v.name] = resolveVariableValue(v, r[v.name]);
  }
  return out;
}

function sanitizeVariables(raw: unknown, entityIds: ReadonlySet<string>): PrefabVariable[] {
  if (!Array.isArray(raw)) return [];
  const out: PrefabVariable[] = [];
  const names = new Set<string>();
  for (const r0 of raw.slice(0, PREFAB_LIMITS.maxVariables)) {
    const r = obj(r0);
    const name = str(r.name, '', PREFAB_LIMITS.maxVariableName).trim();
    if (!name || FORBIDDEN_KEYS.has(name) || names.has(name)) continue;
    const kind = oneOf<VariableKind>(r.kind, ['number', 'material', 'color'], 'number');
    const bindings: VariableBinding[] = [];
    if (Array.isArray(r.bindings)) {
      for (const b0 of r.bindings.slice(0, PREFAB_LIMITS.maxBindings)) {
        const b = obj(b0);
        const prop = oneOf<BindProp>(b.prop, BIND_PROPS[kind], BIND_PROPS[kind][0]);
        if (typeof b.prop !== 'string' || !BIND_PROPS[kind].includes(b.prop as BindProp)) continue;
        const entityId = typeof b.entityId === 'string' ? b.entityId : undefined;
        if (entityId !== undefined && !entityIds.has(entityId)) continue;
        bindings.push(entityId === undefined ? { prop } : { prop, entityId });
      }
    }
    const v: PrefabVariable = { name, kind, default: 0, bindings };
    if (kind === 'number') {
      const lo = num(r.min, NaN);
      const hi = num(r.max, NaN);
      if (Number.isFinite(lo)) v.min = clamp(lo, -LIMITS.maxDimension, LIMITS.maxDimension);
      if (Number.isFinite(hi)) v.max = clamp(hi, -LIMITS.maxDimension, LIMITS.maxDimension);
      if (v.min !== undefined && v.max !== undefined && v.min > v.max) [v.min, v.max] = [v.max, v.min];
      v.default = 1;
      v.default = resolveVariableValue(v, num(r.default, 1));
    } else if (kind === 'material') {
      v.default = typeof r.default === 'string' && PRESET_BY_ID.has(r.default) ? r.default : MATERIAL_PRESETS[0].id;
    } else {
      v.default = hexColor(r.default, '#888888');
    }
    names.add(name);
    out.push(v);
  }
  return out;
}

function sanitizeVariants(raw: unknown, variables: readonly PrefabVariable[]): PrefabVariant[] {
  if (!Array.isArray(raw)) return [];
  const out: PrefabVariant[] = [];
  const ids = new Set<string>();
  for (const r0 of raw.slice(0, PREFAB_LIMITS.maxVariants)) {
    const r = obj(r0);
    let id = idStr(r.id, '');
    if (!id || ids.has(id)) id = uid('pv');
    ids.add(id);
    const o = obj(r.overrides);
    const overrides: VariantOverrides = {};
    if (typeof o.materialPreset === 'string' && PRESET_BY_ID.has(o.materialPreset))
      overrides.materialPreset = o.materialPreset;
    if (typeof o.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(o.color)) overrides.color = o.color;
    if (typeof o.sizeScale === 'number' && Number.isFinite(o.sizeScale)) overrides.sizeScale = clampScale(o.sizeScale);
    const vv = sanitizeValueMap(o.variableValues, variables);
    if (Object.keys(vv).length) overrides.variableValues = vv;
    out.push({ id, name: nameStr(r.name, 'Variant') || 'Variant', overrides });
  }
  return out;
}

function sanitizeNested(raw: unknown): NestedRef[] {
  if (!Array.isArray(raw)) return [];
  const out: NestedRef[] = [];
  const ids = new Set<string>();
  for (const r0 of raw.slice(0, PREFAB_LIMITS.maxNested)) {
    const r = obj(r0);
    const prefabId = idStr(r.prefabId, '');
    if (!prefabId) continue;
    let id = idStr(r.id, '');
    if (!id || ids.has(id)) id = uid('pn');
    ids.add(id);
    const ref: NestedRef = {
      id,
      prefabId,
      position: position3(r.position, [0, 0, 0]),
      yaw: clamp(num(r.yaw, 0), -360, 360),
    };
    if (typeof r.variantId === 'string' && r.variantId) ref.variantId = idStr(r.variantId, '');
    // Value maps are validated against the *target* prefab's variables at insert time (resolveVariableValue).
    const vv = obj(r.variableValues);
    const kept: Record<string, VariableValue> = {};
    let n = 0;
    for (const k of Object.keys(vv)) {
      if (FORBIDDEN_KEYS.has(k) || k.length > PREFAB_LIMITS.maxVariableName || n >= PREFAB_LIMITS.maxVariables)
        continue;
      const val = vv[k];
      if (typeof val === 'number' && Number.isFinite(val)) kept[k] = val;
      else if (typeof val === 'string') kept[k] = val.slice(0, LIMITS.maxStringLength);
      else continue;
      n++;
    }
    if (n) ref.variableValues = kept;
    out.push(ref);
  }
  return out;
}

function sanitizeThumbnail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  if (raw.length > PREFAB_LIMITS.maxThumbnailChars) return '';
  return /^data:image\/(png|jpeg|webp|svg\+xml)[;,]/.test(raw) ? raw : '';
}

/**
 * Turn untrusted JSON into a valid `StoredPrefab`. Entity data goes through the scene sanitiser (so a hostile
 * pack cannot smuggle in anything a scene file could not), counts and strings are capped, bindings that point at
 * missing entities are dropped. Throws `PrefabPackError` for a prefab that cannot be repaired.
 */
export function sanitizePrefab(input: unknown): StoredPrefab {
  const r = obj(input);
  const label = typeof r.name === 'string' && r.name ? `“${r.name.slice(0, 40)}”` : 'a prefab';
  if (!Array.isArray(r.entities)) throw new PrefabPackError(`${label} has no list of objects.`);
  if (r.entities.length > PREFAB_LIMITS.maxEntities) {
    throw new PrefabPackError(
      `${label} has ${formatCount(r.entities.length)} objects; a prefab holds up to ${formatCount(PREFAB_LIMITS.maxEntities)}.`,
    );
  }
  let doc;
  try {
    doc = sanitizeDocument({
      format: SCENE_FORMAT,
      version: SCENE_VERSION,
      name: 'prefab',
      entities: r.entities,
      assets: obj(r.assets),
    });
  } catch (e) {
    if (e instanceof SceneFormatError) throw new PrefabPackError(`${label}: ${e.message}`);
    throw e;
  }
  if (!doc.entities.length) throw new PrefabPackError(`${label} holds no usable objects.`);
  const ids = new Set(doc.entities.map((e) => e.id));
  const variables = sanitizeVariables(r.variables, ids);
  const created = Math.max(0, Math.round(num(r.createdAt, Date.now())));
  return {
    id: idStr(r.id, uid('pf')),
    name: nameStr(typeof r.name === 'string' ? r.name.trim() : '', 'Prefab') || 'Prefab',
    tags: cleanTags(r.tags),
    createdAt: created,
    updatedAt: Math.max(created, Math.round(num(r.updatedAt, created))),
    entities: doc.entities,
    assets: doc.assets,
    variables,
    variants: sanitizeVariants(r.variants, variables),
    nested: sanitizeNested(r.nested),
    thumbnail: sanitizeThumbnail(r.thumbnail),
  };
}

// ── packs ───────────────────────────────────────────────────────────────────────────────────────────

/** The JSON text of a prefab pack (what "Export pack" downloads). */
export function exportPack(prefabs: readonly StoredPrefab[], indent?: number): string {
  const pack: PrefabPack = { format: PACK_FORMAT, version: PACK_VERSION, prefabs: [...prefabs] };
  return JSON.stringify(pack, null, indent);
}

export interface ImportedPack {
  prefabs: StoredPrefab[];
  warnings: string[];
}

/**
 * Parse and fully sanitise a pack. Whole-file problems (not JSON, wrong format, newer version, too large, too
 * many prefabs) throw a `PrefabPackError` with a message for the user; a single bad prefab is skipped with a
 * warning, and an error is thrown if none survives. Ids are kept (the library decides how to resolve clashes).
 */
export function importPack(text: string): ImportedPack {
  if (typeof text !== 'string' || text.length > PREFAB_LIMITS.maxPackChars) {
    throw new PrefabPackError(
      `This file is larger than ${formatBytes(PREFAB_LIMITS.maxPackChars)}, the biggest prefab pack PhysicsLab opens.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PrefabPackError('This file is not valid JSON, so it cannot be a prefab pack.');
  }
  const r = obj(raw);
  if (r.format !== PACK_FORMAT) {
    throw new PrefabPackError(
      r.format === SCENE_FORMAT
        ? 'This is a scene file, not a prefab pack. Open it with File → Import, or select objects and save them as a prefab.'
        : 'This is not a PhysicsLab prefab pack.',
    );
  }
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) {
    throw new PrefabPackError('This prefab pack has an invalid format version.');
  }
  if (r.version > PACK_VERSION) {
    throw new PrefabPackError(
      `This pack was saved by a newer version of PhysicsLab (pack format v${r.version}); this version reads up to v${PACK_VERSION}. Reload the page to get the latest version.`,
    );
  }
  if (!Array.isArray(r.prefabs)) throw new PrefabPackError('This prefab pack has no list of prefabs.');
  if (r.prefabs.length > PREFAB_LIMITS.maxPrefabs) {
    throw new PrefabPackError(
      `This pack has ${formatCount(r.prefabs.length)} prefabs; PhysicsLab imports up to ${formatCount(PREFAB_LIMITS.maxPrefabs)} at a time.`,
    );
  }
  const prefabs: StoredPrefab[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const p of r.prefabs) {
    try {
      const s = sanitizePrefab(p);
      if (seen.has(s.id)) s.id = uid('pf');
      seen.add(s.id);
      prefabs.push(s);
    } catch (e) {
      if (!(e instanceof PrefabPackError)) throw e;
      warnings.push(`Skipped: ${e.message}`);
    }
  }
  if (!prefabs.length) {
    throw new PrefabPackError(
      warnings[0]?.replace(/^Skipped: /, '') ?? 'This prefab pack does not contain any prefab.',
    );
  }
  return { prefabs, warnings };
}

/**
 * Pack import with identity resolution: prefabs whose id already exists get a fresh id (and nested references
 * inside the imported set follow), so importing never overwrites a library prefab silently.
 */
export function reidentifyImported(prefabs: readonly StoredPrefab[], taken: ReadonlySet<string>): StoredPrefab[] {
  const map = new Map<string, string>();
  for (const p of prefabs) if (taken.has(p.id)) map.set(p.id, uid('pf'));
  return prefabs.map((p) => ({
    ...p,
    id: map.get(p.id) ?? p.id,
    nested: p.nested.map((n) => (map.has(n.prefabId) ? { ...n, prefabId: map.get(n.prefabId)! } : n)),
  }));
}

// ── update from scene ───────────────────────────────────────────────────────────────────────────────

/**
 * Carry a prefab's variables over to freshly captured entities: a binding that named an old entity follows the
 * entity of the same name and kind in `next` (the first unused one); a binding whose entity has no counterpart is
 * dropped. Bindings to "every body" are kept as they are.
 */
export function rebindVariables(
  prev: readonly Entity[],
  next: readonly Entity[],
  variables: readonly PrefabVariable[],
): PrefabVariable[] {
  const byId = new Map(prev.map((e) => [e.id, e]));
  const taken = new Set<string>();
  const target = new Map<string, string | null>();
  const resolve = (oldId: string): string | null => {
    if (target.has(oldId)) return target.get(oldId)!;
    const old = byId.get(oldId);
    const hit = old ? next.find((e) => e.kind === old.kind && e.name === old.name && !taken.has(e.id)) : undefined;
    if (hit) taken.add(hit.id);
    target.set(oldId, hit?.id ?? null);
    return hit?.id ?? null;
  };
  return variables.map((v) => ({
    ...v,
    bindings: v.bindings.flatMap((b): VariableBinding[] => {
      if (b.entityId === undefined) return [b];
      const id = resolve(b.entityId);
      return id ? [{ ...b, entityId: id }] : [];
    }),
  }));
}

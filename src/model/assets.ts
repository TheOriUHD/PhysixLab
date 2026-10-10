/**
 * The asset store's pure API: building assets from typed arrays, decoding them again, reference tracking and
 * garbage collection. `SceneStore` (undo, events) and the document sanitiser are built on these functions.
 *
 * Assets live once in `doc.assets` and entities reference them by id (today: `BodyEntity.meshId`; a package
 * adding another referrer registers an `AssetRefHandler`). Identical content is stored once (de-duplicated by
 * content hash). Assets nothing references are kept while editing — undo may bring a reference back — and are
 * dropped when the scene is saved (`pruneAssets`).
 */
import type { Vec3 } from '../core/math';
import { decodeBytes, decodeF32, decodeU32, encodeBytes, encodeF32, encodeU32 } from './assets/codec';
import { SceneFormatError } from './errors';
import { uid } from './factory';
import { LIMITS, formatBytes } from './limits';
import { validateAsset } from './sanitize/assets';
import type {
  Asset,
  AssetInput,
  AssetKind,
  AudioAsset,
  BlobAsset,
  Entity,
  HeightmapAsset,
  MeshAsset,
  MeshGroup,
  MeshMaterialSlot,
  SceneDocument,
  TextureAsset,
} from './types';
import { isBody } from './types';

// ── reference tracking ──────────────────────────────────────────────────────────────────────────────

/** One reference an entity holds on an asset, with the kind it requires. */
export interface AssetRef {
  id: string;
  kind: AssetKind;
}

/**
 * Teaches the asset store about one kind of referrer. `refs` lists what an entity references; `remap` returns
 * the entity with every reference passed through `fn(id, requiredKind)` (`undefined` drops the reference), or
 * null if nothing changed. The store uses them to count references, clear them when an asset is removed, merge duplicates on
 * load and drop dangling ones.
 */
export interface AssetRefHandler {
  refs(e: Entity): readonly AssetRef[];
  remap(e: Entity, fn: (id: string, kind: AssetKind) => string | undefined): Entity | null;
}

const handlers: AssetRefHandler[] = [
  {
    // a body's visual mesh
    refs: (e) => (isBody(e) && e.meshId ? [{ id: e.meshId, kind: 'mesh' }] : []),
    remap: (e, fn) => {
      if (!isBody(e) || !e.meshId) return null;
      const next = fn(e.meshId, 'mesh');
      if (next === e.meshId) return null;
      const { meshId: _old, ...rest } = e;
      return next === undefined ? rest : { ...rest, meshId: next };
    },
  },
];

export function registerAssetRefs(handler: AssetRefHandler): void {
  handlers.push(handler);
}

export function entityAssetRefs(e: Entity): AssetRef[] {
  return handlers.flatMap((h) => h.refs(e));
}

/** How many references each asset id has among `entities`. */
export function countAssetRefs(entities: Iterable<Entity>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entities) for (const r of entityAssetRefs(e)) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  return counts;
}

/** The entities with every asset reference passed through `fn`; entities that do not change keep their identity. */
export function remapAssetRefs(
  entities: readonly Entity[],
  fn: (id: string, kind: AssetKind) => string | undefined,
): Entity[] {
  return entities.map((e) => {
    let cur = e;
    for (const h of handlers) cur = h.remap(cur, fn) ?? cur;
    return cur;
  });
}

/** The document without assets nothing references — what is written to a file, an autosave or a share link. */
export function pruneAssets(doc: SceneDocument): SceneDocument {
  const ids = Object.keys(doc.assets);
  if (ids.length === 0) return doc;
  const used = countAssetRefs(doc.entities);
  if (ids.every((id) => used.has(id))) return doc;
  const assets: Record<string, Asset> = {};
  for (const id of ids) if (used.has(id)) assets[id] = doc.assets[id];
  return { ...doc, assets };
}

export function totalAssetBytes(assets: Readonly<Record<string, Asset>>): number {
  let n = 0;
  for (const a of Object.values(assets)) n += a.bytes;
  return n;
}

/** Independent copy of an asset map (strings are immutable; the small arrays are copied). */
export function cloneAssets(assets: Readonly<Record<string, Asset>>): Record<string, Asset> {
  return JSON.parse(JSON.stringify(assets)) as Record<string, Asset>;
}

// ── adding ──────────────────────────────────────────────────────────────────────────────────────────

/** Validate typed input into a complete asset (id, hash and size computed). Throws `SceneFormatError`. */
export function buildAsset(input: AssetInput, id: string): Asset {
  const res = validateAsset(input, id);
  if ('problem' in res) {
    throw new SceneFormatError('asset', `The asset “${input.name || 'Asset'}” cannot be used: ${res.problem}.`);
  }
  return res.asset;
}

/**
 * The asset map with `input` added, plus its id. Identical content that is already stored is not added again:
 * the existing id comes back and `added` is false. Throws `SceneFormatError` for a damaged or over-size asset
 * and when the scene's asset budget (count, total bytes) would be exceeded.
 */
export function addAssetTo(
  assets: Readonly<Record<string, Asset>>,
  input: AssetInput,
): { assets: Record<string, Asset>; id: string; added: boolean } {
  const built = buildAsset(input, uid('as'));
  for (const a of Object.values(assets))
    if (a.hash === built.hash) return { assets: { ...assets }, id: a.id, added: false };
  if (Object.keys(assets).length >= LIMITS.maxAssets) {
    throw new SceneFormatError(
      'limit',
      `This scene already has ${LIMITS.maxAssets} assets, the most PhysicsLab keeps. Remove one first.`,
    );
  }
  const total = totalAssetBytes(assets) + built.bytes;
  if (total > LIMITS.maxTotalAssetBytes) {
    throw new SceneFormatError(
      'limit',
      `Adding “${built.name}” would bring the scene's assets to ${formatBytes(total)}; the limit is ${formatBytes(LIMITS.maxTotalAssetBytes)}. Remove an unused asset first.`,
    );
  }
  return { assets: { ...assets, [built.id]: built }, id: built.id, added: true };
}

// ── building assets from typed arrays ───────────────────────────────────────────────────────────────

export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array | readonly number[];
  /** Three vertex indices per triangle. */
  indices: Uint32Array | Uint16Array | readonly number[];
  normals?: Float32Array | readonly number[];
  uvs?: Float32Array | readonly number[];
  materials?: MeshMaterialSlot[];
  groups?: MeshGroup[];
}

const f32 = (a: Float32Array | readonly number[]): Float32Array =>
  a instanceof Float32Array ? a : Float32Array.from(a);
const u32 = (a: Uint32Array | Uint16Array | readonly number[]): Uint32Array =>
  a instanceof Uint32Array ? a : Uint32Array.from(a);

export function makeMeshAsset(name: string, d: MeshData): AssetInput {
  const positions = f32(d.positions);
  const indices = u32(d.indices);
  return {
    kind: 'mesh',
    name,
    vertexCount: positions.length / 3,
    indexCount: indices.length,
    positions: encodeF32(positions),
    indices: encodeU32(indices),
    ...(d.normals ? { normals: encodeF32(f32(d.normals)) } : {}),
    ...(d.uvs ? { uvs: encodeF32(f32(d.uvs)) } : {}),
    ...(d.materials ? { materials: d.materials } : {}),
    ...(d.groups ? { groups: d.groups } : {}),
  };
}

export function makeTextureAsset(name: string, dataUrl: string, width: number, height: number): AssetInput {
  return { kind: 'texture', name, dataUrl, width, height };
}

/** `heights` are width × height samples in 0–1, row-major along x. */
export function makeHeightmapAsset(
  name: string,
  width: number,
  height: number,
  heights: Float32Array | readonly number[],
  scale: Vec3,
): AssetInput {
  return { kind: 'heightmap', name, width, height, heights: encodeF32(f32(heights)), scale: [...scale] as Vec3 };
}

/** Interleaved samples in −1…1. */
export function makeAudioAsset(
  name: string,
  sampleRate: number,
  channels: number,
  samples: Float32Array | readonly number[],
): AssetInput {
  return { kind: 'audio', name, sampleRate, channels, samples: encodeF32(f32(samples)) };
}

export function makeBlobAsset(name: string, mime: string, bytes: Uint8Array): AssetInput {
  return { kind: 'blob', name, mime, data: encodeBytes(bytes) };
}

// ── decoding ────────────────────────────────────────────────────────────────────────────────────────

const decoded = new WeakMap<Asset, unknown>();

/** Decode once per asset object (assets are immutable, so the result can be shared). */
function memo<T>(a: Asset, make: () => T): T {
  let v = decoded.get(a) as T | undefined;
  if (v === undefined) {
    v = make();
    decoded.set(a, v);
  }
  return v;
}

export interface DecodedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
}

export function decodeMesh(a: MeshAsset): DecodedMesh {
  return memo(a, () => ({
    positions: decodeF32(a.positions),
    indices: decodeU32(a.indices),
    ...(a.normals ? { normals: decodeF32(a.normals) } : {}),
    ...(a.uvs ? { uvs: decodeF32(a.uvs) } : {}),
  }));
}

export const decodeHeightmap = (a: HeightmapAsset): Float32Array => memo(a, () => decodeF32(a.heights));
export const decodeAudio = (a: AudioAsset): Float32Array => memo(a, () => decodeF32(a.samples));
export const decodeBlob = (a: BlobAsset): Uint8Array => memo(a, () => decodeBytes(a.data));
export const textureSource = (a: TextureAsset): string => a.dataUrl;

/**
 * Validation of asset payloads — shared by the document sanitiser (untrusted JSON from files, autosave and
 * share links) and `SceneStore.addAsset` (typed input that can still be wrong). Everything about an asset that
 * is *derived* (`bytes`, `hash`, element counts) is recomputed here and never trusted from the input.
 *
 * Oversized assets are rejected with a `SceneFormatError` (the user can act on that); damaged ones — bad
 * base64, impossible counts, indices outside the vertex range, non-finite numbers — are reported as a
 * problem string so the caller can drop just that asset and carry on loading.
 */
import { clamp, type Vec3 } from '../../core/math';
import { base64ByteLength, contentHash, decodeF32, decodeU32 } from '../assets/codec';
import { SceneFormatError, warn, type LoadReport } from '../errors';
import { LIMITS, formatBytes } from '../limits';
import type { Asset, AssetKind, MeshGroup, MeshMaterialSlot } from '../types';
import { hexColor, idStr, int, isFiniteVec, nameStr, num, obj, oneOf } from './primitives';

export const ASSET_KINDS: readonly AssetKind[] = ['mesh', 'texture', 'heightmap', 'audio', 'blob'];

const TEXTURE_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const MIME = /^[A-Za-z0-9][\w.+-]{0,60}\/[A-Za-z0-9][\w.+-]{0,60}$/;
const MAX_MATERIAL_SLOTS = 64;

export type AssetResult = { asset: Asset } | { problem: string };

const fail = (problem: string): AssetResult => ({ problem });

/** Byte length of a base64 payload field, or -1. */
const size = (v: unknown): number => (typeof v === 'string' ? base64ByteLength(v) : -1);

function allFinite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

function sanitizeSlots(raw: unknown): MeshMaterialSlot[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return (raw as unknown[]).slice(0, MAX_MATERIAL_SLOTS).map((m, i) => {
    const r = obj(m);
    return {
      name: nameStr(r.name, `Material ${i + 1}`),
      color: hexColor(r.color, '#cccccc'),
      metalness: clamp(num(r.metalness, 0), 0, 1),
      roughness: clamp(num(r.roughness, 0.6), 0, 1),
      opacity: clamp(num(r.opacity, 1), 0.05, 1),
    };
  });
}

function sanitizeGroups(raw: unknown, indexCount: number, slots: number): MeshGroup[] | undefined {
  if (!Array.isArray(raw) || slots === 0) return undefined;
  const out: MeshGroup[] = [];
  for (const g of (raw as unknown[]).slice(0, 4096)) {
    const r = obj(g);
    // a group is a run of whole triangles
    const start = int(r.start, 0, 0, indexCount);
    const first = start - (start % 3);
    const asked = int(r.count, 0, 0, indexCount);
    const count = Math.min(asked - (asked % 3), indexCount - first);
    if (count > 0) out.push({ start: first, count, materialIndex: int(r.materialIndex, 0, 0, slots - 1) });
  }
  return out.length ? out : undefined;
}

/** Throws the friendly size error; `name` is the asset's display name. */
function checkSize(name: string, bytes: number): void {
  if (bytes > LIMITS.maxAssetBytes) {
    throw new SceneFormatError(
      'limit',
      `The asset “${name}” is ${formatBytes(bytes)}; PhysixLab stores assets of up to ${formatBytes(LIMITS.maxAssetBytes)} each. Use a smaller or simplified file.`,
    );
  }
}

/**
 * Validate one raw asset and return it with `id`, `bytes` and `hash` filled in.
 * @throws SceneFormatError when the payload exceeds the per-asset size cap.
 */
export function validateAsset(raw: unknown, id: string): AssetResult {
  const r = obj(raw);
  if (!ASSET_KINDS.includes(r.kind as AssetKind)) return fail('it has an unknown kind');
  const kind = oneOf<AssetKind>(r.kind, ASSET_KINDS, 'blob');
  const name = nameStr(r.name, 'Asset');
  const base = { id, name };

  switch (kind) {
    case 'mesh': {
      const pb = size(r.positions),
        ib = size(r.indices);
      if (pb < 0 || ib < 0) return fail('its vertex or index data is not valid base64');
      const nb = r.normals === undefined ? 0 : size(r.normals);
      const ub = r.uvs === undefined ? 0 : size(r.uvs);
      checkSize(name, pb + ib + Math.max(0, nb) + Math.max(0, ub));
      if (pb === 0 || pb % 12) return fail('its positions are not a whole number of xyz vertices');
      const vertexCount = pb / 12;
      if (vertexCount > LIMITS.maxMeshVertices) {
        throw new SceneFormatError(
          'limit',
          `The mesh “${name}” has ${vertexCount.toLocaleString('en-US')} vertices; the limit is ${LIMITS.maxMeshVertices.toLocaleString('en-US')}. Simplify it first.`,
        );
      }
      if (ib === 0 || ib % 12) return fail('its indices are not a whole number of triangles');
      const indexCount = ib / 4;
      try {
        const positions = decodeF32(r.positions as string);
        if (!allFinite(positions)) return fail('its positions contain NaN or infinite values');
        const indices = decodeU32(r.indices as string);
        for (let i = 0; i < indices.length; i++) {
          if (indices[i] >= vertexCount) return fail('a triangle refers to a vertex that does not exist');
        }
      } catch {
        return fail('its data could not be decoded');
      }
      // optional attributes must match the vertex count, otherwise they are dropped (the mesh is still usable)
      const normals = nb === pb && typeof r.normals === 'string' ? r.normals : undefined;
      const uvs = ub === vertexCount * 8 && typeof r.uvs === 'string' ? r.uvs : undefined;
      const materials = sanitizeSlots(r.materials);
      const groups = materials ? sanitizeGroups(r.groups, indexCount, materials.length) : undefined;
      const asset: Asset = {
        ...base,
        kind: 'mesh',
        vertexCount,
        indexCount,
        positions: r.positions as string,
        indices: r.indices as string,
        ...(normals ? { normals } : {}),
        ...(uvs ? { uvs } : {}),
        ...(materials ? { materials } : {}),
        ...(groups ? { groups } : {}),
        hash: '',
        bytes: pb + ib + (normals ? nb : 0) + (uvs ? ub : 0),
      };
      asset.hash = contentHash([
        'mesh',
        asset.positions,
        asset.indices,
        asset.normals ?? '',
        asset.uvs ?? '',
        JSON.stringify(materials ?? null),
        JSON.stringify(groups ?? null),
      ]);
      return { asset };
    }
    case 'texture': {
      const url = typeof r.dataUrl === 'string' ? TEXTURE_URL.exec(r.dataUrl) : null;
      if (!url) return fail('it is not a PNG, JPEG, WebP or GIF data URL');
      const bytes = size(url[2]);
      if (bytes < 0) return fail('its image data is not valid base64');
      checkSize(name, bytes);
      const asset: Asset = {
        ...base,
        kind: 'texture',
        dataUrl: r.dataUrl as string,
        width: int(r.width, 1, 1, 16384),
        height: int(r.height, 1, 1, 16384),
        hash: '',
        bytes,
      };
      asset.hash = contentHash(['texture', asset.dataUrl]);
      return { asset };
    }
    case 'heightmap': {
      const w = int(r.width, 0, 0, LIMITS.maxHeightmapSide + 1);
      const h = int(r.height, 0, 0, LIMITS.maxHeightmapSide + 1);
      if (w < 2 || h < 2 || w > LIMITS.maxHeightmapSide || h > LIMITS.maxHeightmapSide) {
        return fail(`its size must be between 2 and ${LIMITS.maxHeightmapSide} samples per side`);
      }
      const bytes = size(r.heights);
      if (bytes < 0) return fail('its height data is not valid base64');
      checkSize(name, bytes);
      if (bytes !== w * h * 4) return fail('its height data does not match its width × height');
      try {
        if (!allFinite(decodeF32(r.heights as string))) return fail('its heights contain NaN or infinite values');
      } catch {
        return fail('its data could not be decoded');
      }
      const s = isFiniteVec(r.scale, 3) ? (r.scale as Vec3) : ([10, 2, 10] as Vec3);
      const scale: Vec3 = [clamp(s[0], 1e-3, 1e5), clamp(s[1], 1e-3, 1e5), clamp(s[2], 1e-3, 1e5)];
      const asset: Asset = {
        ...base,
        kind: 'heightmap',
        width: w,
        height: h,
        heights: r.heights as string,
        scale,
        hash: '',
        bytes,
      };
      asset.hash = contentHash(['heightmap', String(w), String(h), asset.heights, scale.join(',')]);
      return { asset };
    }
    case 'audio': {
      const channels = int(r.channels, 1, 1, 8);
      const sampleRate = int(r.sampleRate, 44100, 3000, 384000);
      const bytes = size(r.samples);
      if (bytes < 0) return fail('its sample data is not valid base64');
      checkSize(name, bytes);
      if (bytes === 0 || bytes % (4 * channels)) return fail('its samples are not a whole number of frames');
      try {
        if (!allFinite(decodeF32(r.samples as string))) return fail('its samples contain NaN or infinite values');
      } catch {
        return fail('its data could not be decoded');
      }
      const asset: Asset = {
        ...base,
        kind: 'audio',
        sampleRate,
        channels,
        samples: r.samples as string,
        hash: '',
        bytes,
      };
      asset.hash = contentHash(['audio', String(sampleRate), String(channels), asset.samples]);
      return { asset };
    }
    case 'blob': {
      const bytes = size(r.data);
      if (bytes < 0) return fail('its data is not valid base64');
      checkSize(name, bytes);
      const mime = typeof r.mime === 'string' && MIME.test(r.mime) ? r.mime : 'application/octet-stream';
      const asset: Asset = { ...base, kind: 'blob', mime, data: r.data as string, hash: '', bytes };
      asset.hash = contentHash(['blob', mime, asset.data]);
      return { asset };
    }
  }
}

const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Sanitise the `assets` map of a document: every asset validated and re-hashed, damaged ones dropped with a
 * warning, identical content merged (the returned `remap` maps each merged id to the one that was kept, so the
 * references to it can be repaired), and the count / total-size caps enforced.
 * @throws SceneFormatError when a cap is exceeded.
 */
export function sanitizeAssetMap(
  raw: unknown,
  report?: LoadReport,
): { assets: Record<string, Asset>; remap: Map<string, string> } {
  const r = obj(raw);
  const ids = Object.keys(r);
  if (ids.length > LIMITS.maxAssets) {
    throw new SceneFormatError(
      'limit',
      `This scene has ${ids.length.toLocaleString('en-US')} assets; PhysixLab opens scenes with up to ${LIMITS.maxAssets}.`,
    );
  }
  const assets: Record<string, Asset> = {};
  const byHash = new Map<string, Asset>();
  const remap = new Map<string, string>();
  let total = 0;
  for (const key of ids) {
    const id = idStr(key, '');
    if (!id || FORBIDDEN_IDS.has(id) || id in assets) continue;
    const res = validateAsset(r[key], id);
    if ('problem' in res) {
      warn(report, `The asset “${nameStr(obj(r[key]).name, id)}” was removed: ${res.problem}.`);
      continue;
    }
    const a = res.asset;
    const twin = byHash.get(a.hash);
    if (twin) {
      remap.set(id, twin.id);
      continue;
    }
    total += a.bytes;
    if (total > LIMITS.maxTotalAssetBytes) {
      throw new SceneFormatError(
        'limit',
        `This scene's assets add up to more than ${formatBytes(LIMITS.maxTotalAssetBytes)}, the most PhysixLab opens. Remove unused assets or use smaller files.`,
      );
    }
    byHash.set(a.hash, a);
    assets[id] = a;
  }
  return { assets, remap };
}

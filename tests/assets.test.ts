/**
 * The asset store (FB-4): typed-array payloads as base64 in `doc.assets`, de-duplicated by content hash,
 * reference-counted and garbage-collected on save, undoable through `SceneStore`, validated and size-capped by
 * the sanitiser.
 */
import { describe, expect, it } from 'vitest';
import {
  addAssetTo,
  cloneAssets,
  countAssetRefs,
  decodeAudio,
  decodeBlob,
  decodeHeightmap,
  decodeMesh,
  makeAudioAsset,
  makeBlobAsset,
  makeHeightmapAsset,
  makeMeshAsset,
  makeTextureAsset,
  pruneAssets,
  registerAssetRefs,
  totalAssetBytes,
} from '../src/model/assets';
import {
  base64ByteLength,
  contentHash,
  decodeBytes,
  decodeF32,
  decodeU32,
  encodeBytes,
  encodeF32,
  encodeU32,
  isBase64,
} from '../src/model/assets/codec';
import { SceneFormatError, newReport } from '../src/model/errors';
import { createBody, newDocument } from '../src/model/factory';
import { LIMITS } from '../src/model/limits';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { SceneStore, type SceneChange } from '../src/model/store';
import type { Asset, AssetInput, BodyEntity, Entity, MeshAsset, SceneDocument } from '../src/model/types';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────

const TRIANGLE = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};
const triangle = (name = 'Triangle', shift = 0): AssetInput =>
  makeMeshAsset(name, {
    positions: TRIANGLE.positions.map((v, i) => (i === 0 ? v + shift : v)),
    indices: TRIANGLE.indices,
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
  });
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const bodyWith = (meshId?: string, over: Partial<BodyEntity> = {}) =>
  createBody({ shape: { type: 'box' }, ...(meshId ? { meshId } : {}), ...over });

const raw = (assets: unknown, entities: unknown[] = []) => ({
  format: 'physicslab-scene',
  version: 2,
  entities,
  assets,
});

const expectLimit = (fn: () => unknown, message: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SceneFormatError);
    expect((e as SceneFormatError).code).toBe('limit');
    expect((e as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected a limit error');
};

// ── codec ─────────────────────────────────────────────────────────────────────────────────────────────

describe('base64 codec and content hash', () => {
  it('round-trips bytes, floats and integers exactly, including a large array', () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
    expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes);
    const floats = Float32Array.from({ length: 3 * 100_000 }, (_, i) => Math.sin(i) * 1e3);
    expect(decodeF32(encodeF32(floats))).toEqual(floats);
    const ints = Uint32Array.from({ length: 5000 }, (_, i) => i * 4_000_003);
    expect(decodeU32(encodeU32(ints))).toEqual(ints);
    expect(decodeF32(encodeF32(new Float32Array(0)))).toHaveLength(0);
    // a subarray view encodes only its own bytes
    expect(decodeF32(encodeF32(floats.subarray(3, 6)))).toEqual(floats.slice(3, 6));
  });

  it('knows how big a payload is without decoding it, and what is not base64', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 1001]) {
      const s = encodeBytes(new Uint8Array(n));
      expect(base64ByteLength(s), `${n} bytes`).toBe(n);
      expect(isBase64(s)).toBe(true);
    }
    for (const bad of ['a', 'abc', 'ab!d', 'AAA=A', 'AA==AAAA', '====', 'é', ' AAAA']) {
      expect(base64ByteLength(bad), bad).toBe(-1);
    }
    expect(() => decodeF32(encodeBytes(new Uint8Array(5)))).toThrow(/32-bit floats/);
  });

  it('hashes equal content equally and different content differently (golden value pinned)', () => {
    expect(contentHash(['a', 'b'])).toBe(contentHash(['a', 'b']));
    expect(contentHash(['ab', 'c'])).not.toBe(contentHash(['a', 'bc']));
    expect(contentHash(['x'])).not.toBe(contentHash(['y']));
    expect(contentHash([''])).toHaveLength(32);
    // changing the algorithm would orphan every stored hash: pin one value
    expect(contentHash(['physicslab'])).toBe('eca24206a458839969ee433ebfa27e82');
    expect(contentHash(['mesh', 'AAAA', 'x'])).toBe('d2353c309b74e774adb4c3b67b3aa940');
  });
});

// ── building and decoding ─────────────────────────────────────────────────────────────────────────────

describe('asset constructors and decoders', () => {
  it('a mesh keeps its arrays, counts and optional attributes through add → get → decode', () => {
    const store = new SceneStore();
    const id = store.addAsset(triangle('My mesh'));
    const a = store.getAsset(id) as MeshAsset;
    expect(a).toMatchObject({ id, kind: 'mesh', name: 'My mesh', vertexCount: 3, indexCount: 3 });
    expect(a.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(a.bytes).toBe(36 + 12 + 36 + 24);
    const m = decodeMesh(a);
    expect(m.positions).toEqual(TRIANGLE.positions);
    expect(m.indices).toEqual(TRIANGLE.indices);
    expect(m.normals).toEqual(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));
    expect(m.uvs).toEqual(new Float32Array([0, 0, 1, 0, 0, 1]));
    expect(decodeMesh(a)).toBe(m); // decoded once per asset
    // plain arrays and 16-bit indices are accepted
    const plain = makeMeshAsset('p', { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Uint16Array([0, 1, 2]) });
    expect(decodeMesh(store.getAsset(store.addAsset(plain)) as MeshAsset).indices).toEqual(new Uint32Array([0, 1, 2]));
  });

  it('textures, heightmaps, audio and blobs round-trip', () => {
    const store = new SceneStore();
    const tex = store.getAsset(store.addAsset(makeTextureAsset('Pixel', PNG, 1, 1)))!;
    expect(tex).toMatchObject({ kind: 'texture', width: 1, height: 1, dataUrl: PNG });
    expect(tex.bytes).toBe(base64ByteLength(PNG.split(',')[1]));

    const heights = Float32Array.from({ length: 4 * 3 }, (_, i) => i / 12);
    const hm = store.getAsset(store.addAsset(makeHeightmapAsset('Hills', 4, 3, heights, [40, 5, 30])));
    expect(hm).toMatchObject({ kind: 'heightmap', width: 4, height: 3, scale: [40, 5, 30] });
    expect(decodeHeightmap(hm as Extract<Asset, { kind: 'heightmap' }>)).toEqual(heights);

    const samples = Float32Array.from({ length: 200 }, (_, i) => Math.sin(i / 7));
    const au = store.getAsset(store.addAsset(makeAudioAsset('Ping', 22050, 2, samples)));
    expect(au).toMatchObject({ kind: 'audio', sampleRate: 22050, channels: 2 });
    expect(decodeAudio(au as Extract<Asset, { kind: 'audio' }>)).toEqual(samples);

    const bytes = Uint8Array.from([1, 2, 3, 250, 255]);
    const bl = store.getAsset(store.addAsset(makeBlobAsset('Data', 'application/octet-stream', bytes)));
    expect(bl).toMatchObject({ kind: 'blob', mime: 'application/octet-stream', bytes: 5 });
    expect(decodeBlob(bl as Extract<Asset, { kind: 'blob' }>)).toEqual(bytes);
    expect(store.assets).toBeDefined();
    expect(totalAssetBytes(store.assets)).toBe(Object.values(store.assets).reduce((n, a) => n + a.bytes, 0));
  });

  it('refuses damaged input with a message that names the asset and the problem', () => {
    const store = new SceneStore();
    const bad = (input: AssetInput, msg: RegExp) => {
      try {
        store.addAsset(input);
      } catch (e) {
        expect(e).toBeInstanceOf(SceneFormatError);
        expect((e as SceneFormatError).code).toBe('asset');
        expect((e as Error).message).toMatch(msg);
        return;
      }
      throw new Error('expected an error');
    };
    bad(
      { ...triangle('Broken'), indices: encodeU32(new Uint32Array([0, 1, 7])) } as AssetInput,
      /“Broken”.*vertex that does not exist/,
    );
    bad({ ...triangle('Odd'), positions: encodeF32(new Float32Array(4)) } as AssetInput, /whole number of xyz/);
    bad(makeMeshAsset('NaN', { positions: [0, 0, NaN, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }), /NaN/);
    bad(makeTextureAsset('Svg', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 1, 1), /PNG, JPEG, WebP or GIF/);
    bad(makeTextureAsset('Script', 'javascript:alert(1)', 1, 1), /data URL/);
    bad(makeHeightmapAsset('Flat', 4, 4, new Float32Array(5), [1, 1, 1]), /width × height/);
    bad(makeAudioAsset('Cut', 44100, 2, new Float32Array(3)), /whole number of frames/);
    expect(Object.keys(store.assets)).toHaveLength(0);
    expect(store.canUndo).toBe(false); // failed adds leave no history
  });
});

// ── the store: dedupe, undo, references ───────────────────────────────────────────────────────────────

describe('SceneStore asset API', () => {
  it('stores identical content once (different names) and keeps different content apart', () => {
    const store = new SceneStore();
    const a = store.addAsset(triangle('First'));
    const undoDepth = store.canUndo;
    const again = store.addAsset(triangle('Second name'));
    expect(again).toBe(a);
    expect(Object.keys(store.assets)).toEqual([a]);
    expect(store.getAsset(a)!.name).toBe('First');
    expect(undoDepth).toBe(true);
    store.undo();
    expect(store.canUndo).toBe(false); // the duplicate added no extra undo step
    const b = store.addAsset(triangle('First'));
    const c = store.addAsset(triangle('Shifted', 5));
    expect(c).not.toBe(b);
    expect(Object.keys(store.assets)).toHaveLength(2);
  });

  it('adds and removes participate in undo / redo and emit change events', () => {
    const store = new SceneStore();
    const events: SceneChange[] = [];
    store.on('change', (c) => events.push(c));
    const id = store.addAsset(triangle());
    expect(events.at(-1)).toEqual({ type: 'assets', ids: [id] });
    expect(store.revision).toBeGreaterThan(0);
    expect(store.undo()).toBe('Add asset');
    expect(store.getAsset(id)).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: 'assets', ids: [id] });
    expect(store.redo()).toBe('Add asset');
    expect(store.getAsset(id)).toBeDefined();
    expect(store.removeAsset(id, 'Delete mesh')).toBe(true);
    expect(store.getAsset(id)).toBeUndefined();
    expect(store.removeAsset(id)).toBe(false);
    expect(store.undo()).toBe('Delete mesh');
    expect(store.getAsset(id)).toBeDefined();
    expect(store.toDocument().assets[id]).toBe(store.getAsset(id));
  });

  it('removing an asset clears the references to it, in one undo step that restores both', () => {
    const store = new SceneStore();
    const id = store.addAsset(triangle());
    const a = bodyWith(id),
      b = bodyWith(id),
      c = bodyWith();
    store.add([a, b, c]);
    expect(store.assetRefCount(id)).toBe(2);
    const updates: SceneChange[] = [];
    store.on('change', (ch) => ch.type === 'update' && updates.push(ch));
    store.removeAsset(id);
    expect(store.body(a.id)!.meshId).toBeUndefined();
    expect('meshId' in store.body(a.id)!).toBe(false);
    expect(store.body(c.id)).toBe(c); // untouched entities keep their identity
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ type: 'update', keys: new Set(['meshId']) });
    store.undo();
    expect(store.body(a.id)!.meshId).toBe(id);
    expect(store.body(b.id)!.meshId).toBe(id);
    expect(store.getAsset(id)).toBeDefined();
    expect(store.assetRefCount(id)).toBe(2);
  });

  it('groups with other edits in a batch, so "import model" is a single undo step', () => {
    const store = new SceneStore();
    store.begin('Import model');
    const id = store.addAsset(triangle());
    store.add([bodyWith(id)]);
    store.end();
    expect(store.size).toBe(1);
    store.undo();
    expect(store.size).toBe(0);
    expect(Object.keys(store.assets)).toHaveLength(0);
    store.redo();
    expect(store.size).toBe(1);
    expect(store.getAsset(id)).toBeDefined();
  });

  it('counts references, lists unused assets, and survives load()', () => {
    const store = new SceneStore();
    const used = store.addAsset(triangle('used'));
    const spare = store.addAsset(triangle('spare', 9));
    store.add([bodyWith(used), bodyWith(used)]);
    expect(store.assetRefCount(used)).toBe(2);
    expect(store.assetRefCount(spare)).toBe(0);
    expect(store.unusedAssets()).toEqual([spare]);
    // duplicating bodies adds references to the shared asset instead of copying it
    store.duplicate([store.bodies()[0].id]);
    expect(store.assetRefCount(used)).toBe(3);
    expect(Object.keys(store.assets)).toHaveLength(2);
    const doc = store.toDocument();
    const other = new SceneStore();
    other.load(doc);
    expect(other.getAsset(used)).toBe(doc.assets[used]);
    expect(other.canUndo).toBe(false);
    other.clear();
    expect(Object.keys(other.assets)).toHaveLength(0);
  });

  it('enforces the size caps with friendly errors and leaves the store untouched', () => {
    const store = new SceneStore();
    const big = (n: number, tag: number): AssetInput => {
      const bytes = new Uint8Array(n);
      bytes[0] = tag; // distinct content, so nothing is de-duplicated
      return makeBlobAsset(`Blob ${tag}`, 'application/octet-stream', bytes);
    };
    // one asset over the per-asset limit
    expectLimit(() => store.addAsset(big(LIMITS.maxAssetBytes + 1, 1)), /“Blob 1” is 16 MB.*up to 16 MB each/);
    expect(store.canUndo).toBe(false);
    // the scene-wide byte budget
    for (let i = 0; i < 4; i++) store.addAsset(big(LIMITS.maxAssetBytes, i + 10));
    expectLimit(() => store.addAsset(big(1000, 99)), /would bring the scene's assets to 64 MB.*limit is 64 MB/);
    expect(Object.keys(store.assets)).toHaveLength(4);
    // the asset-count budget
    const many = new SceneStore();
    for (let i = 0; i < LIMITS.maxAssets; i++)
      many.addAsset(makeBlobAsset(`b${i}`, 'text/plain', Uint8Array.of(i & 255, i >> 8)));
    expectLimit(
      () => many.addAsset(makeBlobAsset('one more', 'text/plain', Uint8Array.of(7, 7, 7))),
      /already has 256 assets/,
    );
  });
});

// ── save: garbage collection, dedupe, round trip ──────────────────────────────────────────────────────

describe('saving and loading assets', () => {
  const sceneWith = () => {
    const store = new SceneStore();
    const used = store.addAsset(triangle('used'));
    const spare = store.addAsset(triangle('spare', 9));
    const tex = store.addAsset(makeTextureAsset('Pixel', PNG, 1, 1));
    store.add([bodyWith(used)]);
    return { store, used, spare, tex };
  };

  it('writes only referenced assets (garbage collection on save); the live store keeps the rest for undo', () => {
    const { store, used, spare, tex } = sceneWith();
    const json = JSON.parse(serializeDocument(store.toDocument())) as SceneDocument;
    expect(Object.keys(json.assets)).toEqual([used]);
    expect(Object.keys(store.assets).sort()).toEqual([used, spare, tex].sort());
    expect(pruneAssets(store.toDocument()).assets).not.toBe(store.assets);
    // a document that references everything is returned as is
    const lean = pruneAssets(json);
    expect(lean).toBe(json);
    // pretty printing (the export) keeps the same content
    expect(JSON.parse(serializeDocument(store.toDocument(), 1))).toEqual(json);
  });

  it('round-trips a scene with assets losslessly; ids, hashes, sizes and payloads survive', () => {
    const { store, used } = sceneWith();
    const doc = parseDocument(serializeDocument(store.toDocument()));
    expect(doc.assets[used]).toEqual(store.assets[used]);
    expect((doc.entities[0] as BodyEntity).meshId).toBe(used);
    expect(decodeMesh(doc.assets[used] as MeshAsset).positions).toEqual(TRIANGLE.positions);
    // loading, saving again is a fixed point
    expect(serializeDocument(doc)).toBe(serializeDocument(store.toDocument()));
  });

  it('recomputes derived fields instead of trusting the file', () => {
    const { store, used } = sceneWith();
    const doc = JSON.parse(serializeDocument(store.toDocument())) as {
      assets: Record<string, Record<string, unknown>>;
    };
    Object.assign(doc.assets[used], { hash: 'forged', bytes: 1, vertexCount: 999, indexCount: 5, id: 'other' });
    const back = sanitizeDocument(doc);
    expect(back.assets[used]).toEqual(store.assets[used]);
  });

  it('merges identical assets stored under two ids and repoints the references', () => {
    const { store, used } = sceneWith();
    const doc = JSON.parse(serializeDocument(store.toDocument())) as {
      assets: Record<string, unknown>;
      entities: Record<string, unknown>[];
    };
    doc.assets['copy'] = { ...(doc.assets[used] as object), name: 'copy' };
    doc.entities.push({ kind: 'body', id: 'second', meshId: 'copy' });
    const back = sanitizeDocument(doc);
    expect(Object.keys(back.assets)).toEqual([used]);
    expect(back.entities.map((e) => (e as BodyEntity).meshId)).toEqual([used, used]);
  });

  it('drops damaged assets and dangling or wrong-kind references with warnings, keeping everything else', () => {
    const { store, used, tex } = sceneWith();
    const doc = JSON.parse(serializeDocument(store.toDocument())) as {
      assets: Record<string, Record<string, unknown>>;
      entities: Record<string, unknown>[];
    };
    doc.assets[tex] = JSON.parse(JSON.stringify(store.assets[tex])) as Record<string, unknown>;
    doc.assets['badb64'] = { kind: 'blob', name: 'Rotten', mime: 'text/plain', data: '!!!not base64!!!' };
    doc.assets['junk'] = 'hello' as unknown as Record<string, unknown>;
    doc.assets['kindless'] = { name: 'x' };
    doc.assets['outofrange'] = {
      ...(doc.assets[used] as object),
      indices: encodeU32(new Uint32Array([0, 1, 9])),
      name: 'Out of range',
    };
    doc.assets['__proto__'] = { ...(doc.assets[used] as object), name: 'evil' };
    doc.entities.push(
      { kind: 'body', id: 'dangling', meshId: 'nowhere' },
      { kind: 'body', id: 'wrongkind', meshId: tex },
      { kind: 'body', id: 'rotten', meshId: 'badb64' },
    );
    const report = newReport();
    const back = sanitizeDocument(doc, report);
    const mesh = (id: string) => (back.entities.find((e) => e.id === id) as BodyEntity).meshId;
    expect(mesh('dangling')).toBeUndefined();
    expect(mesh('wrongkind')).toBeUndefined();
    expect(mesh('rotten')).toBeUndefined();
    expect(back.entities.find((e) => e.kind === 'body' && e.meshId === used)).toBeDefined();
    expect(Object.keys(back.assets)).toEqual([used]); // the texture is unreferenced now, so it was collected
    expect({}.hasOwnProperty.call(back.assets, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(back.assets)).toBe(Object.prototype);
    const w = report.warnings.join('\n');
    expect(w).toMatch(/“Rotten” was removed: its data is not valid base64/);
    expect(w).toMatch(/“Out of range” was removed: a triangle refers to a vertex that does not exist/);
    expect(w).toMatch(/“x” was removed|kind/);
    expect(w).toMatch(/reference\(s\) to missing or unusable assets were removed/);
  });

  it('drops mismatched optional attributes but keeps the mesh, sanitises material slots and groups', () => {
    const doc = raw(
      {
        m: {
          ...triangle('Slots'),
          normals: encodeF32(new Float32Array(5)),
          uvs: encodeF32(new Float32Array(2)),
          materials: [{ name: 7, color: 'nope', metalness: 5, roughness: -1, opacity: 0 }, 'junk'],
          groups: [{ start: 1, count: 100, materialIndex: 9 }, { start: 0, count: 2, materialIndex: 0 }, null],
        },
      },
      [{ kind: 'body', id: 'a', meshId: 'm' }],
    );
    const a = sanitizeDocument(doc).assets['m'] as MeshAsset;
    expect(a.normals).toBeUndefined();
    expect(a.uvs).toBeUndefined();
    expect(a.materials).toEqual([
      { name: 'Material 1', color: '#cccccc', metalness: 1, roughness: 0, opacity: 0.05 },
      { name: 'Material 2', color: '#cccccc', metalness: 0, roughness: 0.6, opacity: 1 },
    ]);
    // groups are runs of whole triangles clamped to the mesh: {1, 100} snaps to {0, 3}, {0, 2} has no whole triangle
    expect(a.groups).toEqual([{ start: 0, count: 3, materialIndex: 1 }]);
    expect(a.bytes).toBe(36 + 12);
  });

  it('rejects scenes whose assets exceed the caps, with messages that say what to do', () => {
    const blob = (n: number, tag: string) => ({
      kind: 'blob',
      name: tag,
      mime: 'text/plain',
      data: tag + 'A'.repeat(n),
    });
    // per-asset: 16 MiB + a bit of base64
    const over = 'A'.repeat(Math.ceil((LIMITS.maxAssetBytes + 1) / 3) * 4);
    expectLimit(
      () => sanitizeDocument(raw({ big: { kind: 'blob', name: 'Huge', data: over } })),
      /“Huge” is 16 MB.*up to 16 MB each/,
    );
    // total: five 16 MiB assets (distinct content)
    const sixteen = (tag: string) => tag + 'A'.repeat(Math.floor(LIMITS.maxAssetBytes / 3) * 4 - 4);
    const assets: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++)
      assets[`a${i}`] = { kind: 'blob', name: `A${i}`, data: sixteen(String.fromCharCode(66 + i).repeat(4)) };
    expectLimit(() => sanitizeDocument(raw(assets)), /add up to more than 64 MB/);
    // count
    const many: Record<string, unknown> = {};
    for (let i = 0; i <= LIMITS.maxAssets; i++) many[`b${i}`] = blob(0, 'AAAA');
    expectLimit(() => sanitizeDocument(raw(many)), /257 assets.*up to 256/);
  });

  it('keeps v1 scenes asset-free and tolerates a missing or garbage assets field', () => {
    expect(sanitizeDocument(raw(undefined)).assets).toEqual({});
    expect(sanitizeDocument(raw('lots')).assets).toEqual({});
    expect(sanitizeDocument(raw([1, 2, 3])).assets).toEqual({});
    expect(newDocument('n').assets).toEqual({});
  });
});

// ── references and clones ─────────────────────────────────────────────────────────────────────────────

describe('reference handlers and clones', () => {
  it('a package can register another kind of referrer and the store counts, unlinks and collects it', () => {
    interface Skinned extends BodyEntity {
      skinId?: string;
    }
    registerAssetRefs({
      refs: (e: Entity) =>
        (e as Skinned).skinId ? [{ id: (e as Skinned).skinId as string, kind: 'texture' as const }] : [],
      remap: (e, fn) => {
        const s = e as Skinned;
        if (!s.skinId) return null;
        const next = fn(s.skinId, 'texture');
        if (next === s.skinId) return null;
        const { skinId: _old, ...rest } = s;
        return (next === undefined ? rest : { ...rest, skinId: next }) as Entity;
      },
    });
    const store = new SceneStore();
    const tex = store.addAsset(makeTextureAsset('Skin', PNG, 1, 1));
    const skinned: Skinned = { ...bodyWith(), skinId: tex };
    store.add([skinned]);
    expect(store.assetRefCount(tex)).toBe(1);
    expect(countAssetRefs(store.all()).get(tex)).toBe(1);
    const saved = JSON.parse(serializeDocument(store.toDocument())) as { assets: object };
    expect(Object.keys(saved.assets)).toEqual([tex]);
    store.removeAsset(tex);
    expect((store.get(skinned.id) as Skinned).skinId).toBeUndefined();
    store.undo();
    expect((store.get(skinned.id) as Skinned).skinId).toBe(tex);
    // dangling references of the new kind are repaired on load too
    const doc = JSON.parse(serializeDocument(store.toDocument())) as { entities: Record<string, unknown>[] };
    doc.entities[0].skinId = 'gone';
    expect(sanitizeDocument(doc).entities[0]).not.toHaveProperty('skinId'); // sanitiser rebuilds entities, so unknown fields never survive
  });

  it('cloneAssets gives an independent copy', () => {
    const store = new SceneStore();
    const id = store.addAsset(
      makeMeshAsset('m', {
        positions: TRIANGLE.positions,
        indices: TRIANGLE.indices,
        materials: [{ name: 'a', color: '#fff', metalness: 0, roughness: 1, opacity: 1 }],
      }),
    );
    const copy = cloneAssets(store.assets);
    expect(copy).toEqual(store.assets);
    expect(copy[id]).not.toBe(store.assets[id]);
    (copy[id] as MeshAsset).materials![0].name = 'changed';
    expect((store.assets[id] as MeshAsset).materials![0].name).toBe('a');
  });

  it('addAssetTo is pure: the input map is never mutated', () => {
    const base = {} as Record<string, Asset>;
    const res = addAssetTo(base, triangle());
    expect(Object.keys(base)).toHaveLength(0);
    expect(res.added).toBe(true);
    expect(addAssetTo(res.assets, triangle('same content')).added).toBe(false);
  });
});

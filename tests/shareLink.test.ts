import { describe, expect, it } from 'vitest';
import { listMaps, listTemplates } from '../src/model/content';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { canonicalText, expectedAfterRoundTrip } from '../src/app/share/compact';
import { buildShare, encodeV1, encodeV2, parseShareHash } from '../src/app/share/link';
import { decodeBinary, encodeBinary, quantize, type Json } from '../src/app/share/binary';
import type { SceneDocument } from '../src/model/types';

const scenes: [string, SceneDocument][] = [
  ...listTemplates().map((t): [string, SceneDocument] => [t.name, t.build()]),
  ...listMaps().map((m): [string, SceneDocument] => [`map ${m.name}`, m.build()]),
];
// What the app shares: the sanitised, serialised document.
const prep = (d: SceneDocument) => parseDocument(serializeDocument(d));

describe('binary codec', () => {
  it('round-trips values; numbers keep 6 significant digits, integers stay exact', () => {
    const v: Json = {
      a: [1, -2, 0.1 + 0.2, 123456789012, 1e-9, -3.14159265358979, 1e21],
      s: 'héllo ✓',
      n: null,
      t: true,
      f: false,
      o: { deep: [{ x: 1.5 }] },
      b: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v',
    };
    expect(decodeBinary(encodeBinary(v))).toEqual(quantize(v));
  });
  it('rejects damaged input without throwing anything but Error', () => {
    const good = encodeBinary({ a: [1, 2, 3], b: 'x' });
    for (let cut = 0; cut < good.length; cut++) {
      try {
        decodeBinary(good.subarray(0, cut));
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });
});

describe('share link v2 (DT-20)', () => {
  const rows: string[] = [];
  for (const [name, raw] of scenes) {
    it(`${name}: round-trips and is >= 40 % shorter than v1`, async () => {
      const doc = prep(raw);
      const r = await buildShare(doc, 'https://x.test/');
      expect(r.format).toBe('v2');
      const back = await parseShareHash(new URL(r.url).hash);
      expect(back).not.toBeNull();
      // equal to the document up to the 7-digit quantisation and the renaming of entity ids to e0, e1 …
      expect(canonicalText(back)).toBe(
        canonicalText(sanitizeDocument(JSON.parse(canonicalText(expectedAfterRoundTrip(doc))))),
      );
      const saving = 1 - r.chars / r.v1Chars;
      rows.push(`${name}: v1 ${r.v1Chars} -> v2 ${r.chars} (${(saving * 100).toFixed(0)} %)`);
      process.stderr.write(rows[rows.length - 1] + '\n');
      expect(saving, rows[rows.length - 1]).toBeGreaterThanOrEqual(0.4);
    });
  }
  it('still opens v1 links', async () => {
    const doc = prep(scenes[0][1]);
    const back = await parseShareHash(`#scene=${await encodeV1(doc)}`);
    expect(back?.entities.length).toBe(doc.entities.length);
  });
  it('reports damaged links with a readable error', async () => {
    await expect(parseShareHash('#s=AAAA')).rejects.toThrow(/damaged/);
    const v2 = await encodeV2(prep(scenes[0][1]));
    await expect(parseShareHash(`#s=${v2.slice(0, 40)}`)).rejects.toThrow(/damaged/);
    expect(await parseShareHash('#nothing')).toBeNull();
  });
});

describe('share link v2 with assets', () => {
  it('stores base64 asset payloads as bytes and restores them exactly', async () => {
    const { SceneStore } = await import('../src/model/store');
    const { makeMeshAsset } = await import('../src/model/assets');
    const { createBody } = await import('../src/model/factory');
    const store = new SceneStore();
    const positions = Float32Array.from({ length: 900 }, (_, i) => Math.sin(i * 0.37) * 3 + (i % 7));
    const indices = Uint32Array.from({ length: 300 }, (_, i) => i % 300);
    const id = store.addAsset(makeMeshAsset('m', { positions, indices }));
    store.add([createBody({ shape: { type: 'box' }, meshId: id })], 'x');
    const doc = prep(store.toDocument());
    const r = await buildShare(doc, 'https://x.test/');
    expect(r.format).toBe('v2');
    const back = await parseShareHash(new URL(r.url).hash);
    expect(Object.values(back!.assets)[0]).toMatchObject({ kind: 'mesh', vertexCount: 300 });
    expect(Object.values(back!.assets)[0]).toEqual(Object.values(doc.assets)[0]);
    expect(r.chars).toBeLessThan(r.v1Chars);
  });
});

/** Regression tests for the DT-A code review (deflate bomb, fail-closed origin, migration safety, CSV formulas …). */
import { describe, expect, it } from 'vitest';
import { deflate, inflate, MAX_INFLATED_BYTES, toBase64Url } from '../src/app/share/compact';
import { parseShareHash } from '../src/app/share/link';
import { readEmbedOptions } from '../src/app/embed/options';
import { originAllowed } from '../src/app/embed/protocol';
import { MemoryBackend } from '../src/app/storage';
import { LS_AUTOSAVE_KEY, migrateLocalStorage } from '../src/app/storage/migrate';
import { toCSV } from '../src/app/export/dataExport';
import { FolderSync, type DirHandleLike } from '../src/app/storage/folderSync';
import { newDocument } from '../src/model/factory';

describe('review fixes', () => {
  it('inflate refuses output beyond the cap (deflate bomb)', async () => {
    const bomb = await deflate(new Uint8Array(MAX_INFLATED_BYTES + 1024 * 1024)); // zeros: a few kB compressed
    expect(bomb.length).toBeLessThan(100_000);
    await expect(inflate(bomb)).rejects.toThrow(/too large/);
    const ok = await deflate(new Uint8Array(1000).fill(7));
    expect((await inflate(ok)).length).toBe(1000);
  });

  it('a share link as a bomb is reported as damaged, and an absurdly long hash is refused before decoding', async () => {
    const bomb = await deflate(new Uint8Array(MAX_INFLATED_BYTES + 1024 * 1024));
    await expect(parseShareHash(`#scene=${toBase64Url(bomb)}`)).rejects.toThrow(/damaged/);
    await expect(parseShareHash(`#s=${'A'.repeat(400_000)}`)).rejects.toThrow(/too long/);
  });

  it('embed origin= fails closed when nothing in it is valid', () => {
    for (const bad of ['example.com', '*', 'null', 'file:///x']) {
      const o = readEmbedOptions(`?embed=1&origin=${encodeURIComponent(bad)}`)!;
      expect(o.origins.length, bad).toBeGreaterThan(0);
      expect(originAllowed('https://evil.test', o.origins), bad).toBe(false);
      expect(originAllowed('null', o.origins), bad).toBe(false);
    }
    const good = readEmbedOptions('?embed=1&origin=https://a.example')!;
    expect(originAllowed('https://a.example', good.origins)).toBe(true);
    expect(readEmbedOptions('?embed=1')!.origins).toEqual([]); // no parameter: open to any parent (documented)
  });

  it('migration never deletes localStorage data when the backend is volatile', async () => {
    const data: Record<string, string> = { [LS_AUTOSAVE_KEY]: '{"v":1}' };
    const ls = { getItem: (k: string) => data[k] ?? null, removeItem: (k: string) => void delete data[k] };
    class Volatile extends MemoryBackend {}
    const r = await migrateLocalStorage(new Volatile(), ls);
    expect(r.ran).toBe(false);
    expect(data[LS_AUTOSAVE_KEY]).toBe('{"v":1}');
  });

  it('CSV neutralises spreadsheet formulas in text cells but leaves numbers alone', () => {
    const csv = toCSV({
      name: 'x',
      columns: [{ key: 'a', label: 'a' }],
      rows: [['=HYPERLINK("http://x")'], ['+1+1'], ['@SUM(A1)'], ['-2+3'], [-5], ['plain']],
    });
    const lines = csv.trim().split('\r\n').slice(1);
    expect(lines[0].startsWith('"\'=')).toBe(true);
    expect(lines[1]).toBe("'+1+1");
    expect(lines[2]).toBe("'@SUM(A1)");
    expect(lines[3]).toBe("'-2+3");
    expect(lines[4]).toBe('-5');
    expect(lines[5]).toBe('plain');
  });

  it('folder sync: a reported-but-undecided conflict is never silently overwritten by the next save', async () => {
    const files = new Map<string, string>();
    const handle = (name: string) => ({
      kind: 'file' as const,
      name,
      getFile: () => Promise.resolve({ lastModified: 1, text: () => Promise.resolve(files.get(name) ?? '') }),
      createWritable: () => {
        let b = '';
        return Promise.resolve({
          write: (d: string) => ((b += d), Promise.resolve()),
          close: () => (files.set(name, b), Promise.resolve()),
        });
      },
    });
    const dir: DirHandleLike = {
      kind: 'directory',
      name: 'd',
      async *values() {
        await Promise.resolve();
        for (const n of files.keys()) yield handle(n);
      },
      getFileHandle: (n, o) =>
        files.has(n) || o?.create
          ? (files.has(n) || files.set(n, ''), Promise.resolve(handle(n)))
          : Promise.reject(new Error('nf')),
    };
    const sync = new FolderSync(dir);
    const doc = newDocument('S');
    await sync.saveScene(doc);
    files.set('S.physixlab.json', JSON.stringify({ other: 'device' }));
    expect(await sync.saveScene(doc)).toBe('conflict');
    expect(await sync.saveScene(doc)).toBe('conflict'); // still a conflict, not an overwrite
    expect(files.get('S.physixlab.json')).toContain('other');
  });
});

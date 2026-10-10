import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IdbBackend, MemoryBackend, storageUsage, type StorageBackend } from '../src/app/storage';
import { LS_AUTOSAVE_KEY, LS_LIBRARY_KEY, migrateLocalStorage } from '../src/app/storage/migrate';

async function backends(): Promise<[string, StorageBackend][]> {
  return [
    ['indexeddb', await IdbBackend.open(new IDBFactory(), 'test')],
    ['memory', new MemoryBackend()],
  ];
}

describe('storage layer (DT-10)', async () => {
  for (const [name, mk] of await backends()) {
    it(`${name}: put / get / list / keys / delete / clear`, async () => {
      await mk.clear('scenes');
      await mk.put('scenes', 'b', { n: 2 });
      await mk.put('scenes', 'a', { n: 1, arr: new Uint8Array([1, 2, 3]) });
      expect(await mk.get('scenes', 'a')).toMatchObject({ n: 1 });
      expect(await mk.get('scenes', 'zzz')).toBeUndefined();
      expect(await mk.keys('scenes')).toEqual(['a', 'b']);
      expect((await mk.list<{ n: number }>('scenes')).map((i) => i.value.n)).toEqual([1, 2]);
      await mk.put('scenes', 'a', { n: 9 });
      expect(await mk.get('scenes', 'a')).toEqual({ n: 9 });
      await mk.delete('scenes', 'a');
      expect(await mk.keys('scenes')).toEqual(['b']);
      await mk.put('thumbnails', 't', 'x'); // collections are isolated
      expect(await mk.keys('scenes')).toEqual(['b']);
      await mk.clear('scenes');
      expect(await mk.keys('scenes')).toEqual([]);
    });
  }

  it('usage report counts bytes per collection', async () => {
    const m = new MemoryBackend();
    await m.put('scenes', 'a', 'x'.repeat(1000));
    await m.put('thumbnails', 't', new Uint8Array(500));
    const u = await storageUsage(m);
    expect(u.perCollection.scenes.count).toBe(1);
    expect(u.perCollection.scenes.bytes).toBeGreaterThanOrEqual(1000);
    expect(u.perCollection.thumbnails.bytes).toBeGreaterThanOrEqual(500);
    expect(u.bytes).toBe(Object.values(u.perCollection).reduce((n, c) => n + c.bytes, 0));
  });

  it('migrates localStorage autosave + library once, then removes the old keys', async () => {
    const data: Record<string, string> = {
      [LS_AUTOSAVE_KEY]: '{"v":1}',
      [LS_LIBRARY_KEY]: JSON.stringify([{ id: 's1', name: 'One', savedAt: 1, bodies: 2, data: '{}' }]),
    };
    const ls = {
      getItem: (k: string) => data[k] ?? null,
      removeItem: (k: string) => void delete data[k],
    };
    const m = new MemoryBackend();
    const r = await migrateLocalStorage(m, ls);
    expect(r).toEqual({ ran: true, autosave: true, scenes: 1 });
    expect(await m.get('meta', 'autosave')).toBe('{"v":1}');
    expect(await m.get('scenes', 's1')).toMatchObject({ name: 'One' });
    expect(data[LS_AUTOSAVE_KEY]).toBeUndefined();
    expect(data[LS_LIBRARY_KEY]).toBeUndefined();
    expect((await migrateLocalStorage(m, ls)).ran).toBe(false);
  });

  it('keeps a damaged localStorage library instead of deleting it', async () => {
    const data: Record<string, string> = { [LS_LIBRARY_KEY]: '{not json' };
    const ls = { getItem: (k: string) => data[k] ?? null, removeItem: (k: string) => void delete data[k] };
    await migrateLocalStorage(new MemoryBackend(), ls);
    expect(data[LS_LIBRARY_KEY]).toBe('{not json');
  });
});

import { describe, expect, it } from 'vitest';
import { PrefabLibrary } from '../src/app/edit/prefabLibrary';
import {
  IDB_STORE,
  IdbPrefabStorage,
  LS_PREFIX,
  LocalPrefabStorage,
  MemoryPrefabStorage,
  openPrefabStorage,
  type StorageLike,
} from '../src/app/edit/prefabStorage';
import { capturePrefab, instantiatePrefab, PrefabPackError, type StoredPrefab } from '../src/model/edit/userPrefab';
import { createBody } from '../src/model/factory';
import { isBody } from '../src/model/types';

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  quota = Infinity;
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (v.length > this.quota) throw new Error('QuotaExceededError');
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

/** Just enough of IndexedDB for the adapter: one database, object stores with a keyPath, async requests. */
class FakeIdbRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}
class FakeObjectStore {
  constructor(
    private rows: Map<string, unknown>,
    private tx: FakeTx,
  ) {}
  private req<T>(fn: () => T): FakeIdbRequest<T> {
    const r = new FakeIdbRequest<T>();
    setTimeout(() => {
      r.result = fn();
      r.onsuccess?.();
    }, 0);
    return r;
  }
  getAll = () => this.req(() => [...this.rows.values()].map((v) => structuredClone(v)));
  get = (id: string) => this.req(() => structuredClone(this.rows.get(id)));
  put = (v: { id: string }) => {
    const c = structuredClone(v);
    this.tx.pending++;
    const r = this.req(() => {
      this.rows.set(c.id, c);
      this.tx.settle();
      return c.id;
    });
    return r;
  };
  delete = (id: string) => {
    this.tx.pending++;
    return this.req(() => {
      this.rows.delete(id);
      this.tx.settle();
      return undefined;
    });
  };
}
class FakeTx {
  pending = 0;
  error: DOMException | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor(private rows: Map<string, unknown>) {
    // A read-only transaction completes on its own.
    setTimeout(() => this.settle(), 5);
  }
  settle(): void {
    setTimeout(() => {
      if (this.pending > 0) this.pending--;
      if (this.pending === 0) this.oncomplete?.();
    }, 1);
  }
  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this.rows, this);
  }
}
class FakeDb {
  stores = new Map<string, Map<string, unknown>>();
  objectStoreNames = { contains: (n: string) => this.stores.has(n) };
  createObjectStore(n: string) {
    this.stores.set(n, new Map());
  }
  transaction(n: string): FakeTx {
    const s = this.stores.get(n);
    if (!s) throw new Error('NotFoundError');
    return new FakeTx(s);
  }
}
class FakeIdbFactory {
  dbs = new Map<string, FakeDb>();
  opens = 0;
  fail = false;
  open(name: string): FakeIdbRequest<FakeDb> {
    this.opens++;
    const r = new FakeIdbRequest<FakeDb>();
    setTimeout(() => {
      if (this.fail) {
        r.error = new DOMException('denied', 'SecurityError');
        r.onerror?.();
        return;
      }
      let db = this.dbs.get(name);
      r.result = db ?? (db = new FakeDb());
      if (!this.dbs.has(name)) {
        this.dbs.set(name, db);
        r.onupgradeneeded?.();
      }
      r.onsuccess?.();
    }, 0);
    return r;
  }
}

const asFactory = (f: FakeIdbFactory) => f as unknown as IDBFactory;

function prefab(name: string, id?: string): StoredPrefab {
  const b = createBody({ name, shape: { type: 'box', size: [1, 2, 3] }, position: [0, 1, 0] });
  const p = capturePrefab([b], [b.id], name, { id, tags: ['t'] })!;
  p.thumbnail = 'data:image/png;base64,AAAA';
  return p;
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────

describe('LocalPrefabStorage', () => {
  it('stores one key per prefab, lists, gets, deletes, and ignores damaged or foreign entries', async () => {
    const fake = new FakeStorage();
    fake.setItem('unrelated', 'x');
    fake.setItem(`${LS_PREFIX}broken`, '{not json');
    fake.setItem(`${LS_PREFIX}hostile`, JSON.stringify({ name: 'h', entities: 'nope' }));
    const s = new LocalPrefabStorage(fake);
    const a = prefab('A', 'a');
    await s.put(a);
    await s.put(prefab('B', 'b'));
    expect((await s.list()).map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect((await s.get('a'))!.entities).toEqual(a.entities);
    expect(await s.get('missing')).toBeUndefined();
    await s.delete('a');
    expect((await s.list()).map((p) => p.id)).toEqual(['b']);
    expect(fake.getItem('unrelated')).toBe('x');
  });

  it('reports a full browser store with an actionable message and keeps the old copy', async () => {
    const fake = new FakeStorage();
    const s = new LocalPrefabStorage(fake);
    await s.put(prefab('A', 'a'));
    fake.quota = 10;
    await expect(s.put(prefab('A', 'a'))).rejects.toThrow(/no room left/);
    expect((await s.get('a'))!.name).toBe('A');
  });
});

describe('IdbPrefabStorage (fake IDBFactory)', () => {
  it('creates the store on first open and round-trips prefabs through structured clone', async () => {
    const f = new FakeIdbFactory();
    const s = new IdbPrefabStorage(asFactory(f));
    await s.put(prefab('A', 'a'));
    await s.put(prefab('B', 'b'));
    expect(f.dbs.get('physixlab-prefabs')!.stores.has(IDB_STORE)).toBe(true);
    expect((await s.list()).map((p) => p.name).sort()).toEqual(['A', 'B']);
    expect((await s.get('b'))!.entities.filter(isBody)[0].shape.size).toEqual([1, 2, 3]);
    await s.delete('a');
    expect(await s.get('a')).toBeUndefined();
    // A second adapter on the same factory sees the data (it is persistent, not per instance).
    expect((await new IdbPrefabStorage(asFactory(f)).list()).map((p) => p.id)).toEqual(['b']);
  });

  it('drops rows that fail sanitising', async () => {
    const f = new FakeIdbFactory();
    const s = new IdbPrefabStorage(asFactory(f));
    await s.put(prefab('A', 'a'));
    f.dbs
      .get('physixlab-prefabs')!
      .stores.get(IDB_STORE)!
      .set('evil', { id: 'evil', name: 'x', entities: [1, 2] });
    expect((await s.list()).map((p) => p.id)).toEqual(['a']);
  });
});

describe('openPrefabStorage', () => {
  it('uses IndexedDB and moves localStorage prefabs into it exactly once', async () => {
    const ls = new FakeStorage();
    const old = new LocalPrefabStorage(ls);
    await old.put(prefab('Old', 'old'));
    ls.setItem('unrelated', 'keep');
    const f = new FakeIdbFactory();
    const s = await openPrefabStorage({ indexedDB: asFactory(f), localStorage: ls });
    expect(s.kind).toBe('indexeddb');
    expect((await s.list()).map((p) => p.id)).toEqual(['old']);
    expect([...ls.data.keys()]).toEqual(['unrelated']); // moved, not copied
    // A later start finds it in IndexedDB and has nothing left to migrate.
    const again = await openPrefabStorage({ indexedDB: asFactory(f), localStorage: ls });
    expect((await again.list()).map((p) => p.id)).toEqual(['old']);
  });

  it('falls back to localStorage when IndexedDB is missing or refuses to open, and to memory without both', async () => {
    const ls = new FakeStorage();
    expect((await openPrefabStorage({ indexedDB: null, localStorage: ls })).kind).toBe('localstorage');
    const bad = new FakeIdbFactory();
    bad.fail = true;
    const s = await openPrefabStorage({ indexedDB: asFactory(bad), localStorage: ls });
    expect(s.kind).toBe('localstorage');
    await s.put(prefab('A', 'a'));
    expect(ls.getItem(`${LS_PREFIX}a`)).toBeTruthy();
    const mem = await openPrefabStorage({ indexedDB: null, localStorage: null });
    expect(mem.kind).toBe('memory');
  });
});

describe('PrefabLibrary', () => {
  const make = async () => {
    const lib = new PrefabLibrary(new MemoryPrefabStorage());
    await lib.ready;
    return lib;
  };

  it('saves, searches by name and tag, duplicates, and persists through the storage', async () => {
    const storage = new MemoryPrefabStorage();
    const lib = new PrefabLibrary(storage);
    await lib.ready;
    let changes = 0;
    lib.on('change', () => changes++);
    const a = await lib.save({ ...prefab('Red crate'), tags: ['crate', 'red'] });
    await lib.save({ ...prefab('Blue barrel'), tags: ['barrel'] });
    expect(changes).toBe(2);
    expect(lib.search('crate').map((p) => p.id)).toEqual([a.id]);
    expect(lib.search('', ['barrel'])).toHaveLength(1);
    expect(lib.search('red crate', ['red'])).toHaveLength(1);
    expect(lib.search('red', ['barrel'])).toHaveLength(0);
    expect(lib.tags()).toEqual([
      ['barrel', 1],
      ['crate', 1],
      ['red', 1],
    ]);
    const copy = await lib.duplicate(a.id);
    expect(copy.name).toBe('Red crate copy');
    expect(copy.id).not.toBe(a.id);
    expect((await storage.list()).length).toBe(3);
    // A fresh library over the same storage restores everything.
    const lib2 = new PrefabLibrary(storage);
    await lib2.ready;
    expect(lib2.list()).toHaveLength(3);
  });

  it('refuses nesting cycles and unlinks a deleted prefab from its dependents', async () => {
    const lib = await make();
    const a = await lib.save(prefab('A', 'a'));
    const b = await lib.save({
      ...prefab('B', 'b'),
      nested: [{ id: 'n', prefabId: 'a', position: [0, 0, 0], yaw: 0 }],
    });
    await expect(
      lib.update('a', { nested: [{ id: 'n', prefabId: 'b', position: [0, 0, 0], yaw: 0 }] }),
    ).rejects.toThrow(PrefabPackError);
    expect(lib.get('a')!.nested).toEqual([]);
    expect(lib.dependents('a').map((p) => p.id)).toEqual([b.id]);
    await lib.remove(a.id);
    expect(lib.get('a')).toBeUndefined();
    expect(lib.get('b')!.nested).toEqual([]);
  });

  it('exports with nested prefabs included and imports into another library without id clashes', async () => {
    const lib = await make();
    await lib.save(prefab('Leaf', 'leaf'));
    await lib.save({ ...prefab('Top', 'top'), nested: [{ id: 'n', prefabId: 'leaf', position: [2, 0, 0], yaw: 0 }] });
    const text = lib.exportText(['top']);
    expect((JSON.parse(text) as { prefabs: StoredPrefab[] }).prefabs.map((p) => p.id).sort()).toEqual(['leaf', 'top']);

    const other = await make();
    const first = await other.importText(text);
    expect(first.added).toHaveLength(2);
    // Importing the same pack again duplicates with fresh ids and consistent nested links.
    const second = await other.importText(text);
    expect(second.added).toHaveLength(2);
    expect(other.size).toBe(4);
    const top2 = second.added.find((p) => p.name === 'Top')!;
    const leaf2 = second.added.find((p) => p.name === 'Leaf')!;
    expect(top2.id).not.toBe('top');
    expect(top2.nested[0].prefabId).toBe(leaf2.id);
    const r = instantiatePrefab(top2, other.get, { at: [0, 0, 0] });
    expect(r.entities.filter(isBody)).toHaveLength(2);
  });

  it('rejects an invalid pack with a message and leaves the library alone', async () => {
    const lib = await make();
    await lib.save(prefab('Keep', 'keep'));
    await expect(lib.importText('{"format":"nope"}')).rejects.toThrow(/not a PhysixLab prefab pack/);
    expect(lib.size).toBe(1);
  });
});

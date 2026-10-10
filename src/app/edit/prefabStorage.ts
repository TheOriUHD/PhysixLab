/**
 * ED-22 — persistence of the user prefab library behind one tiny async interface.
 *
 * Backends: IndexedDB (when the browser has it and it opens), else localStorage, else memory. Prefabs that an
 * earlier session left in localStorage are moved into IndexedDB the first time it opens (and removed from
 * localStorage once they are safely stored). Everything read back goes through `sanitizePrefab`: storage is
 * user-editable and shared between versions, so it is never trusted. This adapter stands alone on purpose; it
 * can later be pointed at `src/app/storage` without touching the library or the UI.
 */
import { PrefabPackError, sanitizePrefab, type StoredPrefab } from '../../model/edit/userPrefab';

export interface PrefabStorage {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
  list(): Promise<StoredPrefab[]>;
  get(id: string): Promise<StoredPrefab | undefined>;
  put(p: StoredPrefab): Promise<void>;
  delete(id: string): Promise<void>;
}

/** The part of `Storage` that is used (a fake satisfies it in tests). */
export interface StorageLike {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const LS_PREFIX = 'physixlab.prefab.';
export const IDB_NAME = 'physixlab-prefabs';
export const IDB_STORE = 'prefabs';

function readPrefab(raw: unknown): StoredPrefab | undefined {
  try {
    return sanitizePrefab(raw);
  } catch (e) {
    if (e instanceof PrefabPackError) return undefined; // a damaged entry is skipped, never fatal
    throw e;
  }
}

// ── memory ──────────────────────────────────────────────────────────────────────────────────────────

export class MemoryPrefabStorage implements PrefabStorage {
  readonly kind = 'memory' as const;
  private items = new Map<string, StoredPrefab>();
  list(): Promise<StoredPrefab[]> {
    return Promise.resolve([...this.items.values()]);
  }
  get(id: string): Promise<StoredPrefab | undefined> {
    return Promise.resolve(this.items.get(id));
  }
  put(p: StoredPrefab): Promise<void> {
    this.items.set(p.id, p);
    return Promise.resolve();
  }
  delete(id: string): Promise<void> {
    this.items.delete(id);
    return Promise.resolve();
  }
}

// ── localStorage ────────────────────────────────────────────────────────────────────────────────────

export class LocalPrefabStorage implements PrefabStorage {
  readonly kind = 'localstorage' as const;
  constructor(
    private storage: StorageLike,
    private prefix = LS_PREFIX,
  ) {}

  private keys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k && k.startsWith(this.prefix)) out.push(k);
    }
    return out;
  }

  private parse(key: string): StoredPrefab | undefined {
    const text = this.storage.getItem(key);
    if (text === null) return undefined;
    try {
      return readPrefab(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  list(): Promise<StoredPrefab[]> {
    return Promise.resolve(this.keys().flatMap((k) => this.parse(k) ?? []));
  }
  get(id: string): Promise<StoredPrefab | undefined> {
    return Promise.resolve(this.parse(this.prefix + id));
  }
  put(p: StoredPrefab): Promise<void> {
    try {
      this.storage.setItem(this.prefix + p.id, JSON.stringify(p));
      return Promise.resolve();
    } catch {
      return Promise.reject(
        new Error(
          'The browser has no room left to store this prefab. Export a pack, then delete prefabs you no longer need.',
        ),
      );
    }
  }
  delete(id: string): Promise<void> {
    this.storage.removeItem(this.prefix + id);
    return Promise.resolve();
  }
}

// ── IndexedDB ───────────────────────────────────────────────────────────────────────────────────────

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

export class IdbPrefabStorage implements PrefabStorage {
  readonly kind = 'indexeddb' as const;
  private db: Promise<IDBDatabase> | null = null;
  constructor(
    private factory: IDBFactory,
    private name = IDB_NAME,
  ) {}

  /** Open (and on first use create) the database. Rejects when the browser refuses (private windows, blocked). */
  open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
          req = this.factory.open(this.name, 1);
        } catch (e) {
          reject(e instanceof Error ? e : new Error('IndexedDB is unavailable'));
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened'));
        req.onblocked = () => reject(new Error('IndexedDB is blocked'));
      });
      this.db.catch(() => (this.db = null)); // allow a retry after a failure
    }
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<{ tx: IDBTransaction; os: IDBObjectStore }> {
    const db = await this.open();
    const tx = db.transaction(IDB_STORE, mode);
    return { tx, os: tx.objectStore(IDB_STORE) };
  }

  async list(): Promise<StoredPrefab[]> {
    const { os } = await this.store('readonly');
    const rows = (await request(os.getAll())) as unknown[];
    return rows.flatMap((r) => readPrefab(r) ?? []);
  }
  async get(id: string): Promise<StoredPrefab | undefined> {
    const { os } = await this.store('readonly');
    const row = (await request(os.get(id))) as unknown;
    return row === undefined ? undefined : readPrefab(row);
  }
  async put(p: StoredPrefab): Promise<void> {
    const { tx, os } = await this.store('readwrite');
    os.put(p);
    await done(tx);
  }
  async delete(id: string): Promise<void> {
    const { tx, os } = await this.store('readwrite');
    os.delete(id);
    await done(tx);
  }
}

// ── choosing a backend ──────────────────────────────────────────────────────────────────────────────

export interface StorageEnv {
  indexedDB?: IDBFactory | null;
  localStorage?: StorageLike | null;
}

/** The ambient browser storages (each may be missing or throw when accessed, e.g. blocked site data). */
export function browserStorageEnv(): StorageEnv {
  const env: StorageEnv = {};
  try {
    env.indexedDB = typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    env.indexedDB = null;
  }
  try {
    env.localStorage = typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    env.localStorage = null;
  }
  return env;
}

/**
 * IndexedDB when it opens, else localStorage, else memory. Prefabs found in localStorage are copied into
 * IndexedDB and then removed from localStorage (only after the copy succeeded), so the move happens once.
 */
export async function openPrefabStorage(env: StorageEnv = browserStorageEnv()): Promise<PrefabStorage> {
  const local = env.localStorage ? new LocalPrefabStorage(env.localStorage) : null;
  if (env.indexedDB) {
    try {
      const idb = new IdbPrefabStorage(env.indexedDB);
      await idb.open();
      if (local) {
        for (const p of await local.list()) {
          await idb.put(p);
          await local.delete(p.id);
        }
      }
      return idb;
    } catch {
      /* fall through to localStorage */
    }
  }
  return local ?? new MemoryPrefabStorage();
}

/** A storage that is usable immediately while the real backend is still being chosen (calls wait for it). */
export function lazyPrefabStorage(open: () => Promise<PrefabStorage>): PrefabStorage {
  const backend = open();
  let resolved: PrefabStorage | null = null;
  void backend.then(
    (b) => (resolved = b),
    () => undefined,
  );
  return {
    get kind() {
      return resolved?.kind ?? 'memory';
    },
    list: () => backend.then((b) => b.list()),
    get: (id) => backend.then((b) => b.get(id)),
    put: (p) => backend.then((b) => b.put(p)),
    delete: (id) => backend.then((b) => b.delete(id)),
  };
}

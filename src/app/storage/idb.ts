import { COLLECTIONS, StorageError, type Collection, type StorageBackend, type StoredItem } from './types';

const DB_NAME = 'physicslab';
const DB_VERSION = 1;

function wrap(e: unknown, what: string): StorageError {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError')
    return new StorageError('quota', 'Browser storage is full. Free some space in Settings → Storage.');
  return new StorageError('failed', `Storage ${what} failed: ${(e as Error | null)?.message ?? String(e)}`);
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error('request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error ?? new Error('transaction failed'));
    tx.onabort = () => rej(tx.error ?? new Error('transaction aborted'));
  });
}

/** IndexedDB backend: one object store per collection (out-of-line keys). */
export class IdbBackend implements StorageBackend {
  readonly kind = 'indexeddb' as const;
  private constructor(private db: IDBDatabase) {
    // Another tab upgrading the schema needs us to let go.
    db.onversionchange = () => db.close();
  }

  static open(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<IdbBackend> {
    return new Promise((resolve, reject) => {
      let r: IDBOpenDBRequest;
      try {
        r = factory.open(name, DB_VERSION);
      } catch (e) {
        reject(new StorageError('unavailable', `IndexedDB is not available: ${(e as Error).message}`));
        return;
      }
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const c of COLLECTIONS) if (!db.objectStoreNames.contains(c)) db.createObjectStore(c);
      };
      r.onsuccess = () => resolve(new IdbBackend(r.result));
      r.onerror = () =>
        reject(new StorageError('unavailable', `IndexedDB could not be opened: ${r.error?.message ?? 'blocked'}`));
      r.onblocked = () => reject(new StorageError('unavailable', 'IndexedDB is blocked by another tab.'));
    });
  }

  async get<T>(c: Collection, key: string): Promise<T | undefined> {
    try {
      return (await req(this.db.transaction(c).objectStore(c).get(key))) as T | undefined;
    } catch (e) {
      throw wrap(e, 'read');
    }
  }
  async put(c: Collection, key: string, value: unknown): Promise<void> {
    try {
      const tx = this.db.transaction(c, 'readwrite');
      tx.objectStore(c).put(value, key);
      await done(tx);
    } catch (e) {
      throw wrap(e, 'write');
    }
  }
  async delete(c: Collection, key: string): Promise<void> {
    try {
      const tx = this.db.transaction(c, 'readwrite');
      tx.objectStore(c).delete(key);
      await done(tx);
    } catch (e) {
      throw wrap(e, 'delete');
    }
  }
  async keys(c: Collection): Promise<string[]> {
    try {
      return (await req(this.db.transaction(c).objectStore(c).getAllKeys())).map((k) => String(k as string)).sort();
    } catch (e) {
      throw wrap(e, 'listing');
    }
  }
  async list<T>(c: Collection): Promise<StoredItem<T>[]> {
    try {
      const store = this.db.transaction(c).objectStore(c);
      const [keys, values] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
      return keys
        .map((k, i) => ({ key: String(k as string), value: values[i] as T }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    } catch (e) {
      throw wrap(e, 'listing');
    }
  }
  async clear(c: Collection): Promise<void> {
    try {
      const tx = this.db.transaction(c, 'readwrite');
      tx.objectStore(c).clear();
      await done(tx);
    } catch (e) {
      throw wrap(e, 'clear');
    }
  }
  close(): void {
    this.db.close();
  }
}

import type { Collection, StorageBackend, StoredItem } from './types';

/** In-memory backend: the fallback when IndexedDB is unavailable (private windows, blocked storage) and the test double. */
export class MemoryBackend implements StorageBackend {
  readonly kind = 'memory' as const;
  private data = new Map<string, Map<string, unknown>>();

  private col(c: Collection): Map<string, unknown> {
    let m = this.data.get(c);
    if (!m) {
      m = new Map<string, unknown>();
      this.data.set(c, m);
    }
    return m;
  }
  get<T>(c: Collection, key: string): Promise<T | undefined> {
    return Promise.resolve().then(() => {
      const v = this.col(c).get(key);
      return v === undefined ? undefined : (structuredClone(v) as T);
    });
  }
  put(c: Collection, key: string, value: unknown): Promise<void> {
    return Promise.resolve().then(() => {
      this.col(c).set(key, structuredClone(value));
    });
  }
  delete(c: Collection, key: string): Promise<void> {
    return Promise.resolve().then(() => {
      this.col(c).delete(key);
    });
  }
  keys(c: Collection): Promise<string[]> {
    return Promise.resolve().then(() => {
      return [...this.col(c).keys()].sort();
    });
  }
  list<T>(c: Collection): Promise<StoredItem<T>[]> {
    return Promise.resolve().then(() => {
      return [...this.col(c).entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => ({ key, value: structuredClone(value) as T }));
    });
  }
  clear(c: Collection): Promise<void> {
    return Promise.resolve().then(() => {
      this.col(c).clear();
    });
  }
  close(): void {
    /* nothing to release */
  }
}

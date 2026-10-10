/**
 * Storage layer (DT-10): a tiny async key/value API grouped in collections, backed by IndexedDB with an in-memory
 * fallback. Values are structured-cloneable (plain data, strings, typed arrays, Blobs).
 *
 *   const s = await getStorage();
 *   await s.put('scenes', 'my-id', { name: 'x', data: '…' });
 *   const v = await s.get<MyType>('scenes', 'my-id');
 *   const ids = await s.keys('scenes');
 *   await s.delete('scenes', 'my-id');
 */

/** Well-known collections. Any other string is accepted (created lazily is NOT supported: add it to `COLLECTIONS`). */
export const COLLECTIONS = [
  'scenes',
  'assets',
  'thumbnails',
  'prefabs',
  'replays',
  'settings',
  'snapshots',
  'meta',
] as const;
export type Collection = (typeof COLLECTIONS)[number];

export interface StoredItem<T = unknown> {
  key: string;
  value: T;
}

export interface UsageReport {
  /** Approximate bytes per collection (JSON / typed-array / Blob size estimate). */
  perCollection: Record<string, { count: number; bytes: number }>;
  /** Sum of `perCollection`. */
  bytes: number;
  /** Browser-reported total usage / quota of the origin, when available (navigator.storage.estimate). */
  originUsage: number | null;
  originQuota: number | null;
}

export interface StorageBackend {
  /** 'indexeddb' persists across sessions; 'memory' is the fallback and loses data when the tab closes. */
  readonly kind: 'indexeddb' | 'memory';
  get<T = unknown>(collection: Collection, key: string): Promise<T | undefined>;
  /** Rejects with a `StorageError` (code 'quota' when the browser is out of space). */
  put(collection: Collection, key: string, value: unknown): Promise<void>;
  delete(collection: Collection, key: string): Promise<void>;
  keys(collection: Collection): Promise<string[]>;
  /** All entries of a collection (key order). */
  list<T = unknown>(collection: Collection): Promise<StoredItem<T>[]>;
  clear(collection: Collection): Promise<void>;
  close(): void;
}

export class StorageError extends Error {
  constructor(
    readonly code: 'quota' | 'unavailable' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Rough byte size of a stored value (for the quota meter): strings count 2 bytes/char only when non-ASCII is likely, so use UTF-8 length. */
export function approxBytes(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'string') return utf8Length(v);
  if (typeof v === 'number') return 8;
  if (typeof v === 'boolean') return 4;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v.size;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + approxBytes(x), 8);
  if (typeof v === 'object') {
    let n = 8;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) n += utf8Length(k) + approxBytes(x);
    return n;
  }
  return 0;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

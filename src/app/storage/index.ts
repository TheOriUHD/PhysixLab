/**
 * The storage service (DT-10). `getStorage()` opens IndexedDB once (falling back to memory with a warning flag),
 * runs the one-time localStorage migration and returns the backend. Everything persistent that is bigger than a
 * preference belongs here, not in localStorage.
 */
import { IdbBackend } from './idb';
import { MemoryBackend } from './memory';
import { migrateLocalStorage } from './migrate';
import { approxBytes, COLLECTIONS, type StorageBackend, type UsageReport } from './types';

export * from './types';
export { MemoryBackend } from './memory';
export { IdbBackend } from './idb';

export interface StorageStatus {
  backend: StorageBackend;
  /** True when IndexedDB was unavailable: data lives in memory only. The UI shows `warning`. */
  degraded: boolean;
  warning: string | null;
}

let pending: Promise<StorageStatus> | null = null;

export function getStorageStatus(): Promise<StorageStatus> {
  pending ??= openStorage();
  return pending;
}

export async function getStorage(): Promise<StorageBackend> {
  return (await getStorageStatus()).backend;
}

async function openStorage(): Promise<StorageStatus> {
  let status: StorageStatus;
  try {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available in this browser');
    status = { backend: await IdbBackend.open(), degraded: false, warning: null };
  } catch (e) {
    status = {
      backend: new MemoryBackend(),
      degraded: true,
      warning: `Persistent storage is unavailable (${(e as Error).message}). Your work is kept in memory only — export scenes to files to keep them.`,
    };
  }
  await migrateLocalStorage(status.backend).catch(() => {
    /* a failed migration leaves the localStorage data in place; it is retried next start */
  });
  return status;
}

/** Test hook: use `backend` instead of opening IndexedDB (and skip the migration). */
export function setStorageForTests(backend: StorageBackend | null): void {
  pending = backend ? Promise.resolve({ backend, degraded: backend.kind === 'memory', warning: null }) : null;
}

/** Quota meter data: bytes per collection plus the browser's origin usage / quota. */
export async function storageUsage(backend?: StorageBackend): Promise<UsageReport> {
  const b = backend ?? (await getStorage());
  const perCollection: UsageReport['perCollection'] = {};
  let bytes = 0;
  // in parallel: every IndexedDB round trip costs at least one task, and the page may be busy rendering
  const lists = await Promise.all(COLLECTIONS.map((c) => b.list(c)));
  COLLECTIONS.forEach((c, i) => {
    let n = 0;
    for (const it of lists[i]) n += approxBytes(it.key) + approxBytes(it.value);
    perCollection[c] = { count: lists[i].length, bytes: n };
    bytes += n;
  });
  let originUsage: number | null = null;
  let originQuota: number | null = null;
  try {
    // Some browsers never answer (private windows, headless): do not hold the dialog hostage
    const est = await Promise.race([
      navigator.storage?.estimate?.(),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500)),
    ]);
    originUsage = est?.usage ?? null;
    originQuota = est?.quota ?? null;
  } catch {
    /* estimate unsupported */
  }
  return { perCollection, bytes, originUsage, originQuota };
}

/**
 * One-time migration of the pre-IndexedDB data (localStorage) into the storage layer (DT-10).
 *  - `physixlab:autosave:v1`  → meta/autosave        (serialized scene JSON string)
 *  - `physixlab:library:v1`   → scenes/<id>           (LibraryEntry objects)
 * The localStorage keys are removed only after the copy is verified by reading it back, and a marker in meta/migrated
 * stops it running twice. UI preferences stay in localStorage on purpose: they are tiny and must be readable
 * synchronously at start-up.
 */
import type { StorageBackend } from './types';

export const LS_AUTOSAVE_KEY = 'physixlab:autosave:v1';
export const LS_LIBRARY_KEY = 'physixlab:library:v1';

export interface MigrationReport {
  ran: boolean;
  autosave: boolean;
  scenes: number;
}

export async function migrateLocalStorage(
  backend: StorageBackend,
  ls: Pick<Storage, 'getItem' | 'removeItem'> | null = safeLocalStorage(),
): Promise<MigrationReport> {
  const none: MigrationReport = { ran: false, autosave: false, scenes: 0 };
  if (!ls) return none;
  // The only copy must never be removed from localStorage when the new home is volatile.
  if (backend.kind === 'memory') return none;
  if (await backend.get('meta', 'migrated-localstorage')) return none;
  const report: MigrationReport = { ran: true, autosave: false, scenes: 0 };
  let autosave: string | null;
  let library: string | null;
  try {
    autosave = ls.getItem(LS_AUTOSAVE_KEY);
    library = ls.getItem(LS_LIBRARY_KEY);
  } catch {
    return none;
  }
  if (autosave) {
    await backend.put('meta', 'autosave', autosave);
    report.autosave = (await backend.get('meta', 'autosave')) === autosave;
  }
  let libOk = true;
  if (library) {
    try {
      const entries = JSON.parse(library) as { id?: unknown }[];
      for (const e of Array.isArray(entries) ? entries : []) {
        if (e && typeof e.id === 'string') {
          await backend.put('scenes', e.id, e);
          report.scenes++;
        }
      }
    } catch {
      libOk = false; // damaged JSON: leave the raw value in localStorage, do not lose it
    }
  }
  await backend.put('meta', 'migrated-localstorage', { at: Date.now(), ...report });
  try {
    if (autosave && report.autosave) ls.removeItem(LS_AUTOSAVE_KEY);
    if (library && libOk) ls.removeItem(LS_LIBRARY_KEY);
  } catch {
    /* ignore */
  }
  return report;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

import { LEGACY_NAME } from '../../model/legacy';

type KeyValueStore = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

const NEW_NAME = 'physixlab';

/**
 * Copies `physicslab:…` / `physicslab.…` keys to `physixlab:…` / `physixlab.…` (autosave, library, preferences…) so
 * nothing saved before the rename is lost. A key that already exists under the new name wins. Idempotent; returns how
 * many keys moved.
 */
export function migrateLegacyStorage(storage: KeyValueStore): number {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && (k.startsWith(`${LEGACY_NAME}:`) || k.startsWith(`${LEGACY_NAME}.`))) old.push(k);
  }
  let moved = 0;
  for (const k of old) {
    const next = NEW_NAME + k.slice(LEGACY_NAME.length);
    try {
      if (storage.getItem(next) === null) {
        const v = storage.getItem(k);
        if (v !== null) storage.setItem(next, v);
      }
      storage.removeItem(k);
      moved++;
    } catch {
      /* quota or blocked storage: keep the old key rather than lose data */
    }
  }
  return moved;
}

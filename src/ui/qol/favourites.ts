/** Starred templates, prefabs, maps and shapes (UI-42), remembered per browser. */
import { isRecord, parseJson, type KeyValueStore } from './storage';

export type FavKind = 'template' | 'prefab' | 'map' | 'shape';
export const FAV_KINDS: readonly FavKind[] = ['template', 'prefab', 'map', 'shape'];
export const FAV_LIMIT = 200;
const KEY = 'physicslab:qol:favourites:v1';
const ID = /^[A-Za-z0-9][\w.:/-]{0,119}$/; // content ids (plugins may use : and /)

export class FavouritesStore {
  private listeners = new Set<(kind: FavKind) => void>();
  constructor(private readonly storage: KeyValueStore) {}

  private all(): Record<FavKind, string[]> {
    const raw = parseJson(this.storage.getItem(KEY));
    const out: Record<FavKind, string[]> = { template: [], prefab: [], map: [], shape: [] };
    if (!isRecord(raw)) return out;
    for (const kind of FAV_KINDS) {
      const v = raw[kind];
      if (Array.isArray(v))
        out[kind] = [...new Set(v.filter((x): x is string => typeof x === 'string' && ID.test(x)))].slice(0, FAV_LIMIT);
    }
    return out;
  }

  list(kind: FavKind): string[] {
    return this.all()[kind];
  }

  has(kind: FavKind, id: string): boolean {
    return this.all()[kind].includes(id);
  }

  /** Star / unstar. Returns the new state (false also when the id is malformed or the list is full). */
  toggle(kind: FavKind, id: string): boolean {
    if (!ID.test(id)) return false;
    const all = this.all();
    const list = all[kind];
    const i = list.indexOf(id);
    let on: boolean;
    if (i >= 0) {
      list.splice(i, 1);
      on = false;
    } else if (list.length >= FAV_LIMIT) on = false;
    else {
      list.push(id);
      on = true;
    }
    this.storage.setItem(KEY, JSON.stringify(all));
    for (const fn of this.listeners) fn(kind);
    return on;
  }

  onChange(fn: (kind: FavKind) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

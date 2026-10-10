/** The palette's memory of what the user ran last — most recent first, kept in the browser. */

/** The slice of `Storage` the history needs (so tests can pass a fake). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'physixlab:palette-recent:v1';

export class PaletteHistory {
  constructor(
    private readonly store: KeyValueStore | null,
    private readonly max = 8,
  ) {}

  /** Ids of the most recently run items, newest first. Never throws: unavailable or damaged storage is an empty list. */
  list(): string[] {
    try {
      const raw = this.store?.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, this.max) : [];
    } catch {
      return [];
    }
  }

  /** Remember that `id` was just run. */
  record(id: string): void {
    const next = [id, ...this.list().filter((x) => x !== id)].slice(0, this.max);
    try {
      this.store?.setItem(KEY, JSON.stringify(next));
    } catch {
      /* private mode or quota — the palette simply forgets */
    }
  }
}

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const paletteHistory = new PaletteHistory(browserStorage());

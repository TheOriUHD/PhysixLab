/** A small cache of scene thumbnails (data URLs), least recently written evicted first, with hard size caps. */
import { isRecord, parseJson, type KeyValueStore } from './storage';

export const THUMB_LIMITS = { entries: 60, totalChars: 450_000, perEntryChars: 14_000 } as const;
const KEY = 'physicslab:qol:thumbs:v1';

interface Item {
  url: string;
  at: number;
}

export class ThumbStore {
  private listeners = new Set<(key: string) => void>();
  constructor(private readonly storage: KeyValueStore) {}

  private all(): Record<string, Item> {
    const raw = parseJson(this.storage.getItem(KEY));
    const out: Record<string, Item> = {};
    if (!isRecord(raw)) return out;
    for (const [k, v] of Object.entries(raw)) {
      if (isRecord(v) && typeof v.url === 'string' && v.url.startsWith('data:image/') && typeof v.at === 'number')
        out[k] = { url: v.url, at: v.at };
    }
    return out;
  }

  get(key: string): string | null {
    return this.all()[key]?.url ?? null;
  }

  /** Store a thumbnail; returns false when it is too large to keep. */
  set(key: string, url: string, now = Date.now()): boolean {
    if (!url.startsWith('data:image/') || url.length > THUMB_LIMITS.perEntryChars) return false;
    const all = this.all();
    all[key] = { url, at: now };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
    let used = 0;
    const out: Record<string, Item> = {};
    let n = 0;
    for (const k of keys) {
      if (n >= THUMB_LIMITS.entries || used + all[k].url.length > THUMB_LIMITS.totalChars) continue;
      out[k] = all[k];
      used += all[k].url.length;
      n++;
    }
    this.storage.setItem(KEY, JSON.stringify(out));
    for (const fn of this.listeners) fn(key);
    return key in out;
  }

  remove(key: string): void {
    const all = this.all();
    delete all[key];
    this.storage.setItem(KEY, JSON.stringify(all));
  }

  onChange(fn: (key: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

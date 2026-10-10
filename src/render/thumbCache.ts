/**
 * A small cache of generated thumbnails (data URLs): in memory, and mirrored to a Storage (localStorage) so the
 * next session shows the palette at once. Every entry is stored with a fingerprint of what it was made from; an
 * entry whose fingerprint no longer matches (the shape changed, the thumbnail style was revised) is ignored and
 * replaced. Storage may be missing, full or blocked — then the cache is simply memory-only.
 */
export interface ThumbStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class ThumbCache {
  private memory = new Map<string, { fingerprint: string; url: string }>();
  private writable = true;

  constructor(
    private storage: ThumbStorage | null,
    private prefix = 'physicslab.thumb.',
  ) {}

  get(id: string, fingerprint: string): string | null {
    const mem = this.memory.get(id);
    if (mem) return mem.fingerprint === fingerprint ? mem.url : null;
    try {
      const raw = this.storage?.getItem(this.prefix + id);
      if (raw) {
        const entry = JSON.parse(raw) as { f?: unknown; u?: unknown };
        if (entry.f === fingerprint && typeof entry.u === 'string' && entry.u.startsWith('data:image/')) {
          this.memory.set(id, { fingerprint, url: entry.u });
          return entry.u;
        }
        this.storage?.removeItem(this.prefix + id); // stale: do not keep it around
      }
    } catch {
      /* unreadable storage or a corrupt entry: regenerate */
    }
    return null;
  }

  set(id: string, fingerprint: string, url: string): void {
    this.memory.set(id, { fingerprint, url });
    if (!this.writable || !this.storage) return;
    try {
      this.storage.setItem(this.prefix + id, JSON.stringify({ f: fingerprint, u: url }));
    } catch {
      this.writable = false; // quota or privacy mode: stay in memory
    }
  }

  clear(): void {
    this.memory.clear();
  }
}

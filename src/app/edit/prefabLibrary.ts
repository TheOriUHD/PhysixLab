/**
 * ED-22 — the user's prefab library: an in-memory index over a `PrefabStorage`, with change events.
 *
 * DOM-free, so it is unit-tested in Node with a fake storage. The UI (panel, dialogs, commands) talks to this and
 * to `prefabActions.ts`; nothing else touches storage.
 */
import { Emitter } from '../../core/events';
import { uid } from '../../model/factory';
import {
  PREFAB_LIMITS,
  PrefabPackError,
  cleanTags,
  exportPack,
  importPack,
  nestingProblem,
  reidentifyImported,
  sanitizePrefab,
  type StoredPrefab,
} from '../../model/edit/userPrefab';
import type { PrefabStorage } from './prefabStorage';

interface LibraryEvents extends Record<string, unknown> {
  change: undefined;
}

export class PrefabLibrary extends Emitter<LibraryEvents> {
  private items = new Map<string, StoredPrefab>();
  /** Resolves when the stored prefabs have been read. */
  readonly ready: Promise<void>;
  loaded = false;

  constructor(readonly storage: PrefabStorage) {
    super();
    this.ready = storage.list().then(
      (rows) => {
        for (const p of rows) if (!this.items.has(p.id)) this.items.set(p.id, p);
        this.loaded = true;
        this.emit('change', undefined);
      },
      () => {
        this.loaded = true;
        this.emit('change', undefined);
      },
    );
  }

  /** Newest first. */
  list(): StoredPrefab[] {
    return [...this.items.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }
  get = (id: string): StoredPrefab | undefined => this.items.get(id);
  has(id: string): boolean {
    return this.items.has(id);
  }
  get size(): number {
    return this.items.size;
  }

  /** Every tag in use, alphabetical, with how many prefabs carry it. */
  tags(): [string, number][] {
    const count = new Map<string, number>();
    for (const p of this.items.values()) for (const t of p.tags) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  /** Prefabs whose name or tags match `query` (all words) and that carry every tag in `tags`. */
  search(query: string, tags: readonly string[] = []): StoredPrefab[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.list().filter((p) => {
      const hay = [p.name, ...p.tags].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w)) && tags.every((t) => p.tags.includes(t));
    });
  }

  /** Prefabs that nest `id`. */
  dependents(id: string): StoredPrefab[] {
    return this.list().filter((p) => p.nested.some((n) => n.prefabId === id));
  }

  /** Add or replace a prefab (validated). Rejects when it cannot be stored; the library is then left unchanged. */
  async save(p: StoredPrefab): Promise<StoredPrefab> {
    if (!this.items.has(p.id) && this.items.size >= PREFAB_LIMITS.maxPrefabs) {
      throw new PrefabPackError(`The library holds up to ${PREFAB_LIMITS.maxPrefabs} prefabs. Delete some first.`);
    }
    const clean = sanitizePrefab({ ...p, updatedAt: Math.max(p.updatedAt, p.createdAt) });
    for (const n of clean.nested) {
      const problem = nestingProblem(this.get, clean.id, n.prefabId);
      if (problem) throw new PrefabPackError(problem);
    }
    await this.storage.put(clean);
    this.items.set(clean.id, clean);
    this.emit('change', undefined);
    return clean;
  }

  /** Change fields of a stored prefab and bump its modification time. */
  async update(id: string, patch: Partial<Omit<StoredPrefab, 'id' | 'createdAt'>>): Promise<StoredPrefab> {
    const cur = this.items.get(id);
    if (!cur) throw new PrefabPackError('That prefab no longer exists.');
    return this.save({ ...cur, ...patch, tags: patch.tags ? cleanTags(patch.tags) : cur.tags, updatedAt: Date.now() });
  }

  /** A copy under a new id and name. */
  async duplicate(id: string): Promise<StoredPrefab> {
    const cur = this.items.get(id);
    if (!cur) throw new PrefabPackError('That prefab no longer exists.');
    const names = new Set([...this.items.values()].map((p) => p.name));
    let name = `${cur.name} copy`;
    for (let i = 2; names.has(name); i++) name = `${cur.name} copy ${i}`;
    const now = Date.now();
    return this.save({ ...cur, id: uid('pf'), name, createdAt: now, updatedAt: now });
  }

  /** Delete a prefab; prefabs that nested it lose that reference. */
  async remove(id: string): Promise<void> {
    if (!this.items.has(id)) return;
    await this.storage.delete(id);
    this.items.delete(id);
    for (const d of this.dependents(id)) {
      const fixed = { ...d, nested: d.nested.filter((n) => n.prefabId !== id), updatedAt: Date.now() };
      await this.storage.put(fixed);
      this.items.set(d.id, fixed);
    }
    this.emit('change', undefined);
  }

  /** The JSON text of a pack holding `ids` (all prefabs when omitted); nested prefabs are included automatically. */
  exportText(ids?: readonly string[]): string {
    const want = new Set(ids ?? this.items.keys());
    const queue = [...want];
    while (queue.length) {
      const p = this.items.get(queue.pop()!);
      for (const n of p?.nested ?? []) {
        if (!want.has(n.prefabId) && this.items.has(n.prefabId)) {
          want.add(n.prefabId);
          queue.push(n.prefabId);
        }
      }
    }
    return exportPack(this.list().filter((p) => want.has(p.id)));
  }

  /** Import pack text. Clashing ids become new ones. Returns the added prefabs and any warnings. */
  async importText(text: string): Promise<{ added: StoredPrefab[]; warnings: string[] }> {
    const { prefabs, warnings } = importPack(text);
    if (this.items.size + prefabs.length > PREFAB_LIMITS.maxPrefabs) {
      throw new PrefabPackError(
        `The library holds up to ${PREFAB_LIMITS.maxPrefabs} prefabs; delete some before importing.`,
      );
    }
    const fresh = reidentifyImported(prefabs, new Set(this.items.keys()));
    const added: StoredPrefab[] = [];
    for (const p of fresh) {
      // A nested reference that would create a cycle with the library is dropped, never stored.
      const safe = {
        ...p,
        nested: p.nested.filter((n) => {
          const problem = nestingProblem(
            (id) => this.items.get(id) ?? fresh.find((f) => f.id === id),
            p.id,
            n.prefabId,
          );
          if (problem) warnings.push(`“${p.name}”: a nested prefab was skipped. ${problem}`);
          return !problem;
        }),
      };
      added.push(await this.save(safe));
    }
    return { added, warnings };
  }
}

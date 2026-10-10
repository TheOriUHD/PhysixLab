/**
 * Scene persistence: debounced autosave, a named scene library (IndexedDB via src/app/storage), JSON
 * import / export and shareable links (the scene is deflated into the URL hash, so
 * sharing needs no server).
 */
import type { LoadReport } from '../model/errors';
import { parseDocument, serializeDocument } from '../model/serialize';
import type { SceneStore } from '../model/store';
import type { SceneDocument } from '../model/types';
import { buildShare, parseShareHash, tooLargeError, type ShareResult } from './share/link';
import { getStorageStatus, StorageError, type StorageBackend } from './storage';

export interface LibraryEntry {
  id: string;
  name: string;
  savedAt: number;
  bodies: number;
  data: string;
}

export class Persistence {
  private timer = 0;
  private lastSaved = -1;
  private storage: StorageBackend | null = null;
  // -- DT: scenes live in IndexedDB (src/app/storage); the sync API below reads this cache, filled by init() --
  private autosave: string | null = null;
  private libraryCache: LibraryEntry[] = [];
  private writes: Promise<void> = Promise.resolve();
  onError: ((msg: string) => void) | null = null;
  onSaved: (() => void) | null = null;
  // -- DT-13: further listeners (folder sync) that run after each successful autosave --
  private saveListeners = new Set<() => void>();
  addSaveListener(fn: () => void): () => void {
    this.saveListeners.add(fn);
    return () => this.saveListeners.delete(fn);
  }

  constructor(private store: SceneStore) {
    store.on('change', () => this.schedule());
    store.on('meta', () => this.schedule());
    window.addEventListener('beforeunload', () => this.saveNow());
  }

  /** Opens the storage layer (migrating old localStorage data) and loads the autosave and the library. Call once, before `loadAutosave()`. */
  async init(): Promise<{ degraded: boolean; warning: string | null }> {
    const status = await getStorageStatus();
    this.storage = status.backend;
    this.autosave = (await this.storage.get<string>('meta', 'autosave')) ?? null;
    const items = await this.storage.list<LibraryEntry>('scenes');
    this.libraryCache = items.map((i) => i.value).sort((a, b) => b.savedAt - a.savedAt);
    return { degraded: status.degraded, warning: status.warning };
  }

  /** Resolves when every queued storage write has finished (used by tests and the crash-recovery code). */
  flush(): Promise<void> {
    return this.writes;
  }

  private write(op: (s: StorageBackend) => Promise<void>, failMsg: string): void {
    this.writes = this.writes
      .then(async () => {
        if (this.storage) await op(this.storage);
      })
      .catch((e: unknown) =>
        this.onError?.(e instanceof StorageError && e.code === 'quota' ? failMsg : (e as Error).message),
      );
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.saveNow(), 900);
  }

  saveNow(): void {
    if (this.store.revision === this.lastSaved) return;
    const json = serializeDocument(this.store.toDocument());
    this.autosave = json;
    this.lastSaved = this.store.revision;
    this.write(async (s) => {
      await s.put('meta', 'autosave', json);
      this.onSaved?.();
      for (const fn of this.saveListeners) fn();
    }, 'Autosave failed — browser storage is full. Free space in Settings → Storage or export the scene to keep it.');
  }

  loadAutosave(): SceneDocument | null {
    if (!this.autosave) return null;
    try {
      return parseDocument(this.autosave);
    } catch {
      return null;
    }
  }

  // ---- library -----------------------------------------------------------------------------

  library(): LibraryEntry[] {
    return this.libraryCache;
  }

  saveToLibrary(): LibraryEntry | null {
    const doc = this.store.toDocument();
    const list = this.libraryCache;
    const existing = list.find((e) => e.name === doc.name);
    const entry: LibraryEntry = {
      id: existing?.id ?? `s_${Date.now().toString(36)}`,
      name: doc.name,
      savedAt: Date.now(),
      bodies: doc.entities.filter((e) => e.kind === 'body').length,
      data: serializeDocument(doc),
    };
    this.libraryCache = existing ? list.map((e) => (e.id === existing.id ? entry : e)) : [entry, ...list];
    this.write((s) => s.put('scenes', entry.id, entry), 'Could not save — browser storage is full.');
    return entry;
  }

  deleteFromLibrary(id: string): void {
    this.libraryCache = this.libraryCache.filter((e) => e.id !== id);
    this.write((s) => s.delete('scenes', id), 'Could not delete the scene.');
  }

  openFromLibrary(id: string): SceneDocument | null {
    const e = this.libraryCache.find((x) => x.id === id);
    if (!e) return null;
    try {
      return parseDocument(e.data);
    } catch {
      return null;
    }
  }

  // ---- files -------------------------------------------------------------------------------

  exportFile(): void {
    const doc = this.store.toDocument();
    // Same writer as the autosave and share links, so unreferenced assets are left out of the file too.
    const blob = new Blob([serializeDocument(doc, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(doc.name || 'scene').replace(/[^\w-]+/g, '_')}.physicslab.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async importFile(file: File, report?: LoadReport): Promise<SceneDocument> {
    return parseDocument(await file.text(), report);
  }

  // ---- share links ---------------------------------------------------------------------------

  /** Builds the share link (compact v2 format, DT-20) with its size figures. Never throws for size: check `tooLarge`. */
  shareInfo(): Promise<ShareResult> {
    return buildShare(this.store.toDocument(), location.href);
  }

  async shareLink(): Promise<string> {
    const r = await this.shareInfo();
    if (r.tooLarge) throw tooLargeError(r);
    return r.url;
  }

  /**
   * The scene a share link carries, or null when the hash holds no scene. A link that is there but cannot be
   * opened throws a `SceneFormatError` whose message says why (damaged, saved by a newer version, too large …).
   */
  static fromHash(hash: string, report?: LoadReport): Promise<SceneDocument | null> {
    return parseShareHash(hash, report);
  }
}

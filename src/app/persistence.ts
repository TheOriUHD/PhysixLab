/**
 * Scene persistence: debounced autosave, a named scene library (localStorage), JSON
 * import / export and shareable links (the scene is deflated into the URL hash, so
 * sharing needs no server).
 */
import { SceneFormatError, type LoadReport } from '../model/errors';
import { LIMITS } from '../model/limits';
import { parseDocument, serializeDocument } from '../model/serialize';
import type { SceneStore } from '../model/store';
import type { SceneDocument } from '../model/types';

const AUTOSAVE_KEY = 'physicslab:autosave:v1';
const LIBRARY_KEY = 'physicslab:library:v1';

export interface LibraryEntry {
  id: string;
  name: string;
  savedAt: number;
  bodies: number;
  data: string;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export class Persistence {
  private timer = 0;
  private lastSaved = -1;
  onError: ((msg: string) => void) | null = null;
  onSaved: (() => void) | null = null;

  constructor(private store: SceneStore) {
    store.on('change', () => this.schedule());
    store.on('meta', () => this.schedule());
    window.addEventListener('beforeunload', () => this.saveNow());
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.saveNow(), 900);
  }

  saveNow(): void {
    if (this.store.revision === this.lastSaved) return;
    const ok = safeSet(AUTOSAVE_KEY, serializeDocument(this.store.toDocument()));
    if (ok) {
      this.lastSaved = this.store.revision;
      this.onSaved?.();
    } else this.onError?.('Autosave failed — browser storage is full or unavailable. Export the scene to keep it.');
  }

  loadAutosave(): SceneDocument | null {
    const raw = safeGet(AUTOSAVE_KEY);
    if (!raw) return null;
    try {
      return parseDocument(raw);
    } catch {
      return null;
    }
  }

  // ---- library -----------------------------------------------------------------------------

  library(): LibraryEntry[] {
    const raw = safeGet(LIBRARY_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as LibraryEntry[];
    } catch {
      return [];
    }
  }

  saveToLibrary(): LibraryEntry | null {
    const doc = this.store.toDocument();
    const list = this.library();
    const existing = list.find((e) => e.name === doc.name);
    const entry: LibraryEntry = {
      id: existing?.id ?? `s_${Date.now().toString(36)}`,
      name: doc.name,
      savedAt: Date.now(),
      bodies: doc.entities.filter((e) => e.kind === 'body').length,
      data: serializeDocument(doc),
    };
    const next = existing ? list.map((e) => (e.id === existing.id ? entry : e)) : [entry, ...list];
    if (!safeSet(LIBRARY_KEY, JSON.stringify(next))) {
      this.onError?.('Could not save — browser storage is full.');
      return null;
    }
    return entry;
  }

  deleteFromLibrary(id: string): void {
    safeSet(LIBRARY_KEY, JSON.stringify(this.library().filter((e) => e.id !== id)));
  }

  openFromLibrary(id: string): SceneDocument | null {
    const e = this.library().find((x) => x.id === id);
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

  async shareLink(): Promise<string> {
    const json = serializeDocument(this.store.toDocument());
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = new URL(location.href);
    url.hash = `scene=${b64}`;
    const link = url.toString();
    if (link.length > LIMITS.maxShareLinkChars) {
      throw new SceneFormatError(
        'limit',
        `This scene is too large for a share link (${Math.round(link.length / 1000)} kB; the limit is ${Math.round(LIMITS.maxShareLinkChars / 1000)} kB). Export it as a file instead.`,
      );
    }
    return link;
  }

  static async fromHash(hash: string, report?: LoadReport): Promise<SceneDocument | null> {
    const m = /scene=([A-Za-z0-9_-]+)/.exec(hash);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return parseDocument(await new Response(stream).text(), report);
    } catch {
      return null;
    }
  }
}

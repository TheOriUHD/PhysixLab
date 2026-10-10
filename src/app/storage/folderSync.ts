/**
 * Folder sync (DT-13) — the honest "cloud save": the user picks a folder (File System Access API) — typically one
 * their Dropbox / Google Drive / iCloud / OneDrive desktop client syncs — and scenes are written to it as
 * `<name>.physixlab.json`. There is no file-watcher API in browsers, so external changes are found by polling the
 * files' modification times. Everything here talks to a minimal directory interface so it is testable without a browser.
 */
import { LEGACY_NAME } from '../../model/legacy';
import { parseDocument, serializeDocument } from '../../model/serialize';
import type { SceneDocument } from '../../model/types';

export interface FileLike {
  lastModified: number;
  text(): Promise<string>;
}
export interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
export interface FileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<FileLike>;
  createWritable(): Promise<WritableLike>;
}
export interface DirHandleLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FileHandleLike | { kind: 'directory'; name: string }>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
}

export const FILE_SUFFIX = '.physixlab.json';
/** Scenes saved before the rename (`.physicslab.json`) are still listed and opened; they are saved under the new suffix. */
export const LEGACY_FILE_SUFFIX = `.${LEGACY_NAME}.json`;

export function fileNameFor(sceneName: string): string {
  const base = sceneName
    .replace(/[^\w\- ]+/g, '_')
    .trim()
    .slice(0, 80);
  return `${base || 'scene'}${FILE_SUFFIX}`;
}

export function folderSyncSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

export const UNSUPPORTED_MESSAGE =
  'Folder sync needs the File System Access API (Chrome, Edge, Opera and other Chromium browsers). In this browser use File → Export scene file and put the file in your Dropbox / Drive / iCloud folder yourself.';

export interface FolderFileInfo {
  name: string;
  lastModified: number;
}

export type SyncEvent =
  | { kind: 'saved'; file: string }
  | { kind: 'conflict'; file: string; diskText: string; diskModified: number }
  | { kind: 'error'; message: string };

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return `${h.toString(36)}:${s.length}`;
}

export class FolderSync {
  /** What we last wrote or read per file: the content hash and the modification time the disk reported. */
  private known = new Map<string, { hash: string; modified: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Disk hash per file that was already reported as a conflict, so a poll does not repeat it. */
  private reported = new Map<string, string>();
  onEvent: ((e: SyncEvent) => void) | null = null;
  autoSave = true;

  constructor(readonly dir: DirHandleLike) {}

  async listScenes(): Promise<FolderFileInfo[]> {
    const out: FolderFileInfo[] = [];
    for await (const e of this.dir.values()) {
      if (e.kind !== 'file' || !(e.name.endsWith(FILE_SUFFIX) || e.name.endsWith(LEGACY_FILE_SUFFIX))) continue;
      out.push({ name: e.name, lastModified: (await e.getFile()).lastModified });
    }
    return out.sort((a, b) => b.lastModified - a.lastModified);
  }

  async readScene(file: string): Promise<SceneDocument> {
    const h = await this.dir.getFileHandle(file);
    const f = await h.getFile();
    const text = await f.text();
    this.known.set(file, { hash: hash(text), modified: f.lastModified });
    return parseDocument(text);
  }

  /** Writes the scene unless the file changed on disk since we last saw it (then reports a conflict and does not write). */
  async saveScene(doc: SceneDocument, opts: { overwrite?: boolean } = {}): Promise<'saved' | 'conflict'> {
    const file = fileNameFor(doc.name);
    const text = serializeDocument(doc, 1);
    const prior = this.known.get(file);
    if (!opts.overwrite) {
      const disk = await this.peek(file);
      if (disk && (!prior || disk.hash !== prior.hash) && disk.hash !== hash(text)) {
        this.reported.set(file, disk.hash);
        this.onEvent?.({ kind: 'conflict', file, diskText: disk.text, diskModified: disk.modified });
        return 'conflict';
      }
    }
    if (prior?.hash === hash(text) && !opts.overwrite) return 'saved';
    const handle = await this.dir.getFileHandle(file, { create: true });
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
    this.known.set(file, { hash: hash(text), modified: (await handle.getFile()).lastModified });
    this.onEvent?.({ kind: 'saved', file });
    return 'saved';
  }

  private async peek(file: string): Promise<{ text: string; hash: string; modified: number } | null> {
    try {
      const f = await (await this.dir.getFileHandle(file)).getFile();
      const text = await f.text();
      return { text, hash: hash(text), modified: f.lastModified };
    } catch {
      return null; // not there yet
    }
  }

  /** Files whose content on disk differs from what we last wrote / read (changed by another device or program). */
  async externalChanges(): Promise<string[]> {
    const changed: string[] = [];
    for (const [file, k] of this.known) {
      const disk = await this.peek(file);
      if (disk && disk.hash !== k.hash) changed.push(file);
    }
    return changed;
  }

  /** Polls for external changes of the files we know about and reports each as a conflict event. */
  startWatching(intervalMs = 3000): void {
    this.stopWatching();
    this.timer = setInterval(() => {
      if (this.polling) return; // slow cloud-backed disks: never overlap polls
      this.polling = true;
      void (async () => {
        try {
          for (const file of await this.externalChanges()) {
            const disk = await this.peek(file);
            if (!disk || this.reported.get(file) === disk.hash) continue;
            // `known` stays as it was until the user decides (`acknowledge`), so a later save cannot overwrite silently.
            this.reported.set(file, disk.hash);
            this.onEvent?.({ kind: 'conflict', file, diskText: disk.text, diskModified: disk.modified });
          }
        } catch (e) {
          this.onEvent?.({ kind: 'error', message: (e as Error).message });
        } finally {
          this.polling = false;
        }
      })();
    }, intervalMs);
  }

  /** The user took the version on disk (or decided to keep going without it): treat it as the known state. */
  acknowledge(file: string, diskText: string): void {
    this.known.set(file, { hash: hash(diskText), modified: Date.now() });
    this.reported.delete(file);
  }

  stopWatching(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

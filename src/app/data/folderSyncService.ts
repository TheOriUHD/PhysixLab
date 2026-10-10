/**
 * Folder sync wiring (DT-13): the chosen directory handle lives in IndexedDB (`meta/folder-handle`), scenes are written
 * after each autosave, and external changes surface as a three-way choice. Browser API calls are isolated here;
 * the logic is `storage/folderSync.ts`.
 */
import { parseDocument } from '../../model/serialize';
import type { App } from '../app';
import { getStorage } from '../storage';
import {
  FolderSync,
  fileNameFor,
  folderSyncSupported,
  type DirHandleLike,
  type SyncEvent,
} from '../storage/folderSync';

type PermissionedDir = DirHandleLike & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

export type FolderStatus = 'unsupported' | 'disconnected' | 'needs-permission' | 'connected';

let service: FolderSyncService | null = null;
export const folderSyncService = (): FolderSyncService | null => service;

export class FolderSyncService {
  sync: FolderSync | null = null;
  status: FolderStatus = folderSyncSupported() ? 'disconnected' : 'unsupported';
  folderName = '';
  lastSavedAt = 0;
  lastError = '';
  private pendingHandle: PermissionedDir | null = null;
  private unlisten: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  onChange: (() => void) | null = null;

  constructor(private app: App) {}

  /** Reads the remembered folder; connects at once when permission is still granted, otherwise waits for a click. */
  async restore(): Promise<void> {
    if (this.status === 'unsupported') return;
    const handle = await (await getStorage()).get<PermissionedDir>('meta', 'folder-handle');
    if (!handle) return;
    this.pendingHandle = handle;
    this.folderName = handle.name;
    const perm = (await handle.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt';
    if (perm === 'granted') this.attach(handle);
    else this.setStatus('needs-permission');
  }

  /** Must run from a user gesture (a click). */
  async connect(): Promise<void> {
    const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<PermissionedDir> })
      .showDirectoryPicker;
    const handle = await pick({ id: 'physicslab-sync', mode: 'readwrite' });
    await (await getStorage()).put('meta', 'folder-handle', handle);
    this.attach(handle);
  }

  /** Must run from a user gesture. */
  async reconnect(): Promise<void> {
    const h = this.pendingHandle;
    if (!h) return this.connect();
    if ((await h.requestPermission?.({ mode: 'readwrite' })) === 'granted') this.attach(h);
    else this.lastError = 'Permission to use the folder was not granted.';
    this.onChange?.();
  }

  async disconnect(): Promise<void> {
    this.detach();
    await (await getStorage()).delete('meta', 'folder-handle');
    this.pendingHandle = null;
    this.folderName = '';
    this.setStatus('disconnected');
  }

  private attach(handle: PermissionedDir): void {
    this.detach();
    this.folderName = handle.name;
    const sync = new FolderSync(handle);
    sync.onEvent = (e) => this.handle(e);
    this.sync = sync;
    this.unlisten = this.app.persistence.addSaveListener(() => this.schedule());
    sync.startWatching();
    this.setStatus('connected');
    this.schedule();
  }

  private detach(): void {
    this.sync?.stopWatching();
    this.sync = null;
    this.unlisten?.();
    this.unlisten = null;
    if (this.timer) clearTimeout(this.timer);
  }

  private setStatus(s: FolderStatus): void {
    this.status = s;
    this.onChange?.();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.saveNow(), 1500);
  }

  async saveNow(overwrite = false): Promise<void> {
    const sync = this.sync;
    if (!sync || !sync.autoSave) return;
    try {
      if ((await sync.saveScene(this.app.store.toDocument(), { overwrite })) === 'saved') {
        this.lastSavedAt = Date.now();
        this.lastError = '';
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      this.app.toast(`Folder sync could not save: ${this.lastError}`, 'warn');
    }
    this.onChange?.();
  }

  private handle(e: SyncEvent): void {
    if (e.kind === 'error') {
      this.lastError = e.message;
      this.onChange?.();
    } else if (e.kind === 'conflict') {
      void this.resolveConflict(e);
    }
  }

  private conflictOpen = false;

  private async resolveConflict(e: Extract<SyncEvent, { kind: 'conflict' }>): Promise<void> {
    if (this.conflictOpen) return;
    this.conflictOpen = true;
    try {
      const { chooseConflict } = await import('../../ui/data/conflictDialog');
      const choice = await chooseConflict(e.file, new Date(e.diskModified));
      const sync = this.sync;
      if (!sync) return;
      if (choice === 'disk') {
        this.app.loadDocument(parseDocument(e.diskText), 'frame');
        this.app.toast(`Loaded “${e.file}” from the folder`, 'success');
      } else if (choice === 'both') {
        // keep the disk version as a copy next to the file, then write ours over the original
        const doc = parseDocument(e.diskText);
        const copy = { ...doc, name: `${doc.name} (from folder ${new Date(e.diskModified).toLocaleTimeString()})` };
        await sync.saveScene(copy, { overwrite: true });
        await this.saveNow(true);
        this.app.toast(`Kept both: the other version is saved as “${fileNameFor(copy.name)}”`, 'success');
      } else if (choice === 'mine') {
        await this.saveNow(true);
      }
    } catch (err) {
      this.app.toast(`Folder sync: ${(err as Error).message}`, 'error');
    } finally {
      this.conflictOpen = false;
    }
  }
}

export function ensureFolderSync(app: App): FolderSyncService {
  service ??= new FolderSyncService(app);
  return service;
}

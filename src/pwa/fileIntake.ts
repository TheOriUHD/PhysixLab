// -- DT-40: open `.physicslab.json` files via the OS (file_handlers + launchQueue) and Web Share Target --
import type { App } from '../app/app';
import { importDocument } from '../ui/sceneActions';

interface LaunchParams {
  files: { getFile(): Promise<File> }[];
}
interface LaunchQueue {
  setConsumer(fn: (params: LaunchParams) => void | Promise<void>): void;
}

/** The cache the service worker drops a shared file into (see scripts/vite/sw.template.cjs). */
const SHARE_CACHE = 'pl-share';
const SHARED_FILE = 'shared-scene.json';

/**
 * Take the scene file the service worker stashed after a Web Share Target POST (the app was opened with
 * `?shared=1`). Returns null when there is none. The entry is removed so a reload does not import it again.
 */
export async function takeSharedScene(): Promise<File | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const key = new URL(SHARED_FILE, document.baseURI).href;
    const res = await cache.match(key);
    if (!res) return null;
    await cache.delete(key);
    const raw = res.headers.get('x-file-name');
    const name = raw ? decodeURIComponent(raw) : 'shared.physicslab.json';
    return new File([await res.blob()], name, { type: 'application/json' });
  } catch {
    return null;
  }
}

/** Wire the launch queue (OS "Open with PhysicsLab") and the share target to the normal import path. */
export function wireFileIntake(app: App): void {
  const lq = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
  if (lq) {
    lq.setConsumer(async (params) => {
      // One document at a time: importing replaces the scene (after the usual "replace?" confirmation).
      const handle = params.files[0];
      if (handle) await importDocument(app, await handle.getFile());
    });
  }
  const url = new URL(location.href);
  if (url.searchParams.has('shared')) {
    url.searchParams.delete('shared');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    void takeSharedScene().then((file) => {
      if (file) return importDocument(app, file);
      app.toast('No shared scene file was received.', 'warn');
    });
  }
}

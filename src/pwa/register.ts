// -- DT-40: service-worker registration and update detection (production builds only) --
/**
 * Registers `sw.js` (written next to index.html by scripts/vite/pwa.ts) and reports two things to the UI:
 *  - `onUpdate(apply)`: a new version finished installing and waits; `apply()` activates it and reloads.
 *    Nothing ever reloads by itself: the user chooses when (their scene may have unsaved edits).
 *  - `onOfflineReady()`: the first install finished precaching, so the app now starts without a network.
 * Dev server, Vitest and browsers without service workers are no-ops (the app works the same, just online-only).
 */

export interface PwaCallbacks {
  onUpdate: (apply: () => void) => void;
  onOfflineReady: () => void;
}

const UPDATE_CHECK_MS = 60 * 60 * 1000;

export function serviceWorkerSupported(): boolean {
  return import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export function registerServiceWorker(cb: PwaCallbacks): void {
  if (!serviceWorkerSupported()) return;
  const sw = navigator.serviceWorker;
  let reloading = false;
  let hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    // The first install claims the page (offline readiness); only an update the user asked for reloads it.
    if (!hadController) {
      hadController = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  const offer = (worker: ServiceWorker): void =>
    cb.onUpdate(() => {
      reloading = false;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });

  const start = (): void => {
    sw.register(new URL('sw.js', document.baseURI).href)
      .then((reg) => {
        if (reg.waiting && sw.controller) offer(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          if (!next) return;
          next.addEventListener('statechange', () => {
            if (next.state !== 'installed') return;
            if (sw.controller) offer(next);
            else cb.onOfflineReady();
          });
        });
        setInterval(() => void reg.update().catch(() => undefined), UPDATE_CHECK_MS);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
        });
      })
      .catch((e: unknown) => console.warn('PhysicsLab: service worker registration failed', e));
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

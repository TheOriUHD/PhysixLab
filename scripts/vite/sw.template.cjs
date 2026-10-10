/**
 * DT-40: PhysicsLab service worker (hand-written, no dependencies). This file is a TEMPLATE: the Vite plugin in
 * scripts/vite/pwa.ts replaces the `BUILD` block below with the build's version and precache list and writes the
 * result to dist/sw.js. It is a classic script (not a module) so every browser can register it.
 *
 * Strategies
 *   precached asset  cache-first (hashed files never change; icons / manifest change only with a new version)
 *   navigation       network-first with a 3.5 s timeout, falling back to the precached index.html — so an online
 *                    visit always sees the newest deployment and an offline one still boots
 *   other same-origin GET in scope  network-first, falling back to whatever was cached
 *   POST <scope>share-target        Web Share Target: stash the shared scene file, redirect to ./?shared=1
 *   everything else  untouched (cross-origin, non-GET, out of scope)
 * Install precaches everything in one transaction (a failed download fails the install, so a half-cached
 * version never activates). A new version waits until the page asks for it (`SKIP_WAITING`, from the "Reload"
 * button): the app is never swapped under the user mid-edit. Activate deletes the caches of older versions.
 *
 * The pure routing / naming helpers are exported for the Vitest unit tests (tests/pwa.test.ts) when loaded as a
 * CommonJS module; in a worker the listeners at the bottom are installed instead.
 */
'use strict';

/*PL:BEGIN*/ const BUILD = { version: 'dev', precache: [] }; /*PL:END*/

const CACHE_PREFIX = 'pl-v';
const SHARE_CACHE = 'pl-share';
const SHARE_PATH = 'share-target';
const SHARED_FILE = 'shared-scene.json';
const NAV_TIMEOUT_MS = 3500;

const cacheName = (version) => CACHE_PREFIX + version;
/** Caches this worker owns but no longer needs (older versions). The share inbox is never stale. */
const isStaleCache = (name, version) => name.startsWith(CACHE_PREFIX) && name !== cacheName(version);

/** Absolute URL of a precache entry relative to the worker scope, without query / hash. */
const precacheUrl = (rel, scope) => new URL(rel, scope).href;

/** The set of absolute precached URLs (build once per worker start, not per request). */
const precacheSet = (precache, scope) => new Set(precache.map((p) => precacheUrl(p, scope)));

/**
 * Decide how to answer a request.
 * @param {{ url: string, method: string, mode?: string }} req
 * @param {string} scopeHref  the registration scope, e.g. https://host/sub/
 * @param {Set<string>} precached  from precacheSet()
 * @returns {'ignore' | 'share' | 'navigate' | 'cache-first' | 'network-first'}
 */
function routeRequest(req, scopeHref, precached) {
  const url = new URL(req.url);
  const scope = new URL(scopeHref);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return 'ignore';
  if (req.method === 'POST') return url.pathname === scope.pathname + SHARE_PATH ? 'share' : 'ignore';
  if (req.method !== 'GET') return 'ignore';
  if (req.mode === 'navigate') return 'navigate';
  return precached.has(url.origin + url.pathname) ? 'cache-first' : 'network-first';
}

const api = {
  BUILD,
  cacheName,
  isStaleCache,
  precacheUrl,
  precacheSet,
  routeRequest,
  SHARE_CACHE,
  SHARE_PATH,
  SHARED_FILE,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  const scopeUrl = () => self.registration.scope;
  const precached = precacheSet(BUILD.precache, self.registration.scope);
  const indexUrl = () => new URL('index.html', scopeUrl()).href;

  self.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(cacheName(BUILD.version));
        await Promise.all(
          BUILD.precache.map(async (rel) => {
            const url = precacheUrl(rel, scopeUrl());
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (!res.ok) throw new Error(`precache ${rel}: HTTP ${res.status}`);
            await cache.put(url, res);
          }),
        );
      })(),
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        for (const name of await caches.keys()) if (isStaleCache(name, BUILD.version)) await caches.delete(name);
        await self.clients.claim();
      })(),
    );
  });

  self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting();
  });

  const fromCache = async (request) => {
    const cache = await caches.open(cacheName(BUILD.version));
    return (await cache.match(request, { ignoreSearch: true })) || undefined;
  };

  const networkFirst = async (request, fallbackUrl, timeoutMs) => {
    try {
      const net = fetch(request);
      const res = timeoutMs
        ? await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))])
        : await net;
      if (!timeoutMs && res.ok && res.type === 'basic') {
        const copy = res.clone();
        void caches.open(cacheName(BUILD.version)).then((c) => c.put(request, copy));
      }
      return res;
    } catch (err) {
      const hit = (await fromCache(request)) || (fallbackUrl ? await fromCache(fallbackUrl) : undefined);
      if (hit) return hit;
      throw err;
    }
  };

  const cacheFirst = async (request) => {
    const hit = await fromCache(request);
    if (hit) return hit;
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      void caches.open(cacheName(BUILD.version)).then((c) => c.put(request, copy));
    }
    return res;
  };

  const handleShare = async (request) => {
    try {
      const file = (await request.formData()).get('scene');
      if (file && typeof file === 'object' && 'name' in file) {
        const cache = await caches.open(SHARE_CACHE);
        await cache.put(
          new URL(SHARED_FILE, scopeUrl()).href,
          new Response(file, { headers: { 'x-file-name': encodeURIComponent(file.name) } }),
        );
      }
    } catch {
      /* an unreadable share just opens the app */
    }
    return Response.redirect(new URL('./?shared=1', scopeUrl()).href, 303);
  };

  self.addEventListener('fetch', (event) => {
    const { request } = event;
    const kind = routeRequest(request, scopeUrl(), precached);
    if (kind === 'ignore') return;
    if (kind === 'share') event.respondWith(handleShare(request));
    else if (kind === 'navigate') event.respondWith(networkFirst(request, indexUrl(), NAV_TIMEOUT_MS));
    else if (kind === 'cache-first') event.respondWith(cacheFirst(request));
    else event.respondWith(networkFirst(request, undefined, 0));
  });
}

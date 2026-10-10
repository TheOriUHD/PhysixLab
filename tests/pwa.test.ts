// DT-40: precache-manifest generation and the service worker's routing / cache-naming logic.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildPrecache, isPrecachable, renderServiceWorker } from '../scripts/vite/pwaPrecache';

interface SwApi {
  BUILD: { version: string; precache: string[] };
  cacheName: (v: string) => string;
  isStaleCache: (name: string, v: string) => boolean;
  precacheUrl: (rel: string, scope: string) => string;
  precacheSet: (p: string[], scope: string) => Set<string>;
  routeRequest: (req: { url: string; method: string; mode?: string }, scope: string, set: Set<string>) => string;
}
const require = createRequire(import.meta.url);
const sw = require('../scripts/vite/sw.template.cjs') as SwApi;
const templatePath = new URL('../scripts/vite/sw.template.cjs', import.meta.url);

const enc = (s: string) => new TextEncoder().encode(s);
const files = [
  { path: 'index.html', data: enc('<html>') },
  { path: 'assets/app-abc.js', data: enc('app') },
  { path: 'assets/rapier_wasm3d_bg-123.wasm', data: enc('wasm') },
  { path: 'assets/app-abc.js.map', data: enc('map') },
  { path: 'sw.js', data: enc('old worker') },
];

describe('precache manifest', () => {
  it('lists every dist file except the worker itself and source maps, sorted', () => {
    const p = buildPrecache(files);
    expect(p.urls).toEqual(['assets/app-abc.js', 'assets/rapier_wasm3d_bg-123.wasm', 'index.html']);
    expect(isPrecachable('sw.js')).toBe(false);
    expect(isPrecachable('icons/icon-192.png')).toBe(true);
  });

  it('has a stable content-derived version that ignores input order and the old sw.js', () => {
    const a = buildPrecache(files);
    const b = buildPrecache([...files].reverse().map((f) => (f.path === 'sw.js' ? { ...f, data: enc('x') } : f)));
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
    expect(b.version).toBe(a.version);
  });

  it('changes version when a file changes or is renamed', () => {
    const base = buildPrecache(files).version;
    const edited = files.map((f) => (f.path === 'assets/app-abc.js' ? { ...f, data: enc('app2') } : f));
    const renamed = files.map((f) => (f.path === 'assets/app-abc.js' ? { ...f, path: 'assets/app-def.js' } : f));
    expect(buildPrecache(edited).version).not.toBe(base);
    expect(buildPrecache(renamed).version).not.toBe(base);
  });

  it('normalises Windows separators and leading ./', () => {
    expect(buildPrecache([{ path: '.\\assets\\a.js', data: enc('a') }]).urls).toEqual(['assets/a.js']);
  });

  it('renders the template with the build block replaced and still valid JavaScript', () => {
    const template = readFileSync(templatePath, 'utf8');
    const out = renderServiceWorker(template, { version: 'v123', urls: ['index.html', 'assets/a.js'] });
    expect(out).toContain('"version":"v123"');
    expect(out).not.toContain('PL:BEGIN');
    expect(() => new vm.Script(out)).not.toThrow();
    expect(() => renderServiceWorker('no block', { version: 'x', urls: [] })).toThrow();
  });
});

describe('service worker routing', () => {
  const scope = 'https://example.com/physicslab/';
  const set = sw.precacheSet(['index.html', 'assets/app-abc.js', 'assets/w.wasm'], scope);
  const route = (url: string, method = 'GET', mode?: string) => sw.routeRequest({ url, method, mode }, scope, set);

  it('serves precached assets cache-first (query strings ignored)', () => {
    expect(route(scope + 'assets/app-abc.js')).toBe('cache-first');
    expect(route(scope + 'assets/w.wasm?x=1')).toBe('cache-first');
  });
  it('answers navigations network-first (with the index fallback in the worker)', () => {
    expect(route(scope + '?scene=car', 'GET', 'navigate')).toBe('navigate');
    expect(route(scope, 'GET', 'navigate')).toBe('navigate');
  });
  it('treats other same-origin GETs as network-first', () => {
    expect(route(scope + 'api/thing.json')).toBe('network-first');
  });
  it('ignores cross-origin, out-of-scope and non-GET requests', () => {
    expect(route('https://cdn.example.org/lib.js')).toBe('ignore');
    expect(route('https://example.com/other/app.js')).toBe('ignore');
    expect(route(scope + 'assets/app-abc.js', 'PUT')).toBe('ignore');
    expect(route(scope + 'anything', 'POST')).toBe('ignore');
  });
  it('routes only POST <scope>share-target to the share handler', () => {
    expect(route(scope + 'share-target', 'POST')).toBe('share');
    expect(route(scope + 'share-target', 'GET')).toBe('network-first');
  });
  it('resolves precache URLs against the scope, so a sub-path deployment works', () => {
    expect(sw.precacheUrl('assets/a.js', scope)).toBe('https://example.com/physicslab/assets/a.js');
    expect(sw.precacheUrl('index.html', 'https://x.io/')).toBe('https://x.io/index.html');
  });
});

describe('service worker cache naming', () => {
  it('deletes only older versions of its own caches', () => {
    expect(sw.cacheName('abc')).toBe('pl-vabc');
    expect(sw.isStaleCache('pl-vold', 'abc')).toBe(true);
    expect(sw.isStaleCache('pl-vabc', 'abc')).toBe(false);
    expect(sw.isStaleCache('pl-share', 'abc')).toBe(false);
    expect(sw.isStaleCache('someone-elses', 'abc')).toBe(false);
  });
});

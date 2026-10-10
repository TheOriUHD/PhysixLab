/**
 * DT-40: pure helpers behind the PWA build step (kept free of Vite types so Vitest can test them directly).
 *  - `buildPrecache`   list of files to precache + a content-derived version string
 *  - `renderServiceWorker`  fill the scripts/vite/sw.template.cjs `BUILD` block
 */
import { createHash } from 'node:crypto';

export interface DistFile {
  /** Path relative to the output directory, forward slashes. */
  path: string;
  data: Uint8Array;
}

export interface Precache {
  /** 12 hex chars; changes whenever any precached file's name or bytes change. */
  version: string;
  /** Sorted paths relative to the scope (the output directory). */
  urls: string[];
}

/** Files that must not be precached: the worker itself, source maps and OS litter. */
export function isPrecachable(p: string): boolean {
  return p !== 'sw.js' && !p.endsWith('.map') && !/(^|\/)\.DS_Store$/.test(p) && !/(^|\/)Thumbs\.db$/i.test(p);
}

export function buildPrecache(files: readonly DistFile[]): Precache {
  const kept = files
    .map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\.?\//, '') }))
    .filter((f) => isPrecachable(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const f of kept) {
    h.update(f.path);
    h.update('\0');
    h.update(createHash('sha256').update(f.data).digest());
  }
  return { version: h.digest('hex').slice(0, 12), urls: kept.map((f) => f.path) };
}

const BLOCK = /\/\*PL:BEGIN\*\/[\s\S]*?\/\*PL:END\*\//;

/** Replace the `BUILD` block of the template with this build's version and precache list. */
export function renderServiceWorker(template: string, pre: Precache): string {
  if (!BLOCK.test(template)) throw new Error('sw template: PL:BEGIN / PL:END block not found');
  const block = `const BUILD = ${JSON.stringify({ version: pre.version, precache: pre.urls })};`;
  return template.replace(BLOCK, () => block);
}

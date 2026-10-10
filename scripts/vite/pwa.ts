/**
 * DT-40: after the production build, write dist/sw.js — the hand-written service worker
 * (scripts/vite/sw.template.cjs) with a versioned precache list of every file in dist/ (entry, lazy chunks,
 * physics worker, Rapier wasm, CSS, icons, manifest, index.html). Build only: the dev server and Vitest never
 * get a service worker, and the app only registers one in production builds (src/pwa/register.ts).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { buildPrecache, renderServiceWorker } from './pwaPrecache.ts';
import type { DistFile } from './pwaPrecache.ts';

function walk(dir: string, base = dir): DistFile[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory()
      ? walk(p, base)
      : [{ path: path.relative(base, p).replace(/\\/g, '/'), data: readFileSync(p) }];
  });
}

export function pwa(): Plugin {
  let outDir = '';
  let info: (msg: string) => void = () => undefined;
  return {
    name: 'physixlab:pwa-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      info = (m) => config.logger.info(m);
    },
    closeBundle() {
      if (!outDir) return;
      const template = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'sw.template.cjs'), 'utf8');
      const pre = buildPrecache(walk(outDir));
      writeFileSync(path.join(outDir, 'sw.js'), renderServiceWorker(template, pre));
      info(`pwa: sw.js written — version ${pre.version}, ${pre.urls.length} files precached`);
    },
  };
}

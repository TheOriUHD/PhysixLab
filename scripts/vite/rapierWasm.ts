/**
 * DT-42: serve the Rapier WebAssembly binary as a separate, hashed, cacheable asset.
 *
 * `@dimforge/rapier3d-compat` inlines its 3 MB wasm as a base64 string (≈ 4 MB of JS) and decodes it at start-up.
 * This plugin rewrites that one call in the package's ES build so `init()` fetches the file that ships next to it
 * (`rapier_wasm3d_bg.wasm`) instead. The wasm is then a normal asset: browser-cached, precached by the service
 * worker, compressed by the host, and the worker script shrinks by ~3.5 MB.
 *
 * Applied to the app build, the dev server and the worker bundle; NOT to Vitest (Node keeps the inlined binary).
 * If the package changes shape and the pattern no longer matches, the build fails loudly rather than silently
 * shipping the base64 again.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

const INLINED = /module_or_path:\s*(\w+)\.toByteArray\("[A-Za-z0-9+/=]{1000,}"\)(?:\.buffer)?/;

export function rapierWasm(): Plugin {
  const require = createRequire(import.meta.url);
  const pkgMain = require.resolve('@dimforge/rapier3d-compat'); // …/dist/rapier.cjs
  const dist = path.dirname(pkgMain);
  const wasmFile = path.join(dist, 'rapier_wasm3d_bg.wasm').replace(/\\/g, '/');
  return {
    name: 'physicslab:rapier-wasm-asset',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].replace(/\\/g, '/');
      if (!file.startsWith(dist.replace(/\\/g, '/')) || !file.endsWith('rapier.mjs')) return null;
      if (!INLINED.test(code))
        throw new Error('rapierWasm: inlined wasm pattern not found in @dimforge/rapier3d-compat');
      const out = code.replace(INLINED, () => 'module_or_path:fetch(__rapierWasmUrl)');
      return { code: `import __rapierWasmUrl from ${JSON.stringify(wasmFile + '?url')};\n${out}`, map: null };
    },
  };
}

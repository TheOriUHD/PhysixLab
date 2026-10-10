/**
 * Start-up splash with a real progress bar (build only).
 *
 * `index.html` carries the splash and a small inline loader. For the loader to report *real* download progress it
 * needs to know how many bytes it is waiting for, so this plugin records, at build time, the decoded size of
 * everything the first paint depends on: the entry chunk, every chunk it statically imports, the physics worker and
 * the Rapier wasm. The loader streams those files (counting decoded bytes against the sizes below, which stays
 * correct whatever compression the host applies), then adds the entry script; the files are then already in the
 * HTTP cache, so the module graph starts instantly. The `<script type="module">` and `modulepreload` tags Vite
 * generated for those files are removed, otherwise the browser would download them a second time in parallel.
 *
 * In `vite dev` none of this applies: index.html keeps its module script and the bar follows the app's milestones only.
 */
import type { Plugin } from 'vite';

export interface BootFile {
  /** URL relative to index.html. */
  u: string;
  /** Decoded size in bytes. */
  b: number;
}
export interface BootManifest {
  /** The entry module the loader adds once everything is downloaded. */
  entry: string;
  files: BootFile[];
}

/** The slice of Rollup's bundle this plugin reads (chunks and assets). */
export type BootBundle = Record<
  string,
  {
    type: 'chunk' | 'asset';
    fileName: string;
    code?: string;
    source?: string | Uint8Array;
    isEntry?: boolean;
    imports?: string[];
  }
>;

const WORKER = /(^|\/)sim\.worker-[\w-]+\.js$/;
const WASM = /(^|\/)rapier_wasm3d_bg-[\w-]+\.wasm$/;

const sizeOf = (o: BootBundle[string]): number =>
  o.type === 'chunk'
    ? Buffer.byteLength(o.code ?? '')
    : typeof o.source === 'string'
      ? Buffer.byteLength(o.source)
      : (o.source?.byteLength ?? 0);

/** Everything the first paint needs, with decoded sizes; `null` when the bundle has no entry chunk. */
export function bootManifest(bundle: BootBundle, base = './'): BootManifest | null {
  const entry = Object.values(bundle).find((o) => o.type === 'chunk' && o.isEntry);
  if (!entry) return null;
  const names = new Set<string>();
  const visit = (name: string): void => {
    if (names.has(name) || !bundle[name]) return;
    names.add(name);
    for (const dep of bundle[name].imports ?? []) visit(dep);
  };
  visit(entry.fileName);
  for (const name of Object.keys(bundle)) if (WORKER.test(name) || WASM.test(name)) names.add(name);
  const prefix = base === '' ? './' : base;
  const url = (n: string): string => prefix + n;
  return { entry: url(entry.fileName), files: [...names].map((n) => ({ u: url(n), b: sizeOf(bundle[n]) })) };
}

export const PLACEHOLDER = '<!--boot-manifest-->';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Put the manifest into index.html and drop the tags the loader replaces. Throws if index.html lost its placeholder. */
export function injectBoot(html: string, m: BootManifest): string {
  if (!html.includes(PLACEHOLDER)) throw new Error(`bootSplash: index.html has no ${PLACEHOLDER} placeholder`);
  let out = html.replace(
    PLACEHOLDER,
    () => `<script>window.__BOOT=${JSON.stringify(m).replace(/</g, '\\u003c')}</script>`,
  );
  for (const f of m.files) {
    const href = escapeRe(f.u);
    out = out.replace(new RegExp(`\\s*<link\\b[^>]*rel="modulepreload"[^>]*href="${href}"[^>]*>`, 'g'), '');
  }
  const entry = new RegExp(`\\s*<script\\b[^>]*type="module"[^>]*src="${escapeRe(m.entry)}"[^>]*></script>`);
  if (!entry.test(out)) throw new Error('bootSplash: the entry <script> tag was not found in index.html');
  return out.replace(entry, '');
}

export function bootSplash(): Plugin {
  let base = './';
  return {
    name: 'physixlab:boot-splash',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const manifest = ctx.bundle ? bootManifest(ctx.bundle, base) : null;
        return manifest ? injectBoot(html, manifest) : html;
      },
    },
  };
}

import { describe, expect, it } from 'vitest';
import { PLACEHOLDER, bootManifest, injectBoot, type BootBundle } from '../scripts/vite/bootSplash';

const chunk = (fileName: string, code: string, extra: Partial<BootBundle[string]> = {}): BootBundle[string] => ({
  type: 'chunk',
  fileName,
  code,
  ...extra,
});

const bundle: BootBundle = {
  'assets/index-AAA.js': chunk('assets/index-AAA.js', 'x'.repeat(1000), {
    isEntry: true,
    imports: ['assets/three-BBB.js'],
  }),
  'assets/three-BBB.js': chunk('assets/three-BBB.js', 'y'.repeat(500), { imports: ['assets/math-CCC.js'] }),
  'assets/math-CCC.js': chunk('assets/math-CCC.js', 'é'.repeat(10)), // multi-byte: sizes are bytes, not characters
  'assets/lazy-DDD.js': chunk('assets/lazy-DDD.js', 'z'.repeat(9999)), // not needed for the first paint
  'assets/sim.worker-EEE.js': { type: 'asset', fileName: 'assets/sim.worker-EEE.js', source: 'w'.repeat(300) },
  'assets/rapier_wasm3d_bg-FFF.wasm': {
    type: 'asset',
    fileName: 'assets/rapier_wasm3d_bg-FFF.wasm',
    source: new Uint8Array(4000),
  },
  'assets/index-GGG.css': { type: 'asset', fileName: 'assets/index-GGG.css', source: 'a{}' },
};

describe('start-up splash manifest', () => {
  it('lists the entry, its static imports (transitively), the worker and the wasm, with decoded byte sizes', () => {
    const m = bootManifest(bundle)!;
    expect(m.entry).toBe('./assets/index-AAA.js');
    const sizes = Object.fromEntries(m.files.map((f) => [f.u, f.b]));
    expect(sizes).toEqual({
      './assets/index-AAA.js': 1000,
      './assets/three-BBB.js': 500,
      './assets/math-CCC.js': 20,
      './assets/sim.worker-EEE.js': 300,
      './assets/rapier_wasm3d_bg-FFF.wasm': 4000,
    });
  });

  it('has nothing to say about a bundle without an entry chunk', () => {
    expect(bootManifest({ 'a.js': chunk('a.js', 'x') })).toBeNull();
  });

  it('puts the manifest in the page and removes the tags the loader replaces', () => {
    const m = bootManifest(bundle)!;
    const html = `<head>
    <script type="module" crossorigin src="./assets/index-AAA.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/three-BBB.js">
    <link rel="modulepreload" crossorigin href="./assets/math-CCC.js">
    <link rel="modulepreload" crossorigin href="./assets/lazy-DDD.js">
    <link rel="stylesheet" crossorigin href="./assets/index-GGG.css">
  </head><body>${PLACEHOLDER}</body>`;
    const out = injectBoot(html, m);
    expect(out).toContain('window.__BOOT=');
    expect(out).not.toContain(PLACEHOLDER);
    expect(out).not.toContain('type="module"');
    expect(out).not.toMatch(/<link[^>]*(three-BBB|math-CCC)/);
    // Files the loader does not track keep working as before.
    expect(out).toContain('href="./assets/lazy-DDD.js"');
    expect(out).toContain('index-GGG.css');
    const json = out.match(/window\.__BOOT=(\{.*?\})<\/script>/s)![1];
    expect((JSON.parse(json) as { files: unknown[] }).files).toHaveLength(5);
  });

  it('fails loudly when the page lost its placeholder or the entry tag', () => {
    const m = bootManifest(bundle)!;
    expect(() => injectBoot('<head></head>', m)).toThrow(/placeholder/);
    expect(() => injectBoot(`<head>${PLACEHOLDER}</head>`, m)).toThrow(/entry <script>/);
  });
});

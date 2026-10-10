#!/usr/bin/env node
/**
 * DT-33 launcher: bundles src/cli/entry.ts for Node with Vite's SSR build (cached under node_modules/.cache) and runs it.
 *   npm run cli -- run scene.json --steps 600 --sweep gravity=-1,-9.81 --out result.csv
 */
import { build } from 'vite';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'node_modules', '.cache', 'physixlab-cli');
const logLevel = process.env.CLI_VERBOSE ? 'info' : 'silent';

await build({
  root,
  configFile: false,
  logLevel,
  build: {
    ssr: path.join(root, 'src/cli/entry.ts'),
    outDir,
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'cli.mjs', format: 'es' } },
  },
});
const r = spawnSync(process.execPath, [path.join(outDir, 'cli.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);

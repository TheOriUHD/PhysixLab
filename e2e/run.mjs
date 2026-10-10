/**
 * End-to-end test runner: drives the real application in headless Chromium (software WebGL) with
 * real mouse / keyboard input and asserts on simulation state.
 *
 *   npm run test:e2e                          # starts a Vite dev server automatically
 *   E2E_PORT=5231 npm run test:e2e            # ... on another port (default 5199), e.g. for parallel runs
 *   E2E_URL=http://host:port npm run test:e2e # use an already running server instead
 *   E2E_FILTER=joint npm run test:e2e         # only tests whose name contains "joint" (case-insensitive)
 *   E2E_FILES=api,data,pwa npm run test:e2e   # only these files from e2e/tests (core.mjs always runs first)
 *   E2E_SHOTS=1 npm run test:e2e              # also write screenshots to e2e/out
 *
 * Tests live in e2e/tests/*.mjs. Each file exports `tests`, an array of `{ name, fn }` (see
 * tests/core.mjs and helpers.mjs); the runner discovers every such file, runs core.mjs first and the
 * others in alphabetical order, and exits non-zero if any test fails.
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { chromePath, configure, currentBrowser, ensureServer, outDir, root } from './helpers.mjs';

const testsDir = join(root, 'e2e', 'tests');

/** Import every e2e/tests/*.mjs and collect its `tests` (validated), tagging each with its file. */
async function discover() {
  const files = readdirSync(testsDir)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => !process.env.E2E_FILES || f === 'core.mjs' || process.env.E2E_FILES.split(',').includes(f.replace(/\.mjs$/, '')))
    .sort((a, b) => (a === 'core.mjs' ? -1 : b === 'core.mjs' ? 1 : a.localeCompare(b)));
  const all = [];
  const seen = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(join(testsDir, file)).href);
    if (!Array.isArray(mod.tests))
      throw new Error(`e2e/tests/${file} must export \`tests\` (an array of { name, fn })`);
    for (const t of mod.tests) {
      if (!t || typeof t.name !== 'string' || typeof t.fn !== 'function')
        throw new Error(`e2e/tests/${file}: every test must be { name: string, fn: function }`);
      if (seen.has(t.name)) throw new Error(`duplicate e2e test name "${t.name}" (${seen.get(t.name)} and ${file})`);
      seen.set(t.name, file);
      all.push({ ...t, file });
    }
  }
  return all;
}

const all = await discover();
const filter = (process.env.E2E_FILTER ?? '').trim().toLowerCase();
const selected = filter ? all.filter((t) => t.name.toLowerCase().includes(filter)) : all;
if (!selected.length) {
  console.log(`No e2e test name contains "${process.env.E2E_FILTER}" (${all.length} tests available).`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const { url, stop } = await ensureServer();
const browser = await chromium.launch({
  executablePath: chromePath(),
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
});
configure({ browser, url });

const results = [];

async function runTest({ name, fn }) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`);
    try {
      const pgs = currentBrowser()
        .contexts()
        .flatMap((c) => c.pages());
      if (pgs.length)
        await pgs[pgs.length - 1].screenshot({ path: join(outDir, `FAIL-${name.replace(/\W+/g, '_')}.png`) });
    } catch {
      /* ignore */
    }
  } finally {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.close().catch(() => {});
  }
}

console.log(
  `PhysixLab e2e (${url})${filter ? ` — filter "${process.env.E2E_FILTER}": ${selected.length}/${all.length}` : ''}`,
);
try {
  for (const t of selected) await runTest(t);
} finally {
  await browser.close();
  stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`  FAILED: ${f.name}`);
process.exit(failed.length ? 1 : 0);

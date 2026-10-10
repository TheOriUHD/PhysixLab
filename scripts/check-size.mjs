#!/usr/bin/env node
/**
 * DT-42: bundle-size budget. Run after `npm run build`:  `npm run size`  (or `node scripts/check-size.mjs [--json]`).
 *
 * Classifies every file in dist/ and compares gzip sizes with scripts/size-budget.json (KiB):
 *   firstLoadJs   JS loaded by index.html (entry chunk + statically imported chunks)
 *   workerJs      the physics worker script(s)
 *   wasm          the Rapier WebAssembly binary (separate cached asset)
 *   css           all stylesheets
 *   lazyChunkEach every lazily-loaded JS chunk individually
 *   lazyTotal     all lazy JS chunks together
 *   firstLoadTotal firstLoadJs + workerJs + wasm + css (what a cold start downloads)
 * Exit code 1 when any budget is exceeded. Lazy chunks (see `lazy()` in docs/EXTENDING.md) do not count towards the
 * first-load numbers.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, process.env.SIZE_DIST ?? 'dist');
const budget = JSON.parse(readFileSync(path.join(root, 'scripts', 'size-budget.json'), 'utf8'));
const asJson = process.argv.includes('--json');

if (!existsSync(dist)) {
  console.error('check-size: dist/ not found — run `npm run build` first');
  process.exit(2);
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dist).map((p) => ({ rel: path.relative(dist, p).replace(/\\/g, '/'), abs: p }));
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const referenced = new Set([...html.matchAll(/(?:src|href)="\.?\/?([^"]+\.js)"/g)].map((m) => m[1]));

// Static imports of the entry chunk(s): follow `import … from "./x.js"` / `import "./x.js"` (not dynamic import()).
const firstLoad = new Set();
function follow(rel) {
  if (firstLoad.has(rel)) return;
  firstLoad.add(rel);
  const src = readFileSync(path.join(dist, rel), 'utf8');
  for (const m of src.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[^"';]*?from\s*)?["'](\.\/[^"']+\.js)["']/g)) {
    const next = path.posix.join(path.posix.dirname(rel), m[1]);
    if (existsSync(path.join(dist, next))) follow(next);
  }
}
for (const r of referenced) if (existsSync(path.join(dist, r))) follow(r);

const kib = (n) => n / 1024;
const rows = [];
const totals = { firstLoadJs: 0, workerJs: 0, wasm: 0, css: 0, lazyTotal: 0 };
for (const f of files) {
  if (f.rel === 'sw.js') continue; // DT-40: the service worker is neither first-load JS nor a lazy chunk
  const buf = readFileSync(f.abs);
  const gz = gzipSync(buf, { level: 9 }).length;
  let kind = null;
  if (f.rel.endsWith('.wasm')) kind = 'wasm';
  else if (f.rel.endsWith('.css')) kind = 'css';
  else if (f.rel.endsWith('.js')) {
    if (/(^|\/)[\w.-]*worker[\w.-]*\.js$/.test(f.rel) && !firstLoad.has(f.rel)) kind = 'workerJs';
    else if (firstLoad.has(f.rel)) kind = 'firstLoadJs';
    else kind = 'lazy';
  }
  if (!kind) continue;
  rows.push({ file: f.rel, kind, raw: buf.length, gzip: gz });
  if (kind === 'lazy') totals.lazyTotal += gz;
  else totals[kind] += gz;
}
totals.firstLoadTotal = totals.firstLoadJs + totals.workerJs + totals.wasm + totals.css;

const failures = [];
const check = (name, value) => {
  const limit = budget[name];
  if (limit !== undefined && kib(value) > limit)
    failures.push(`${name}: ${kib(value).toFixed(1)} KiB > budget ${limit} KiB`);
};
for (const k of Object.keys(totals)) check(k, totals[k]);
for (const r of rows) if (r.kind === 'lazy') check('lazyChunkEach', r.gzip);

if (asJson) {
  console.log(
    JSON.stringify(
      { totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, +kib(v).toFixed(1)])), rows, failures },
      null,
      2,
    ),
  );
} else {
  console.log('Bundle size (gzip, KiB)  — budgets from scripts/size-budget.json');
  for (const r of rows.sort((a, b) => b.gzip - a.gzip))
    console.log(
      `  ${r.kind.padEnd(12)} ${kib(r.gzip).toFixed(1).padStart(8)}  (raw ${kib(r.raw).toFixed(0).padStart(6)})  ${r.file}`,
    );
  console.log('Totals:');
  for (const [k, v] of Object.entries(totals))
    console.log(`  ${k.padEnd(14)} ${kib(v).toFixed(1).padStart(8)} / ${budget[k] ?? '–'}`);
}
if (failures.length) {
  console.error('\nBudget exceeded:\n  ' + failures.join('\n  '));
  console.error(
    'Move heavy, rarely used code behind lazy() (docs/EXTENDING.md) or justify raising scripts/size-budget.json.',
  );
  process.exit(1);
}
if (!asJson) console.log('\nOK — within budget.');

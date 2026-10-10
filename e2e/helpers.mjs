/**
 * Shared helpers for the end-to-end tests (see run.mjs for the runner and the environment variables).
 *
 * Test files in e2e/tests/*.mjs import what they need from here:
 *
 *   newPage(query?, viewport?)  open the app in a fresh page (storage cleared, welcome dialog off);
 *                               `query` is appended to the URL, e.g. '&scene=car'. The returned page has
 *                               `page.errors`, the console errors / page errors collected so far.
 *   shot(page, name)            screenshot to e2e/out/<name>.png when E2E_SHOTS is set (otherwise a no-op)
 *   simTime(page, s)            wait until the simulation has advanced at least `s` simulated seconds
 *   pose(page, id)              live pose of a body: { position, rotation, linvel, angvel } or null
 *   screenOf(page, id)          client-space x / y of a body's centre, for real mouse input
 *   nextFrame(page)             wait until the app has rendered another frame (fresh camera matrices)
 *   assert(cond, msg)           throw if `cond` is falsy
 *   near(a, b, tol, msg)        assert |a - b| <= tol
 *   sleep(ms)                   plain delay; prefer waiting on a condition (page.waitForFunction)
 *
 * The runner calls `configure()` once with the browser and the app URL before any test runs.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const outDir = join(root, 'e2e', 'out');

/** Set by the runner before the tests start. */
const env = { browser: null, url: '' };

export function configure({ browser, url }) {
  env.browser = browser;
  env.url = url;
}

export function currentBrowser() {
  return env.browser;
}

/** URL of the app under test (no trailing slash). */
export function appUrl() {
  return env.url;
}

/** Path of a Chromium / Chrome executable, or undefined to let playwright-core look for its own. */
export function chromePath() {
  return [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ]
    .filter(Boolean)
    .find((p) => existsSync(p));
}

/**
 * Resolve the URL of the app under test: `E2E_URL` when given, otherwise start a Vite dev server on
 * `E2E_PORT` (default 5199). Returns `{ url, stop }`.
 */
export async function ensureServer() {
  if (process.env.E2E_URL) return { url: process.env.E2E_URL, stop: () => {} };
  const port = Number(process.env.E2E_PORT ?? 5199);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid E2E_PORT: ${process.env.E2E_PORT}`);
  // Run Vite's own entry point with this Node (not through `npx`), so stopping the process stops the server
  // instead of orphaning it and leaving the port occupied for the next run.
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const server = spawn(process.execPath, [vite, '--port', String(port), '--host', '127.0.0.1', '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const stop = () => server.kill();
  // Whatever ends the runner (an uncaught error such as a failed browser launch, process.exit, SIGINT / SIGTERM)
  // must not leave the server behind holding the port for the next run.
  process.once('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(1));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return { url: `http://127.0.0.1:${port}`, stop };
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();
  throw new Error(`dev server did not start on port ${port}`);
}

export async function newPage(query = '', viewport = { width: 1600, height: 900 }) {
  const page = await env.browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__e2e_init')) {
        localStorage.clear();
        sessionStorage.setItem('__e2e_init', '1');
      }
    } catch {
      /* ignore */
    }
  });
  await page.goto(`${env.url}/?nowelcome${query}`);
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  page.errors = errors;
  return page;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};

export const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, expected ${b} ± ${tol})`);

/**
 * Resolve after the app has rendered at least one more frame. A camera moved by `viewport.setView()`
 * (and the picking ray built from it) only gets fresh matrices inside the render loop, which under
 * software WebGL can be hundreds of milliseconds away, so wait for it before doing real mouse input.
 */
export const nextFrame = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));

/** Client-space coordinates of a body's centre (waits for a rendered frame so the camera is current). */
export const screenOf = async (page, id) => {
  await nextFrame(page);
  return page.evaluate((id) => {
    const a = window.physicslab;
    const v = a.bodies.get(id);
    const p = v.position.clone().project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }, id);
};

export const pose = (page, id) => page.evaluate((id) => window.physicslab.sim.poseOf(id), id);

export const shot = async (page, name) => {
  if (process.env.E2E_SHOTS) {
    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: join(outDir, `${name}.png`) });
  }
};

/** Wait until the simulation has advanced at least `s` simulated seconds. */
export const simTime = (page, s) =>
  page.waitForFunction((s) => (window.physicslab.sim.client.stats?.simTime ?? 0) >= s, s, { timeout: 60000 });

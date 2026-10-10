/** Data platform (package DT): share links, storage, exports, embed … */
import { assert, newPage } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('DT-20 compact share link: opens the same scene, is shorter than v1, damaged link explained', async () => {
  const maker = await newPage();
  const made = await maker.evaluate(async () => {
    const a = window.physicslab;
    a.store.setName('Compact one');
    const info = await a.persistence.shareInfo();
    return { hash: new URL(info.url).hash, format: info.format, chars: info.chars, v1: info.v1Chars, n: a.store.size };
  });
  await maker.close();
  assert(made.format === 'v2' && made.hash.startsWith('#s='), `compact format used (${made.format})`);
  assert(made.chars < made.v1 * 0.6, `at least 40 % shorter (${made.chars} vs ${made.v1})`);
  const p = await newPage(made.hash);
  await p.waitForSelector('.toast.success:has-text("Opened shared scene")');
  const open = await p.evaluate(() => ({ name: window.physicslab.store.name, n: window.physicslab.store.size }));
  assert(open.name === 'Compact one' && open.n === made.n, `same scene (${JSON.stringify(open)} vs ${made.n})`);
  await p.close();
  const bad = await newPage(made.hash.slice(0, 30));
  await bad.waitForSelector('.toast.error');
  const err = await bad.locator('.toast.error').first().textContent();
  assert(/share link is damaged/.test(err ?? ''), `damaged link explained: ${err}`);
});

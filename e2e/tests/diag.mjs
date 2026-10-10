/**
 * Help, cheat-sheet, diagnostics, profiler and error screens (package UI-B: UI-43, UI-44), driven through the real UI.
 * Screenshots (E2E_SHOTS=1) go to e2e/out/diag-*.png.
 */
import { assert, newPage, shot, sleep } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const noErrors = (page) => assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
const SIZES = [
  ['1600', { width: 1600, height: 900 }],
  ['1280', { width: 1280, height: 720 }],
];

// -- cheat-sheet ------------------------------------------------------------------------------------------------------
test('diag: the shortcut cheat-sheet opens with ?, filters, navigates and runs a command', async () => {
  for (const [tag, vp] of SIZES) {
    const page = await newPage('', vp);
    await page.mouse.click(vp.width / 2, 120);
    await page.keyboard.press('?');
    await page.waitForSelector('.modal.cheat .cheat-filter');
    assert(await page.evaluate(() => document.activeElement?.classList.contains('cheat-filter')), 'filter autofocused');
    const all = await page.locator('.cheat-row').count();
    assert(all > 20, `many rows (${all})`);
    await sleep(1500);
    await shot(page, `diag-cheat-${tag}`);
    await page.keyboard.type('undo');
    const rows = await page.locator('.cheat-row').allTextContents();
    assert(rows.length >= 1 && rows.some((r) => /^Undo/.test(r)), `filtered to undo: ${rows.join('|')}`);
    assert(rows.length < all / 2, 'the filter narrows the list');
    assert(
      rows.some((r) => /Ctrl|⌘/.test(r)),
      'key caps shown',
    );
    // commands without shortcuts behind the toggle
    await page.fill('.cheat-filter', 'frame');
    const before = await page.locator('.cheat-row').count();
    await page.locator('.cheat-toggle input').check();
    const after = await page.locator('.cheat-row').count();
    assert(after >= before, 'toggle lists at least as many');
    await page.locator('.cheat-toggle input').uncheck();
    // keyboard navigation: arrow down moves the active row
    await page.fill('.cheat-filter', 'select');
    const first = await page.locator('.cheat-row.active').innerText();
    await page.keyboard.press('ArrowDown');
    const second = await page.locator('.cheat-row.active').innerText();
    assert(first !== second, 'ArrowDown moves the highlight');
    // Enter runs the command of the active row: Select all via "select all"
    await page.fill('.cheat-filter', 'select all');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal.cheat', { state: 'detached' });
    await sleep(100);
    assert(await page.evaluate(() => window.physixlab.store.selection.length > 0), 'Enter ran "Select all"');
    // Esc closes
    await page.keyboard.press('?');
    await page.waitForSelector('.modal.cheat');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal.cheat', { state: 'detached' });
    noErrors(page);
    await page.close();
  }
});

// -- help -------------------------------------------------------------------------------------------------------------
test('diag: the Help panel lists pages, searches with highlights, follows links and opens on F1', async () => {
  for (const [tag, vp] of SIZES) {
    const page = await newPage('', vp);
    await page.mouse.click(vp.width / 2, 120);
    await page.keyboard.press('F1');
    await page.waitForSelector('.help-panel .help-item');
    const n = await page.locator('.help-item').count();
    assert(n >= 10, `page list (${n})`);
    await shot(page, `diag-help-list-${tag}`);
    await page.fill('.help-search', 'hinge motor');
    await page.waitForSelector('.help-item.hit mark');
    const hit = await page.locator('.help-item.hit').first().innerText();
    assert(/joint/i.test(hit), `top hit is about joints: ${hit}`);
    await page.locator('.help-item.hit').first().click();
    await page.waitForSelector('.help-doc mark');
    await shot(page, `diag-help-page-${tag}`);
    // internal links
    await page.locator('.help-doc a[data-help]').first().click();
    await page.waitForSelector('.help-doc h1');
    // deep link
    await page.evaluate(async () => {
      const m = await import('/src/ui/help/helpPanel.ts');
      m.openHelp(window.physixlab, 'joints-and-motors#motors');
    });
    await page.waitForFunction(() => document.querySelector('.help-doc h2#motors'));
    // no results
    await page.locator('.help-back').click();
    await page.fill('.help-search', 'zzzxqy');
    await page.waitForSelector('.help-body .empty-state');
    noErrors(page);
    await page.close();
  }
});

/**
 * Status bar tips and empty-state illustrations (package UI-B: UI-44 c, d). Screenshots (E2E_SHOTS=1): e2e/out/diag-*.png.
 */
import { assert, newPage, shot, sleep } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SIZES = [
  ['1600', { width: 1600, height: 900 }],
  ['1280', { width: 1280, height: 720 }],
];
const command = (page, id) =>
  page.evaluate(async (id) => {
    const { runCommand } = await import('/src/app/registry/commands.ts');
    runCommand(id, window.physicslab);
  }, id);
const tip = (page) => page.evaluate(() => document.querySelector('.status-tip')?.textContent ?? '');

test('diag: the status bar shows a contextual tip, follows the context, takes registered tips and can be switched off', async () => {
  for (const [tag, vp] of SIZES) {
    const page = await newPage('', vp);
    await page.waitForSelector('.status-tip b');
    assert(vp.width < 1400 || /Tip/.test(await tip(page)), `a tip is shown: ${await tip(page)}`);
    // context: nothing selected in edit mode -> select hint; selecting -> gizmo hint; running -> throw hint
    await page.evaluate(() => window.physicslab.store.setSelection([]));
    await page.waitForFunction(() =>
      /Click an object to select it/.test(document.querySelector('.status-tip')?.textContent ?? ''),
    );
    await page.evaluate(() => window.physicslab.store.setSelection([window.physicslab.store.bodies()[0].id]));
    await page.waitForFunction(() => /Press W to move/.test(document.querySelector('.status-tip')?.textContent ?? ''));
    await page.evaluate(() => window.physicslab.sim.play());
    await page.waitForFunction(() =>
      /Drag a body to throw it/.test(document.querySelector('.status-tip')?.textContent ?? ''),
    );
    assert(/Space/.test(await tip(page)), 'the running tip names the real key from the command registry');
    await page.evaluate(() => window.physicslab.sim.reset());
    await sleep(300);
    await shot(page, `diag-tip-${tag}`);
    // a tip registered later by anyone shows up
    await page.evaluate(async () => {
      const { registerStatusTip } = await import('/src/app/registry/tips.ts');
      registerStatusTip({ id: 'tip.test', text: 'A tip from a test', priority: 100 });
      window.dispatchEvent(new Event('physicslab:tips'));
    });
    await page.evaluate(() => window.physicslab.store.setSelection([]));
    await page.waitForFunction(() =>
      /A tip from a test/.test(document.querySelector('.status-tip')?.textContent ?? ''),
    );
    // off switch: the registry command toggles it
    await command(page, 'view.statusTips');
    await page.waitForFunction(() => document.querySelector('.status-tip')?.textContent === '');
    await command(page, 'view.statusTips');
    await page.waitForFunction(() => (document.querySelector('.status-tip')?.textContent ?? '') !== '');
    await page.close();
  }
});

test('diag: empty lists show an illustration, a title and a hint (inspector, outliner, library, search, components)', async () => {
  for (const [tag, vp] of SIZES) {
    const page = await newPage('', vp);
    const art = (sel) => page.evaluate((sel) => !!document.querySelector(`${sel} .empty-state svg.es-art`), sel);
    // nothing selected
    await page.evaluate(() => window.physicslab.store.setSelection([]));
    await command(page, 'panel.inspector');
    await page.waitForSelector('.panel.right .empty-state:visible .es-art');
    assert(
      /Nothing selected/.test(await page.locator('.panel.right .empty-state:visible').first().innerText()),
      'no selection text',
    );
    await shot(page, `diag-empty-inspector-${tag}`);
    // empty scene: inspector + outliner
    await page.evaluate(() => window.physicslab.newScene());
    await page.waitForFunction(() =>
      /An empty lab/.test(document.querySelector('.panel.right .empty-state')?.textContent ?? ''),
    );
    await command(page, 'panel.outliner');
    await page.waitForFunction(() => document.querySelector('.o-empty .es-art') !== null);
    assert(/The scene is empty/.test(await page.locator('.o-empty').innerText()), 'outliner empty text');
    await shot(page, `diag-empty-outliner-${tag}`);
    // library: no saved scenes, map search without result
    await command(page, 'panel.scenes');
    await page.waitForSelector('.panel.left .empty-state:visible .es-art');
    assert(
      /No saved scenes yet/.test(await page.locator('.panel.left .empty-state:visible').first().innerText()),
      'scenes empty text',
    );
    await shot(page, `diag-empty-scenes-${tag}`);
    // help search without result
    await page.evaluate(async () => {
      const m = await import('/src/ui/help/helpPanel.ts');
      m.openHelp(window.physicslab, '', 'qqqzzz');
    });
    await page.waitForSelector('.help-body .empty-state:visible .es-art');
    assert(await art('.help-body'), 'help search: illustration');
    // the illustrations use the design tokens (no hard-coded colours that would ignore a theme)
    const svgs = await page.evaluate(async () => {
      const m = await import('/src/ui/emptyState.ts');
      return [
        'select',
        'scene',
        'search',
        'folder',
        'joint',
        'chart',
        'tree',
        'component',
        'recent',
        'map',
        'light',
        'path',
      ].map((k) => m.artMarkup(k));
    });
    for (const s of svgs)
      assert(!/#[0-9a-f]{3,6}\b/i.test(s) && /var\(--/.test(s), 'illustration uses design tokens only');
    await page.close();
  }
});

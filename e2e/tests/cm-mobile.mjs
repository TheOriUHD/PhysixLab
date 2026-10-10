/**
 * CM-13 mobile / tablet layout: the app at 390x844 (phone portrait) and 820x1180 (tablet portrait) in a touch-
 * emulating context — no horizontal overflow, the viewport dominates, panels open as drawers / a bottom sheet from
 * the bottom navigation and close again, finger-sized controls — plus the unchanged wide layouts.
 */
import { assert, newPage, nextFrame, shot } from '../helpers.mjs';
import { newTouchPage, tap } from './cm-touch.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const box = (page, sel) => page.locator(sel).first().boundingBox();
const shown = (page, sel) => page.locator(sel).first().isVisible();
const waitShown = (page, sel, on = true) =>
  page.waitForFunction(
    ([sel, on]) => {
      const el = document.querySelector(sel);
      const vis = !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
      return vis === on;
    },
    [sel, on],
    { timeout: 20000 },
  );

/** Wait until the sheets have stopped sliding in (software GL can delay the start of a CSS animation by a second). */
const settled = async (page) => {
  await page.waitForTimeout(150);
  await page.waitForFunction(() => !document.getAnimations().some((a) => /^m-from/.test(a.animationName ?? '')), null, {
    timeout: 20000,
  });
  await nextFrame(page);
};

/** Elements (matching `sel`) that stick out of the window. */
const overflowing = (page, sel) =>
  page.evaluate((sel) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1)
        out.push(
          `${el.tagName}.${String(el.className).slice(0, 40)} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    }
    return out;
  }, sel);

/** Visible buttons matching `sel` that are shorter than 44 px (or narrower). */
const smallTargets = (page, sel, min = 44, wide = true) =>
  page.evaluate(
    ([sel, min, wide]) => {
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.height < min - 0.5 || (wide && r.width < min - 0.5))
          out.push(
            `${el.tagName}.${String(el.className).slice(0, 30)}[${el.title || el.textContent.trim().slice(0, 12)}] ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
      }
      return out;
    },
    [sel, min, wide],
  );

const noPageScroll = async (page, what) => {
  const m = await page.evaluate(() => ({
    dw: document.documentElement.scrollWidth,
    bw: document.body.scrollWidth,
    iw: innerWidth,
    dh: document.documentElement.scrollHeight,
    ih: innerHeight,
  }));
  assert(m.dw <= m.iw && m.bw <= m.iw, `${what}: horizontal page overflow ${JSON.stringify(m)}`);
  assert(m.dh <= m.ih + 1, `${what}: vertical page overflow ${JSON.stringify(m)}`);
};

async function suite(page, w, h, tag) {
  const label = `${w}x${h}`;
  assert(await page.evaluate(() => window.matchMedia('(max-width: 900px)').matches), `${label} uses the narrow layout`);
  await noPageScroll(page, label);
  // The viewport canvas is the dominant area.
  const cv = await box(page, '.viewport-canvas');
  const share = (cv.width * cv.height) / (w * h);
  assert(share > 0.7, `${label}: canvas covers ${(share * 100).toFixed(0)}% of the window`);
  // Panels start closed; the navigation is there.
  assert(
    !(await shown(page, '.panel.left')) && !(await shown(page, '.panel.right')),
    `${label}: drawers closed at start`,
  );
  assert(!(await shown(page, '.dock')), `${label}: bottom sheet closed at start`);
  assert(await shown(page, '.m-nav'), `${label}: bottom navigation visible`);
  assert(!(await shown(page, '.statusbar')), `${label}: status bar replaced by the navigation`);
  assert(
    (await overflowing(page, '.topbar *, .m-nav, .m-nav *')).length === 0,
    `${label}: top bar / nav fit: ${await overflowing(page, '.topbar *, .m-nav *')}`,
  );
  const small = await smallTargets(page, '.topbar button, .m-nav button');
  assert(small.length === 0, `${label}: controls under 44px: ${small.join(' | ')}`);
  await shot(page, `cm-mobile-${tag}-closed`);

  // ---- drawers: open from the navigation, one at a time, close with the scrim / close button / Escape ----
  await page.click('[data-nav="left"]');
  await waitShown(page, '.panel.left');
  await settled(page);
  const left = await box(page, '.panel.left');
  assert(
    left.x === 0 && left.width <= w * 0.9 && left.width >= 280,
    `${label}: library drawer ${JSON.stringify(left)}`,
  );
  assert(await shown(page, '.m-scrim'), `${label}: scrim shown`);
  assert(await shown(page, '.m-close'), `${label}: close button shown`);
  const cb = await box(page, '.m-close');
  assert(
    cb.x >= left.width - 1 && cb.x + cb.width <= w,
    `${label}: close button beside the drawer ${JSON.stringify(cb)}`,
  );
  assert(await page.evaluate(() => window.physixlab.prefs.value.showLeft), `${label}: the show-left preference is on`);
  const tabsSmall = await smallTargets(page, '.panel.left .tab', 44, false);
  assert(tabsSmall.length === 0, `${label}: library tabs ${tabsSmall.join(' | ')}`);
  assert(
    (await overflowing(page, '.panel.left, .panel.left .tabs')).length === 0,
    `${label}: drawer content fits: ${await overflowing(page, '.panel.left, .panel.left .tabs')}`,
  );
  await shot(page, `cm-mobile-${tag}-library`);
  await page.click('.m-scrim', { position: { x: w - 12, y: 300 } });
  await waitShown(page, '.panel.left', false);
  assert(!(await page.evaluate(() => window.physixlab.prefs.value.showLeft)), `${label}: scrim closes the drawer`);

  // inspector on the right, with something selected
  await page.evaluate(() => {
    const a = window.physixlab;
    a.store.setSelection([a.store.bodies()[0].id]);
  });
  await page.click('[data-nav="right"]');
  await waitShown(page, '.panel.right');
  await settled(page);
  const right = await box(page, '.panel.right');
  assert(
    Math.abs(right.x + right.width - w) < 1 && right.width <= w * 0.9,
    `${label}: inspector drawer ${JSON.stringify(right)}`,
  );
  assert(
    (await overflowing(page, '.panel.right, .panel.right .panel-body, .panel.right .tabs')).length === 0,
    `${label}: inspector drawer fits: ${await overflowing(page, '.panel.right, .panel.right .panel-body, .panel.right .tabs')}`,
  );
  await shot(page, `cm-mobile-${tag}-inspector`);
  // one sheet at a time: opening the library closes the inspector
  await page.click('[data-nav="left"]');
  await waitShown(page, '.panel.left');
  await waitShown(page, '.panel.right', false);
  // bottom sheet
  await page.click('[data-nav="bottom"]');
  await waitShown(page, '.dock');
  await waitShown(page, '.panel.left', false);
  await settled(page);
  const dock = await box(page, '.dock');
  assert(
    dock.x === 0 && Math.abs(dock.width - w) < 1 && dock.height < h * 0.6 && dock.y + dock.height <= h,
    `${label}: bottom sheet ${JSON.stringify(dock)}`,
  );
  assert(
    (await overflowing(page, '.dock')).length === 0,
    `${label}: bottom sheet fits: ${await overflowing(page, '.dock')}`,
  );
  await shot(page, `cm-mobile-${tag}-dock`);
  await page.click('.m-close');
  await waitShown(page, '.dock', false);
  // Escape
  await page.click('[data-nav="right"]');
  await waitShown(page, '.panel.right');
  await page.keyboard.press('Escape');
  await waitShown(page, '.panel.right', false);

  // ---- tools and view popovers ----
  await page.click('[data-nav="tools"]');
  await waitShown(page, '.toolbox');
  assert(
    (await overflowing(page, '.toolbox, .toolbox button')).length === 0,
    `${label}: toolbox fits: ${await overflowing(page, '.toolbox, .toolbox button')}`,
  );
  const toolSmall = await smallTargets(page, '.toolbox button');
  assert(toolSmall.length === 0, `${label}: tool buttons ${toolSmall.join(' | ')}`);
  await shot(page, `cm-mobile-${tag}-tools`);
  await page.click('.toolbox [data-tool="measure"]');
  assert(
    (await page.evaluate(() => window.physixlab.prefs.value.tool)) === 'measure',
    `${label}: a tool can be picked from the popover`,
  );
  await page.click('[data-nav="view"]');
  await waitShown(page, '.viewbar');
  await waitShown(page, '.toolbox', false);
  assert(
    (await overflowing(page, '.viewbar, .viewbar button')).length === 0,
    `${label}: view bar fits: ${await overflowing(page, '.viewbar, .viewbar button')}`,
  );
  const viewSmall = await smallTargets(page, '.viewbar button');
  assert(viewSmall.length === 0, `${label}: view buttons ${viewSmall.join(' | ')}`);
  await shot(page, `cm-mobile-${tag}-view`);
  await tap(page, w / 2, h / 2 + 40); // a tap in the viewport dismisses the popover
  await waitShown(page, '.viewbar', false);
  await page.evaluate(() => window.physixlab.prefs.set({ tool: 'select' }));

  // ---- the combined menu ----
  await page.click('[data-nav="menu"]');
  await page.waitForSelector('.menu');
  const menu = await box(page, '.menu');
  assert(
    menu.x >= 0 && menu.x + menu.width <= w && menu.y >= 0 && menu.y + menu.height <= h,
    `${label}: menu on screen ${JSON.stringify(menu)}`,
  );
  const headings = await page.locator('.menu .menu-label').allInnerTexts();
  assert(
    headings.some((t) => /file/i.test(t)) && headings.some((t) => /edit/i.test(t)),
    `${label}: menu has the bar menus: ${headings}`,
  );
  await shot(page, `cm-mobile-${tag}-menu`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('.menu')?.remove());

  // ---- a dialog (input settings, Touch tab) fits the window ----
  await page.keyboard.press('Control+k');
  await page.fill('.palette-input', 'keyboard gamepad');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.input-modal [data-tab="touch"]');
  await page.click('.input-modal [data-tab="touch"]');
  await page.waitForSelector('.touch-tab .tc-choice');
  const modal = await box(page, '.input-modal');
  assert(
    modal.x >= 0 && modal.x + modal.width <= w + 0.5 && modal.y >= 0 && modal.y + modal.height <= h + 0.5,
    `${label}: dialog on screen ${JSON.stringify(modal)}`,
  );
  const tabW = await page.evaluate(() => {
    const t = document.querySelector('.touch-tab');
    return t.scrollWidth - t.clientWidth;
  });
  assert(tabW <= 1, `${label}: Touch tab scrolls horizontally by ${tabW}px`);
  await shot(page, `cm-mobile-${tag}-touch-settings`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.input-modal', { state: 'detached' });

  // ---- simulate with touch controls over the viewport ----
  await page.evaluate(() => window.physixlab.store.setSelection([]));
  await page.click('.tbtn.play');
  await page.waitForSelector('.tc-overlay:not([hidden])');
  const rt = await box(page, '.tc-btn-RT');
  const nav = await box(page, '.m-nav');
  assert(rt.y + rt.height <= nav.y, `${label}: touch controls sit above the navigation`);
  await nextFrame(page);
  await shot(page, `cm-mobile-${tag}-simulating`);
  await page.click('.tbtn >> nth=2'); // stop
  assert(page.errors.length === 0, page.errors.join('\n'));
}

test('mobile 390x844: viewport-first layout, drawers / bottom sheet / popovers, finger-sized controls', async () => {
  const page = await newTouchPage('&scene=car', { width: 390, height: 844 });
  await suite(page, 390, 844, 'phone');
  await page.closeAll();
});

test('mobile 820x1180: tablet portrait uses the same sheet layout with roomier drawers', async () => {
  const page = await newTouchPage('&scene=car', { width: 820, height: 1180 });
  await suite(page, 820, 1180, 'tablet');
  // The tablet top bar keeps the scene name.
  assert(await shown(page, '.scene-name'), 'tablet top bar shows the scene name');
  await page.closeAll();
});

test('mobile: wide layouts (1600x900, 1280x720) keep the docked panels; narrowing and widening restores them', async () => {
  for (const [w, h] of [
    [1600, 900],
    [1280, 720],
  ]) {
    const page = await newPage('&scene=car', { width: w, height: h });
    assert(!(await shown(page, '.m-nav')) && !(await shown(page, '.m-scrim')), `${w}: no mobile navigation`);
    assert(await shown(page, '.statusbar'), `${w}: status bar visible`);
    const pos = await page.evaluate(() => ({
      left: getComputedStyle(document.querySelector('.panel.left')).position,
      right: getComputedStyle(document.querySelector('.panel.right')).position,
      dock: getComputedStyle(document.querySelector('.dock')).position,
      tools: getComputedStyle(document.querySelector('.toolbox')).display,
      view: getComputedStyle(document.querySelector('.viewbar')).display,
      cols: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
    }));
    assert(
      pos.left !== 'fixed' && pos.right !== 'fixed' && pos.dock !== 'fixed',
      `${w}: panels docked ${JSON.stringify(pos)}`,
    );
    assert(pos.tools !== 'none' && pos.view !== 'none', `${w}: toolbox and view bar always shown`);
    const cols = pos.cols.split(' ').map(parseFloat);
    assert(cols.length === 3 && cols[0] >= 200 && cols[2] >= 250, `${w}: three columns ${pos.cols}`);
    const cv = await box(page, '.viewport-canvas');
    assert(
      cv.x >= cols[0] - 1 && cv.width >= w - cols[0] - cols[2] - 2,
      `${w}: canvas between the panels ${JSON.stringify(cv)}`,
    );
    assert(!(await page.evaluate(() => localStorage.getItem('physixlab:desktop-panels'))), `${w}: nothing stashed`);
    if (w === 1280) {
      // narrow, then wide again: the desktop arrangement comes back
      await page.setViewportSize({ width: 390, height: 844 });
      await waitShown(page, '.m-nav');
      await waitShown(page, '.panel.left', false);
      assert(!(await page.evaluate(() => window.physixlab.prefs.value.showLeft)), 'panels closed while narrow');
      await page.setViewportSize({ width: 1280, height: 720 });
      await waitShown(page, '.m-nav', false);
      await waitShown(page, '.panel.left');
      await waitShown(page, '.panel.right');
      await waitShown(page, '.dock');
      const v = await page.evaluate(() => window.physixlab.prefs.value);
      assert(v.showLeft && v.showRight && v.showBottom, 'desktop panels restored');
      await shot(page, 'cm-mobile-wide-1280');
    } else await shot(page, 'cm-mobile-wide-1600');
    assert(page.errors.length === 0, page.errors.join('\n'));
    await page.close();
  }
});

test('mobile: a touch tablet in landscape (1180x820) keeps the docked layout and nothing is clipped', async () => {
  const page = await newTouchPage('&scene=car', { width: 1180, height: 820 });
  assert(!(await shown(page, '.m-nav')), 'no bottom navigation above 900px');
  const m = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const tool = r('.toolbox');
    const head = document.querySelector('.dock .dock-ghead, .dock .dock-head');
    const tabs = [...document.querySelectorAll('.dock .tab')].map((t) => t.getBoundingClientRect().height);
    return {
      left: getComputedStyle(document.querySelector('.panel.left')).position,
      toolBtn: document.querySelector('.toolbox .icon-btn').getBoundingClientRect().height,
      toolbox: tool.height,
      headH: head ? head.getBoundingClientRect().height : 0,
      tabH: Math.max(0, ...tabs),
      dw: document.documentElement.scrollWidth,
      iw: innerWidth,
    };
  });
  assert(m.left !== 'fixed', `panels docked: ${JSON.stringify(m)}`);
  assert(m.toolBtn <= 36, `desktop-width toolbox buttons keep their size on a touch tablet: ${JSON.stringify(m)}`);
  assert(m.tabH <= m.headH + 2, `dock tabs are not taller than their strip: ${JSON.stringify(m)}`);
  assert(m.dw <= m.iw, `no horizontal overflow: ${JSON.stringify(m)}`);
  await shot(page, 'cm-mobile-tablet-landscape');
  assert(page.errors.length === 0, page.errors.join('\n'));
  await page.closeAll();
});

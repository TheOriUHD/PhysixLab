/**
 * Accessible-name audit (UI-44): every interactive element of the live UI (button, select, input, textarea, links,
 * [role=tab] / [role=button] …) must have an accessible name (visible text, aria-label, aria-labelledby, title, an
 * associated label, alt text, or a placeholder), in every panel and for every kind of selection.
 */
import { assert, newPage } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Runs in the page: the interactive elements without a name, described. */
function audit() {
  const SEL =
    'button, select, input, textarea, a[href], [role=tab], [role=button], [role=menuitem], [role=checkbox], [role=switch], [role=slider], [role=option]';
  const visible = (el) => {
    if (!el.isConnected) return false;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (e.hidden || e.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  };
  const text = (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const named = (el) => {
    if ((el.getAttribute('aria-label') ?? '').trim()) return true;
    const lb = el.getAttribute('aria-labelledby');
    if (
      lb &&
      lb.split(/\s+/).some((id) => text(document.getElementById(id) ?? document.body.ownerDocument.createElement('i')))
    )
      return true;
    if ((el.getAttribute('title') ?? '').trim()) return true;
    if (el.labels && [...el.labels].some((l) => text(l))) return true;
    if (el.closest('label') && text(el.closest('label'))) return true;
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) && el.value) return true;
    if (el.tagName === 'INPUT' && (el.placeholder ?? '').trim()) return true;
    if (text(el)) return true;
    for (const img of el.querySelectorAll('img[alt], svg title'))
      if ((img.getAttribute?.('alt') ?? img.textContent ?? '').trim()) return true;
    return false;
  };
  const describe = (el) => {
    const path = [];
    for (let e = el, n = 0; e && e !== document.body && n < 4; e = e.parentElement, n++)
      path.unshift(
        `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`,
      );
    return `${path.join(' > ')} ${el.outerHTML.slice(0, 110).replace(/\s+/g, ' ')}`;
  };
  const bad = [];
  for (const el of document.querySelectorAll(SEL)) {
    // icon-only buttons must also show a tooltip (a hover hint), not only carry an aria-label
    if (
      el.tagName === 'BUTTON' &&
      !text(el) &&
      !(el.getAttribute('title') ?? '').trim() &&
      visible(el) &&
      !el.closest('.three-hidden')
    )
      bad.push('no tooltip: ' + describe(el));
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    if (el.closest('.three-hidden')) continue;
    if (!visible(el)) continue;
    if (!named(el)) bad.push(describe(el));
  }
  return bad;
}

const run = (page) => page.evaluate(audit);

test('diag: every interactive element has an accessible name (panels, selections, menus, dialogs)', async () => {
  const page = await newPage('', { width: 1600, height: 900 });
  // the audit itself must catch what it is meant to catch
  const planted = await page.evaluate((src) => {
    const holder = document.createElement('div');
    holder.innerHTML =
      '<button id="__p1"><svg width="8" height="8"></svg></button><input id="__p2" type="text"><select id="__p3"></select>';
    document.body.appendChild(holder);
    const found = new Function(`return (${src})`)()();
    holder.remove();
    return found;
  }, audit.toString());
  assert(planted.length >= 3, `the audit flags an unnamed icon button, input and select (found ${planted.length})`);
  // shortcut hints in the tooltips of the main controls
  const hints = await page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.getAttribute('title') ?? '';
    return {
      play: [...document.querySelectorAll('.transport button')].map((b) => b.title).join(' | '),
      undo: [...document.querySelectorAll('button')]
        .map((b) => b.title)
        .filter((x) => /^Undo/.test(x))
        .join(' | '),
      tools: [...document.querySelectorAll('.toolbox button, .viewbar button')].map((b) => b.title).join(' | '),
      none: t('#__nope'),
    };
  });
  assert(/Space/.test(hints.play), `Simulate tooltip names its key: ${hints.play}`);
  assert(/Ctrl\+Z|⌘Z/.test(hints.undo), `Undo tooltip names its key: ${hints.undo}`);
  assert(
    /\(Q\)/.test(hints.tools) && /\(W\)/.test(hints.tools),
    `tool tooltips name their keys: ${hints.tools.slice(0, 200)}`,
  );
  const offenders = new Map();
  const collect = async (where) => {
    for (const d of await run(page)) if (!offenders.has(d)) offenders.set(d, where);
  };
  await collect('startup');
  // every registered panel, in turn
  const panels = await page.evaluate(async () => {
    const { panelRegistry } = await import('/src/app/registry/panels.ts');
    return panelRegistry.list().map((p) => p.id);
  });
  assert(panels.length >= 8, `panels found (${panels.length})`);
  const showPanel = (id) =>
    page.evaluate(async (id) => {
      const { runCommand } = await import('/src/app/registry/commands.ts');
      runCommand(`panel.${id}`, window.physicslab);
    }, id);
  // selections: a body, a joint, a soft body, a light, a path, a group, nothing, several
  const kinds = await page.evaluate(async () => {
    const a = window.physicslab;
    const { Builder } = await import('/src/model/builder.ts');
    const b = new Builder('audit');
    const box = b.body('A', 'box', [1, 1, 1], [0, 1, 0]);
    const ball = b.body('B', 'sphere', [0.5, 0.5, 0.5], [2, 1, 0]);
    b.joint('hinge', box, ball, [1, 1, 0], [0, 0, 1], { name: 'J' });
    a.loadDocument(b.done());
    const st = a.store;
    const ids = {};
    ids.body = st.bodies()[0].id;
    ids.joint = st.joints()[0].id;
    return ids;
  });
  const selections = {
    nothing: [],
    body: [kinds.body],
    joint: [kinds.joint],
    several: await page.evaluate(() => window.physicslab.store.bodies().map((b) => b.id)),
  };
  // add a soft body, a light, a path and a group through the commands
  const extra = await page.evaluate(async () => {
    const { runCommand } = await import('/src/app/registry/commands.ts');
    const a = window.physicslab;
    const out = {};
    for (const [key, cmd, pick] of [
      ['soft', 'add.soft.cloth', () => a.store.softs().at(-1)],
      ['light', 'add.light.point', () => a.store.lights().at(-1)],
      ['path', 'add.path', () => a.store.paths().at(-1)],
    ]) {
      runCommand(cmd, a);
      await new Promise((r) => setTimeout(r, 50));
      out[key] = pick()?.id;
    }
    a.store.setSelection([a.store.bodies()[0].id]);
    runCommand('edit.group', a);
    out.group = a.store.groups().at(-1)?.id;
    return out;
  });
  for (const [k, id] of Object.entries(extra)) if (id) selections[k] = [id];
  for (const [kind, ids] of Object.entries(selections)) {
    await page.evaluate((ids) => window.physicslab.store.setSelection(ids), ids);
    for (const id of panels) {
      await showPanel(id);
      await page.waitForTimeout(120);
      await collect(`panel ${id}, selection ${kind}`);
    }
  }
  // menus
  for (const menu of ['File', 'Edit', 'View', 'Help']) {
    const btn = page.locator('.menu-btn', { hasText: menu }).first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(150);
      await collect(`menu ${menu}`);
      await page.keyboard.press('Escape');
      await page.mouse.click(700, 300);
    }
  }
  // dialogs: cheat-sheet, command palette
  await page.keyboard.press('?');
  await page.waitForSelector('.modal.cheat');
  await collect('cheat-sheet');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(300);
  await collect('command palette');
  await page.keyboard.press('Escape');
  const list = [...offenders].map(([d, where]) => `[${where}] ${d}`);
  assert(
    list.length === 0,
    `${list.length} interactive element(s) without an accessible name: ${list.slice(0, 40).join(' || ')}`,
  );
  await page.close();
});

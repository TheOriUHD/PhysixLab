import type { App } from '../app/app';
import { runCommand, withShortcut } from '../app/registry/commands';
import { listBarMenus, menuRegistry, resolveMenu } from '../app/registry/menus';
import { formatShortcut } from '../app/registry/shortcuts';
import { iconButton, segmented } from './controls';
import { h, svg } from './dom';
import { icon, LOGO } from './icons';
import { openMenu } from './menu';
import { createImportInput } from './sceneActions';
import { appearanceButton } from './appearance';

const TIME_SCALES = [0.1, 0.25, 0.5, 1, 2, 4];

export function buildTopbar(app: App): HTMLElement {
  const { store, sim, prefs } = app;

  // ---- brand + scene name ----------------------------------------------------------------
  const brand = h(
    'div',
    { class: 'brand' },
    svg(LOGO, 'logo-mark'),
    h('span', { class: 'word' }, 'Physics', h('b', null, 'Lab')),
  );
  const name = h('input', {
    class: 'scene-name',
    type: 'text',
    value: store.name,
    spellcheck: false,
    title: 'Scene name',
  });
  name.addEventListener('change', () => store.setName(name.value.trim() || 'Untitled scene'));
  name.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') name.blur();
  });
  store.on('meta', () => {
    if (document.activeElement !== name) name.value = store.name;
  });
  store.on('change', (c) => {
    if (c.type === 'reset') name.value = store.name;
  });

  // ---- menus (File / Edit / View / Help come from the menu registry) --------------------------
  const menubar = h('div', { class: 'menubar' });
  const renderMenubar = () => {
    menubar.replaceChildren(
      ...listBarMenus().map((menu) => {
        const b = h('button', { class: 'menu-btn', type: 'button' }, menu.label);
        b.addEventListener('click', () => {
          b.classList.add('open');
          openMenu(resolveMenu(app, menu.id), b, () => b.classList.remove('open'));
          const obs = new MutationObserver(() => {
            if (!document.querySelector('.menu')) {
              b.classList.remove('open');
              obs.disconnect();
            }
          });
          obs.observe(document.body, { childList: true });
        });
        return b;
      }),
    );
  };
  menuRegistry.onChange(renderMenubar);
  renderMenubar();

  // ---- transport -------------------------------------------------------------------------------
  // Tooltips take the shortcut from the command, so they can never disagree with the keymap.
  const playBtn = h('button', {
    class: 'tbtn play',
    type: 'button',
    title: withShortcut('Start / pause', 'sim.toggle'),
  });
  const stepBtn = h(
    'button',
    { class: 'tbtn', type: 'button', title: withShortcut('Advance one physics step', 'sim.step') },
    icon('step'),
  );
  const resetBtn = h(
    'button',
    {
      class: 'tbtn',
      type: 'button',
      title: withShortcut('Stop and return to the editable layout', 'sim.reset'),
    },
    icon('reset'),
  );
  const clock = h('div', { class: 'sim-clock', title: 'Simulated time' }, '0.00 s');
  const run = (id: string) => runCommand(id, app, 'button');
  playBtn.addEventListener('click', () => run('sim.toggle'));
  stepBtn.addEventListener('click', () => run('sim.step'));
  resetBtn.addEventListener('click', () => run('sim.reset'));
  const ts = segmented({
    compact: true,
    options: TIME_SCALES.map((v) => ({
      value: String(v),
      label: v < 1 ? `${v}×` : `${v}×`,
      title: v === 1 ? 'Real time' : v < 1 ? `Slow motion ${v}×` : `Fast forward ${v}×`,
    })),
    value: String(prefs.value.timeScale),
    onChange: (v) => prefs.set({ timeScale: Number(v) }),
  });
  prefs.on('change', (k) => {
    if (k.includes('timeScale')) ts.set(String(prefs.value.timeScale));
  });
  const chip = h('div', { class: 'mode-chip' }, h('i'), h('span', null, 'Edit'));

  const syncMode = () => {
    const m = sim.mode;
    playBtn.replaceChildren(
      icon(m === 'running' ? 'pause' : 'play'),
      h('span', null, m === 'running' ? 'Pause' : m === 'paused' ? 'Resume' : 'Simulate'),
    );
    playBtn.className = `tbtn ${m === 'running' ? 'pause' : 'play'}`;
    resetBtn.toggleAttribute('disabled', m === 'edit');
    chip.className = `mode-chip ${m === 'edit' ? '' : m}`;
    chip.lastElementChild!.textContent = m === 'edit' ? 'Edit' : m === 'running' ? 'Running' : 'Paused';
  };
  sim.on('mode', syncMode);
  syncMode();
  app.on('frame', () => {
    const st = sim.client.stats;
    const t = sim.active && st ? st.simTime : 0;
    const txt = `${t.toFixed(2)} s`;
    if (clock.textContent !== txt) clock.textContent = txt;
  });

  const transport = h(
    'div',
    { class: 'transport' },
    playBtn,
    stepBtn,
    resetBtn,
    h('div', { class: 'timescale' }, ts.el),
    clock,
  );

  // ---- right cluster ---------------------------------------------------------------------------
  const undo = iconButton('undo', withShortcut('Undo', 'edit.undo'), () => run('edit.undo'));
  const redo = iconButton('redo', withShortcut('Redo', 'edit.redo'), () => run('edit.redo'));
  const syncHistory = () => {
    undo.disabled = !store.canUndo;
    redo.disabled = !store.canRedo;
    undo.title = store.canUndo ? withShortcut(`Undo ${store.undoLabel}`, 'edit.undo') : 'Undo';
    redo.title = store.canRedo ? withShortcut(`Redo ${store.redoLabel}`, 'edit.redo') : 'Redo';
  };
  store.on('history', syncHistory);
  syncHistory();
  const saved = h('span', { class: 'save-state' }, '');
  app.persistence.onSaved = () => {
    saved.textContent = 'Saved';
    setTimeout(() => {
      if (saved.textContent === 'Saved') saved.textContent = '';
    }, 2200);
  };
  const pLeft = iconButton('panelLeft', 'Toggle library panel', () => run('view.panel.left'));
  const pRight = iconButton('panelRight', 'Toggle inspector panel', () => run('view.panel.right'));
  const pBottom = iconButton('panelBottom', 'Toggle telemetry dock', () => run('view.panel.bottom'));
  const help = iconButton('keyboard', 'Keyboard shortcuts', () => run('help.shortcuts'));
  const search = iconButton('search', `Command palette (${formatShortcut('Mod+K')})`, () => run('app.palette'));
  const syncPanels = () => {
    pLeft.classList.toggle('on', prefs.value.showLeft);
    pRight.classList.toggle('on', prefs.value.showRight);
    pBottom.classList.toggle('on', prefs.value.showBottom);
  };
  prefs.on('change', syncPanels);
  syncPanels();

  const right = h(
    'div',
    { class: 'topbar-right' },
    saved,
    search,
    undo,
    redo,
    h('span', { style: { width: '8px' } }),
    pLeft,
    pBottom,
    pRight,
    help,
    appearanceButton(app), // -- VZ-50 --
  );
  return h(
    'header',
    { class: 'topbar' },
    brand,
    name,
    menubar,
    chip,
    h('div', { class: 'spacer' }),
    right,
    transport,
    createImportInput(app),
  );
}

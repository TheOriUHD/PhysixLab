import type { App } from '../app/app';
import { COLOR_MODE_LABELS, type ColorMode } from '../render/bodyViews';
import { newReport } from '../model/errors';
import { TEMPLATES } from '../model/templates';
import { iconButton, segmented } from './controls';
import { h } from './dom';
import { icon, LOGO } from './icons';
import { openMenu, type MenuItem } from './menu';
import { confirmDialog, promptText } from './modal';
import { showShortcuts, showWelcome } from './dialogs';
import { svg } from './dom';

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

  // ---- menus -----------------------------------------------------------------------------------
  const importFile = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  importFile.addEventListener('change', () => {
    const f = importFile.files?.[0];
    importFile.value = '';
    if (f) void importDocument(app, f);
  });

  const menus: [string, () => MenuItem[]][] = [
    [
      'File',
      () => [
        { label: 'New scene', icon: 'plus', action: () => newScene(app) },
        { heading: 'Examples' },
        ...TEMPLATES.map((t): MenuItem => ({
          label: t.name,
          action: () => confirmReplace(app, () => app.loadTemplate(t.id)),
        })),
        { sep: true },
        {
          label: 'Save to library',
          icon: 'save',
          kbd: 'Ctrl+S',
          action: () => {
            const e = app.persistence.saveToLibrary();
            if (e) app.toast(`Saved “${e.name}” to your scene library`, 'success');
          },
        },
        {
          label: 'Open scene library…',
          icon: 'folder',
          action: () => {
            prefs.set({ leftTab: 'scenes', showLeft: true });
          },
        },
        { sep: true },
        { label: 'Export scene file…', icon: 'download', action: () => app.persistence.exportFile() },
        { label: 'Import scene file…', icon: 'upload', action: () => importFile.click() },
        {
          label: 'Copy share link',
          icon: 'share',
          action: async () => {
            const url = await app.persistence.shareLink();
            try {
              await navigator.clipboard.writeText(url);
              app.toast(
                `Share link copied (${Math.round(url.length / 1000)} kB). Anyone opening it gets this scene.`,
                'success',
              );
            } catch {
              await promptText('Share link', 'Copy this link:', url, 'Done');
            }
          },
        },
      ],
    ],
    [
      'Edit',
      () => [
        {
          label: store.canUndo ? `Undo ${store.undoLabel}` : 'Undo',
          icon: 'undo',
          kbd: 'Ctrl+Z',
          disabled: !store.canUndo,
          action: () => store.undo(),
        },
        {
          label: store.canRedo ? `Redo ${store.redoLabel}` : 'Redo',
          icon: 'redo',
          kbd: 'Ctrl+Shift+Z',
          disabled: !store.canRedo,
          action: () => store.redo(),
        },
        { sep: true },
        {
          label: 'Duplicate',
          icon: 'copy',
          kbd: 'Ctrl+D',
          disabled: !store.selection.length,
          action: () => app.editor.duplicateSelection(),
        },
        { label: 'Copy', kbd: 'Ctrl+C', disabled: !store.selection.length, action: () => app.editor.copy() },
        { label: 'Paste', kbd: 'Ctrl+V', action: () => app.editor.paste() },
        {
          label: 'Delete',
          icon: 'trash',
          kbd: 'Del',
          disabled: !store.selection.length,
          action: () => app.editor.deleteSelection(),
        },
        { sep: true },
        { label: 'Select all', kbd: 'Ctrl+A', action: () => app.editor.selectAll() },
        {
          label: 'Rotate selection 90° about Y',
          disabled: !store.selectedBodies().length || sim.active,
          action: () => app.editor.rotateSelection90(),
        },
        { label: 'Frame selection', icon: 'frame', kbd: 'F', action: () => app.frameSelection() },
        { sep: true },
        {
          label: 'Use current simulation state as the starting layout',
          disabled: !sim.active,
          action: () => {
            const n = app.editor.captureLivePose();
            app.toast(`Captured ${n} body poses. Reset now returns to this state.`, 'success');
          },
        },
      ],
    ],
    [
      'View',
      () => {
        const p = prefs.value;
        const ov = p.overlays;
        const items: MenuItem[] = [{ heading: 'Colour bodies by' }];
        for (const m of Object.keys(COLOR_MODE_LABELS) as ColorMode[]) {
          items.push({
            label: COLOR_MODE_LABELS[m],
            checked: p.colorMode === m,
            action: () => prefs.set({ colorMode: m }),
          });
        }
        items.push(
          { sep: true },
          { heading: 'Overlays (live while simulating)' },
          {
            label: 'Velocity vectors',
            checked: ov.velocity,
            action: () => prefs.setOverlay({ velocity: !ov.velocity }),
          },
          { label: 'Net force vectors', checked: ov.force, action: () => prefs.setOverlay({ force: !ov.force }) },
          {
            label: 'Contact points & forces',
            checked: ov.contacts,
            action: () => prefs.setOverlay({ contacts: !ov.contacts }),
          },
          { label: 'Centres of mass', checked: ov.com, action: () => prefs.setOverlay({ com: !ov.com }) },
          {
            label: `Motion trails: ${ov.trails}`,
            action: () =>
              prefs.setOverlay({ trails: ov.trails === 'off' ? 'selected' : ov.trails === 'selected' ? 'all' : 'off' }),
            keepOpen: false,
          },
          { sep: true },
          {
            label: 'Show joints & constraints',
            checked: p.showJoints,
            action: () => prefs.set({ showJoints: !p.showJoints }),
          },
          {
            label: 'Camera follows selection',
            kbd: 'C',
            checked: p.followSelection,
            action: () => prefs.set({ followSelection: !p.followSelection }),
          },
          { sep: true },
          { heading: 'Graphics quality' },
          ...(['low', 'medium', 'high'] as const).map((q): MenuItem => ({
            label: { low: 'Low — fastest', medium: 'Medium — shadows + MSAA', high: 'High — shadows + AO + MSAA' }[q],
            checked: p.quality === q,
            action: () => prefs.set({ quality: q }),
          })),
          { sep: true },
          { label: 'Frame everything', kbd: 'Home', icon: 'frame', action: () => app.frameAll() },
        );
        return items;
      },
    ],
    [
      'Help',
      () => [
        { label: 'Keyboard shortcuts', icon: 'keyboard', action: () => showShortcuts() },
        { label: 'Welcome & quick start', icon: 'info', action: () => showWelcome(app) },
      ],
    ],
  ];

  const menubar = h('div', { class: 'menubar' });
  for (const [label, items] of menus) {
    const b = h('button', { class: 'menu-btn', type: 'button' }, label);
    b.addEventListener('click', () => {
      b.classList.add('open');
      openMenu(items(), b, () => b.classList.remove('open'));
      const obs = new MutationObserver(() => {
        if (!document.querySelector('.menu')) {
          b.classList.remove('open');
          obs.disconnect();
        }
      });
      obs.observe(document.body, { childList: true });
    });
    menubar.appendChild(b);
  }

  // ---- transport -------------------------------------------------------------------------------
  const playBtn = h('button', { class: 'tbtn play', type: 'button', title: 'Start / pause (Space)' });
  const stepBtn = h('button', { class: 'tbtn', type: 'button', title: 'Advance one physics step (.)' }, icon('step'));
  const resetBtn = h(
    'button',
    { class: 'tbtn', type: 'button', title: 'Stop and return to the editable layout (Shift+Space)' },
    icon('reset'),
  );
  const clock = h('div', { class: 'sim-clock', title: 'Simulated time' }, '0.00 s');
  playBtn.addEventListener('click', () => sim.toggle());
  stepBtn.addEventListener('click', () => sim.step(1));
  resetBtn.addEventListener('click', () => sim.reset());
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
  const undo = iconButton('undo', 'Undo (Ctrl+Z)', () => store.undo());
  const redo = iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => store.redo());
  const syncHistory = () => {
    undo.disabled = !store.canUndo;
    redo.disabled = !store.canRedo;
    undo.title = store.canUndo ? `Undo ${store.undoLabel} (Ctrl+Z)` : 'Undo';
    redo.title = store.canRedo ? `Redo ${store.redoLabel} (Ctrl+Shift+Z)` : 'Redo';
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
  const pLeft = iconButton('panelLeft', 'Toggle library panel', () => prefs.set({ showLeft: !prefs.value.showLeft }));
  const pRight = iconButton('panelRight', 'Toggle inspector panel', () =>
    prefs.set({ showRight: !prefs.value.showRight }),
  );
  const pBottom = iconButton('panelBottom', 'Toggle telemetry dock', () =>
    prefs.set({ showBottom: !prefs.value.showBottom }),
  );
  const help = iconButton('keyboard', 'Keyboard shortcuts', () => showShortcuts());
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
    undo,
    redo,
    h('span', { style: { width: '8px' } }),
    pLeft,
    pBottom,
    pRight,
    help,
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
    importFile,
  );
}

export async function confirmReplace(app: App, then: () => void): Promise<void> {
  const dirty = app.store.size > 0 && app.store.canUndo;
  if (
    !dirty ||
    (await confirmDialog(
      'Replace current scene?',
      'Your current scene is autosaved, but opening another one will replace it in the editor. Use “Save to library” first to keep a named copy.',
      'Replace scene',
    ))
  )
    then();
}

export async function newScene(app: App): Promise<void> {
  await confirmReplace(app, () => app.newScene());
}

export async function importDocument(app: App, file: File): Promise<void> {
  try {
    const report = newReport();
    const doc = await app.persistence.importFile(file, report);
    await confirmReplace(app, () => {
      app.loadDocument(doc, 'frame');
      app.toast(`Imported “${doc.name}”`, 'success');
      // Problems the loader repaired (an unknown shape, a broken link …) are worth knowing about.
      for (const w of report.warnings.slice(0, 2)) app.toast(w, 'warn');
      if (report.warnings.length > 2) app.toast(`…and ${report.warnings.length - 2} more repairs.`, 'warn');
    });
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}

import './styles/app.css';
import { App } from './app/app';
import { InputController } from './app/input';
import { Persistence } from './app/persistence';
import { newReport } from './model/errors';
import type { SceneDocument } from './model/types';
import { getTemplate } from './model/content';
import { buildDock } from './ui/telemetry';
import { buildLeftPanel } from './ui/leftPanel';
import { buildRightPanel } from './ui/rightPanel';
import { buildStatusbar } from './ui/statusbar';
import { createShell, wireShell } from './ui/shell';
import { buildToolbox } from './ui/toolbox';
import { buildTopbar, importDocument } from './ui/topbar';
import { mountToasts } from './ui/toasts';
import { showWelcome } from './ui/dialogs';
import { openMenu } from './ui/menu';

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const shell = createShell(root);
  const app = new App(shell);

  shell.topSlot.replaceWith(buildTopbar(app));
  shell.leftSlot.replaceWith(buildLeftPanel(app));
  shell.rightSlot.replaceWith(buildRightPanel(app));
  shell.dockSlot.replaceWith(buildDock(app));
  shell.footSlot.replaceWith(buildStatusbar(app));
  const { toolbox, viewbar } = buildToolbox(app);
  shell.floatSlot.replaceWith(toolbox, viewbar);
  mountToasts(app);
  wireShell(app, shell);
  const input = new InputController(app);
  app.viewport.controls.addEventListener('change', () => {
    /* camera moved */
  });

  input.onContextMenu = (ev) => {
    const hit = app.pickEntity(ev);
    if (hit && !app.store.selection.includes(hit.entityId)) app.store.setSelection([hit.entityId]);
    const has = app.store.selection.length > 0;
    openMenu(
      [
        { label: 'Frame', icon: 'frame', kbd: 'F', action: () => app.frameSelection() },
        {
          label: 'Duplicate',
          icon: 'copy',
          kbd: 'Ctrl+D',
          disabled: !has,
          action: () => app.editor.duplicateSelection(),
        },
        {
          label: 'Hide / show',
          icon: 'eye',
          kbd: 'H',
          disabled: !has,
          action: () => app.editor.toggleFlag(app.store.selection, 'hidden'),
        },
        {
          label: 'Lock / unlock',
          icon: 'lock',
          kbd: 'L',
          disabled: !has,
          action: () => app.editor.toggleFlag(app.store.selection, 'locked'),
        },
        { sep: true },
        { label: 'Delete', icon: 'trash', kbd: 'Del', disabled: !has, action: () => app.editor.deleteSelection() },
        { sep: true },
        {
          label: app.sim.active ? 'Reset simulation' : 'Simulate',
          icon: app.sim.active ? 'reset' : 'play',
          kbd: app.sim.active ? 'Shift+Space' : 'Space',
          action: () => (app.sim.active ? app.sim.reset() : app.sim.play()),
        },
      ],
      { x: ev.clientX, y: ev.clientY },
    );
  };

  // ---- initial scene: shared link > autosave > welcome example ---------------------------------
  let loaded = false;
  let viewSet = false;
  const hashReport = newReport();
  let fromHash: SceneDocument | null = null;
  try {
    fromHash = await Persistence.fromHash(location.hash, hashReport);
  } catch (e) {
    // A link that cannot be opened says why (damaged, newer format …) instead of silently showing another scene.
    app.toast((e as Error).message, 'error');
  }
  if (fromHash) {
    app.store.load(fromHash);
    loaded = true;
    app.toast(`Opened shared scene “${fromHash.name}”`, 'success');
    for (const w of hashReport.warnings.slice(0, 2)) app.toast(w, 'warn');
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!loaded) {
    const auto = app.persistence.loadAutosave();
    if (auto && auto.entities.length) {
      app.store.load(auto);
      loaded = true;
    }
  }
  const demo = new URLSearchParams(location.search).get('scene');
  if (demo && getTemplate(demo)) {
    app.loadTemplate(demo);
    loaded = true;
    viewSet = !!getTemplate(demo)?.view;
  }
  if (!loaded) {
    app.loadTemplate('car');
    viewSet = true;
  }
  const tv = demo ? getTemplate(demo)?.view : undefined;
  if (tv) app.viewport.setView(tv);
  else if (!viewSet) app.frameAll(false);
  app.updateToolHint();

  // Drag & drop a scene file anywhere to import it.
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f && /\.json$/i.test(f.name)) {
      e.preventDefault();
      void importDocument(app, f);
    }
  });

  app.start();
  // Exposed once the initial scene is in place — handy for debugging and relied on by the e2e tests.
  (window as unknown as { physicslab: App }).physicslab = app;
  if (!app.prefs.value.seenWelcome && !new URLSearchParams(location.search).has('nowelcome'))
    setTimeout(() => showWelcome(app), 400);
}

boot().catch((e: unknown) => {
  console.error(e);
  const root = document.getElementById('app')!;
  root.innerHTML = `<div style="padding:40px;max-width:640px;margin:auto;color:#dbe3ef;font:15px system-ui"><h2>PhysicsLab couldn’t start</h2><p>${String((e as { message?: unknown } | null)?.message ?? e)}</p><p style="color:#98a5b9">PhysicsLab needs a modern desktop browser with WebGL 2 and WebAssembly.</p></div>`;
});

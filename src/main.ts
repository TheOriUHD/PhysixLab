import './app/storage/legacyBoot';
import './styles/app.css';
import './styles/ed-select.css';
import './styles/ed-arrange.css';
import './styles/ed-snap.css';
import './styles/ed-hierarchy.css';
import './styles/ed-prefabs.css';
import './styles/ed-path.css';
import './styles/ed-array.css';
import './styles/ui-a.css';
import './styles/themes.css';
import './styles/vz-a.css';
import './styles/tm.css'; // -- TM --
import './styles/cm.css'; // -- CM-A --
import './styles/cm-touch.css'; // -- CM-A touch --
import './styles/diag.css';
import './styles/tour.css';
import './styles/vzb.css'; // -- VZ-B --
import './styles/dtb.css'; // -- DT-B --
import './styles/collab.css'; // -- DT-23 --
import './styles/jointsB.css'; // -- JT-B --
import './styles/sf.css'; // -- SF --
import './styles/joints.css';
import './styles/jointtool.css';
import './styles/sf-inspector.css'; // -- SF --
import './styles/data.css'; // -- DT --
import './styles/capture.css'; // -- DT-2 --
import './styles/embed.css'; // -- DT-22 --
import './styles/qol.css';
import './styles/nav.css'; // -- NAV: controls legend, context pill, drive HUD, immersive modes --
import { App } from './app/app';
import { InputController } from './app/input';
import { initDataPlatform } from './app/data/platform'; // -- DT
import { Persistence } from './app/persistence';
import { newReport } from './model/errors';
import type { SceneDocument } from './model/types';
import { getTemplate } from './model/content';
import { buildPanelRegion } from './ui/panelRegion';
import { buildStatusbar } from './ui/statusbar';
import { createShell, wireShell } from './ui/shell';
import { buildToolbox } from './ui/toolbox';
import { buildTopbar } from './ui/topbar';
import { mountToasts } from './ui/toasts';
import { mountUiA } from './ui/uiA';
import { showWelcome } from './ui/dialogs';
import { openMenu } from './ui/menu';
import { mountZoneHud } from './ui/zoneHud'; // -- ZN
import { resolveMenu } from './app/registry/menus';
import { installTimeTravel } from './app/timeTravel'; // -- TM
import { loadExtensions, registerBuiltins } from './ui/builtin';
import { PrefsStore } from './app/prefs';
import { applyTheme } from './ui/theme';
// -- ED-B: tool options bar --
import { mountToolOptions } from './ui/toolOptionsBar';
import './styles/ed-b-tools.css';
// -- ED-B --
import { setContextTarget } from './ui/contextTarget';
import './styles/ed-b.css';
import { attachDiagnostics, installDiagnostics, preflight, showBootFailure } from './ui/diag/boot'; // -- UI-B: error boundary --
import { publishApi } from './api/install';
import { installTour } from './ui/tour';
import { initPwa } from './pwa'; // -- DT-40 --
import { mountTouch } from './ui/touch'; // -- CM-A touch --
import { installQol } from './ui/qol/install';
import { mountNavUi } from './ui/input/navUi'; // -- NAV --

installDiagnostics(); // -- UI-B: error boundary --
import { readEmbedOptions } from './app/embed/options'; // -- DT-22 --
import { bootHide, bootStep } from './app/bootProgress'; // start-up splash milestones

async function boot(): Promise<void> {
  bootStep('boot');
  if (!preflight()) {
    bootHide(); // the capability screen explains what is missing
    return; // -- UI-B: capability check --
  }
  // -- VZ-50: paint the stored theme before anything is built (no flash of the default theme) --
  const early = new PrefsStore().value;
  applyTheme(early.theme, early.accent);
  // Everything the UI offers is a registration; register the built-ins before any UI is built.
  registerBuiltins();
  const extensionFailures = await loadExtensions();
  const root = document.getElementById('app')!;
  const shell = createShell(root);
  const app = new App(shell);
  // The physics worker reports back once its wasm is compiled (it may already have, on a warm cache).
  if (app.sim.client.workerProtocol !== null) bootStep('engine');
  else app.sim.client.on('ready', () => bootStep('engine'));
  attachDiagnostics(app); // -- UI-B --
  // -- DT-22: `?embed=1` boots the minimal-chrome viewer instead of the editor --
  const embedOptions = readEmbedOptions(location.search);
  if (embedOptions) {
    const { bootEmbed } = await import('./ui/embed/boot');
    const bridge = await bootEmbed(app, shell, embedOptions);
    app.start();
    (window as unknown as { physixlab: App }).physixlab = app;
    bridge.announceReady();
    bootHide(); // the embed shows its own loading state
    return;
  }
  // -- end DT-22 --

  shell.topSlot.replaceWith(buildTopbar(app));
  // The three docked regions are generated from the panel registry.
  shell.leftSlot.replaceWith(
    buildPanelRegion(app, {
      region: 'left',
      rootTag: 'aside',
      rootClass: 'panel left',
      headClass: 'tabs',
      // Four tabs do not fit next to their icons in the 268 px panel; the text-only strip does.
      icons: false,
    }),
  );
  shell.rightSlot.replaceWith(
    buildPanelRegion(app, {
      region: 'right',
      rootTag: 'aside',
      rootClass: 'panel right',
      headClass: 'tabs',
      icons: true,
    }),
  );
  shell.dockSlot.replaceWith(
    buildPanelRegion(app, {
      region: 'bottom',
      rootTag: 'div',
      rootClass: 'dock',
      headClass: 'dock-head',
      icons: false,
      collapseWhenOff: true,
    }),
  );
  shell.footSlot.replaceWith(buildStatusbar(app));
  const { toolbox, viewbar } = buildToolbox(app);
  shell.floatSlot.replaceWith(toolbox, viewbar);
  mountToasts(app);
  mountToolOptions(app); // -- ED-B --
  // -- UI-A: simple / advanced mode, quick-properties bar --
  mountUiA(app);
  mountZoneHud(app, shell.stage); // -- ZN: race board, score and event feed over the viewport
  wireShell(app, shell);
  const input = new InputController(app);
  mountTouch(app, input); // -- CM-A touch: gestures + on-screen controls --
  app.viewport.controls.addEventListener('change', () => {
    /* camera moved */
  });

  mountNavUi(app, shell.stage); // -- NAV: controls legend + context pill, drive HUD --
  bootStep('ui');
  input.onContextMenu = (ev) => {
    if (app.immersive.active) return; // -- NAV: no editor menus in drive / play mode --
    const hit = app.pickEntity(ev);
    if (hit && !app.store.selection.includes(hit.entityId)) app.store.setSelection([hit.entityId]);
    // -- ED-B: remember where the user clicked; right-clicking nothing clears the selection --
    if (!hit) app.store.setSelection([]);
    const gp = hit ? hit.point : app.picker.groundPoint(ev, 0);
    setContextTarget(gp ? [gp.x, gp.y, gp.z] : null);
    openMenu(resolveMenu(app, 'context'), { x: ev.clientX, y: ev.clientY });
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
  // -- DT-10: open IndexedDB storage (migrates old localStorage data) before reading the autosave --
  const storageState = await app.persistence.init();
  if (storageState.warning) app.toast(storageState.warning, 'warn');
  // -- DT-11/12: restore points, crash detection, worker-crash handling --
  const data = await initDataPlatform(app);
  let restoredFrom: 'autosave' | 'restore-point' | 'none' = 'none';
  if (!loaded) {
    const auto = app.persistence.loadAutosave();
    if (auto && auto.entities.length) {
      app.store.load(auto);
      loaded = true;
      restoredFrom = 'autosave';
    } else if (data.crash.crashed) {
      // The autosave is gone or empty after a crash: fall back to the newest restore point.
      const rp = await data.recoveryDoc();
      if (rp && rp.entities.length) {
        app.store.load(rp);
        loaded = true;
        restoredFrom = 'restore-point';
      }
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
  bootStep('scene');
  data.announceRecovery(restoredFrom); // -- DT-12

  // Drag & drop of files (scenes …) is installed by installQol(app) below, with its drop overlay.

  for (const f of extensionFailures) app.toast(`Extension ${f.file} failed to load: ${f.error.message}`, 'error');
  initPwa(app); // -- DT-40: service worker (production only), update banner, file / share intake --
  installTimeTravel(app); // -- TM: timeline, rewind, replays, ghosts --
  app.start();
  // Two animation frames after the render loop starts: the first real frame has been drawn and shown.
  requestAnimationFrame(() => requestAnimationFrame(() => bootStep('frame')));
  installTour(app); // -- UI-B: guided tours, context hints, tips --
  installQol(app); // UI-B: presentation mode, recents, drop overlay, clipboard paste
  // Exposed once the initial scene is in place — handy for debugging and relied on by the e2e tests.
  // -- DT-30: the versioned public API (src/api); falls through to the App for the internal members --
  (window as unknown as { physixlab: App }).physixlab = publishApi(app);
  window.dispatchEvent(new Event('physixlab:ready')); // -- DT-31: lets installed plugins start --
  if (!app.prefs.value.seenWelcome && !new URLSearchParams(location.search).has('nowelcome'))
    setTimeout(() => showWelcome(app), 400);
}

boot().catch(showBootFailure); // -- UI-B: plain-language boot failure screen --

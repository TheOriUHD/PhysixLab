/**
 * Boots the minimal-chrome viewer (DT-22): `?embed=1&scene=<id>` or `?embed=1#s=<payload>`. Called from main.ts
 * instead of building the editor chrome. Editing is locked: no panels, menus, toolbox, shortcuts or autosave; the
 * pointer can only grab bodies of a running simulation, and only with `interact=1`.
 */
import type { App } from '../../app/app';
import { EmbedBridge } from '../../app/embed/bridge';
import type { EmbedOptions } from '../../app/embed/options';
import { InputController } from '../../app/input';
import { Persistence } from '../../app/persistence';
import { newReport } from '../../model/errors';
import { getTemplate } from '../../model/content';
import type { SceneDocument } from '../../model/types';
import type { ShellDom } from '../shell';
import { h } from '../dom';
import { buildEmbedBar } from './bar';

const DEFAULT_TEMPLATE = 'car';

export async function bootEmbed(app: App, shell: ShellDom, opts: EmbedOptions): Promise<EmbedBridge> {
  app.prefs.ephemeral = true;
  shell.root.classList.add('embed', 'no-left', 'no-right');
  document.documentElement.classList.add('embed-page');
  const bridge = new EmbedBridge(app, opts);
  const problems: string[] = [];
  // Nothing can be selected, so nothing can be edited.
  app.store.on('selection', (ids) => {
    if (ids.length) app.store.setSelection([]);
  });

  // ---- the scene: share payload in the hash > ?scene=<template> > the default example ---------------------------
  let doc: SceneDocument | null = null;
  try {
    doc = await Persistence.fromHash(location.hash, newReport());
  } catch (e) {
    problems.push((e as Error).message);
  }
  let template = opts.scene;
  if (doc) {
    app.store.load(doc);
    app.frameAll(false);
  } else {
    if (template && !getTemplate(template)) {
      problems.push(`There is no example scene called “${template}”.`);
      template = null;
    }
    template ??= DEFAULT_TEMPLATE;
    app.loadTemplate(template);
    const view = getTemplate(template)?.view;
    if (view) {
      app.viewport.setView(view);
      bridge.setHome(view);
    }
  }
  app.sim.reset();

  // ---- camera, selection, input -------------------------------------------------------------------------------
  if (opts.camera === 'fixed') app.viewport.controls.enabled = false;
  app.prefs.set({ followSelection: false });
  const viewportDom = app.viewport.dom;
  if (opts.interact) {
    // Grabbing only while the simulation runs: a press in edit mode would drag the body in the document.
    viewportDom.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && !app.sim.active) e.stopImmediatePropagation();
    });
    viewportDom.addEventListener('dblclick', (e) => e.stopImmediatePropagation());
    window.addEventListener('keydown', (e) => keyDown(app, e), true);
    new InputController(app);
  } else {
    window.addEventListener('keydown', (e) => keyDown(app, e), true);
    window.addEventListener('keyup', (e) => app.input.keyUp(e));
    window.addEventListener('blur', () => app.input.clearKeys());
  }
  // The context menu of the editor does not exist here; keep the browser's out of the way of right-drag orbiting.
  viewportDom.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- chrome: the slim bar and a notice for anything that went wrong -------------------------------------------
  if (opts.controls) shell.stage.appendChild(buildEmbedBar(app, () => bridge.resetCamera()));
  if (problems.length) {
    const note = h('div', { class: 'embed-notice', role: 'alert' }, problems.join(' '));
    shell.stage.appendChild(note);
    for (const p of problems) bridge.reportError('bad-scene', p);
  }

  if (opts.autoplay) app.sim.play();
  return bridge;
}

/** Keys drive the running simulation (motor / thruster bindings); nothing else is bound to a key in the viewer. */
function keyDown(app: App, e: KeyboardEvent): void {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  const forward = app.sim.active && !e.ctrlKey && !e.metaKey && !e.altKey;
  app.input.keyDown(e, forward);
  if (forward && (e.code.startsWith('Arrow') || e.code === 'Space')) e.preventDefault();
  // Stop the editor's own shortcut handling (registered later, on window) from seeing the key.
  e.stopImmediatePropagation();
}

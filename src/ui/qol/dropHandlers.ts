/**
 * Drag & drop of files onto the window (UI-42): a registry of importers per file kind, the full-window overlay that
 * says what a drop will do, and the drop itself. Kinds without a registered importer get an honest message
 * ("Replays aren't supported yet") instead of a pretend import. Another package that adds an importer (meshes,
 * images, prefab packs …) calls `registerDropHandler(kind, …)` and the overlay and the drop pick it up.
 */
import type { App } from '../../app/app';
import { h } from '../dom';
import { icon } from '../icons';
import { classifyByName, describeDrag, sniffJsonKind, unsupportedMessage, type DropKind } from './dropKinds';
import { importSceneText } from './sceneImport';

export interface DropHandler {
  /** Import the file. `text` is given for JSON files (already read for sniffing). */
  handle(app: App, file: File, text: string | null): void | Promise<void>;
}

const handlers = new Map<DropKind, DropHandler>();

/** Register (or replace) the importer of a kind. Returns the function that removes it. */
export function registerDropHandler(kind: DropKind, handler: DropHandler): () => void {
  handlers.set(kind, handler);
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

export const supportedDropKinds = (): ReadonlySet<DropKind> => new Set(handlers.keys());

// The only importer that exists on this branch: scene files.
registerDropHandler('scene', {
  handle: (app, _file, text) =>
    importSceneText(app, text ?? '', 'file').then(
      () => undefined,
      () => undefined,
    ),
});

/** Work out what each dropped file is and import it, or say plainly that it cannot be. */
export async function handleDroppedFiles(app: App, files: readonly File[]): Promise<void> {
  let opened = false;
  const skipped: string[] = [];
  for (const file of files) {
    let kind = classifyByName(file.name, file.type);
    let text: string | null = null;
    if (kind === 'json' || kind === 'unknown') {
      // Scenes, replays and prefab packs are all JSON: look inside (size-capped; huge files are not read as text).
      if (file.size <= 64 * 1024 * 1024 && (kind === 'json' || file.size < 2 * 1024 * 1024)) {
        try {
          text = await file.text();
        } catch {
          text = null;
        }
        const sniffed = text === null ? 'unknown' : sniffJsonKind(text);
        if (sniffed !== 'unknown') kind = sniffed;
      }
    }
    // A file named like a PhysicsLab export is opened as a scene so a damaged one reports what is wrong with it.
    if (kind === 'json' && /physicslab/i.test(file.name)) kind = 'scene';
    const handler = handlers.get(kind);
    if (!handler) {
      app.toast(unsupportedMessage(kind, file.name), 'warn');
      continue;
    }
    if (kind === 'scene' && opened) {
      skipped.push(file.name);
      continue;
    }
    if (kind === 'scene') opened = true;
    await handler.handle(app, file, text);
  }
  if (skipped.length) app.toast(`Only one scene opens at a time; skipped ${skipped.join(', ')}.`, 'info');
}

// ---- the overlay -----------------------------------------------------------------------------------------------

function buildOverlay(): { el: HTMLElement; set: (title: string, detail: string, ok: boolean) => void } {
  const title = h('div', { class: 'qol-drop-title' });
  const detail = h('div', { class: 'qol-drop-detail' });
  const card = h('div', { class: 'qol-drop-card' }, icon('upload', 'icon big'), title, detail);
  const el = h('div', { class: 'qol-drop', 'aria-hidden': 'true' }, card);
  el.dataset.qol = 'drop';
  return {
    el,
    set(t, d, ok) {
      title.textContent = t;
      detail.textContent = d;
      detail.style.display = d ? '' : 'none';
      el.classList.toggle('bad', !ok);
    },
  };
}

/** Install the window-wide drop target (replaces the minimal scene-only handler main.ts used to have). */
export function installDropTarget(app: App): void {
  const overlay = buildOverlay();
  document.body.appendChild(overlay.el);
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  const hide = () => {
    depth = 0;
    overlay.el.classList.remove('show');
  };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    const items = Array.from(e.dataTransfer?.items ?? [], (i) => ({ kind: i.kind, type: i.type }));
    const d = describeDrag(items, supportedDropKinds());
    overlay.set(d.title, d.detail, d.ok);
    overlay.el.classList.add('show');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // makes the window a valid drop target
    if (e.dataTransfer) e.dataTransfer.dropEffect = overlay.el.classList.contains('bad') ? 'none' : 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });
  window.addEventListener('dragend', hide);
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void handleDroppedFiles(app, files);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
}

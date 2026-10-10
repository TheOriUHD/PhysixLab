/** Scene-level actions shared by the menus, the library panels, the command palette and drag & drop. */
import type { App } from '../app/app';
import { newReport } from '../model/errors';
import { confirmDialog } from './modal';

/** Ask before replacing a scene that has unsaved edits; then run `then`. */
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
      app.loadDocument(doc, 'frame', { kind: 'file' });
      app.toast(`Imported “${doc.name}”`, 'success');
      // Problems the loader repaired (an unknown shape, a broken link …) are worth knowing about.
      for (const w of report.warnings.slice(0, 2)) app.toast(w, 'warn');
      if (report.warnings.length > 2) app.toast(`…and ${report.warnings.length - 2} more repairs.`, 'warn');
    });
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}

let importInput: HTMLInputElement | null = null;

/**
 * The page's hidden file input for "Import scene file…". The top bar owns it (so it is in the DOM from the start,
 * where tests and assistive tools can find it); the `file.import` command — from the menu, the palette or anywhere
 * else — just clicks it.
 */
export function createImportInput(app: App): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) void importDocument(app, f);
  });
  importInput = input;
  return input;
}

/** Open the browser's file picker for a scene file. */
export function pickAndImportDocument(): void {
  importInput?.click();
}

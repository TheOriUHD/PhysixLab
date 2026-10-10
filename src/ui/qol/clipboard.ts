/**
 * Paste a scene from the clipboard (UI-42). Ctrl+V keeps pasting copied entities; only when the clipboard text is a
 * PhysicsLab scene (and the focus is not in a text field) is the paste taken over and offered as "open this scene".
 * The File menu / palette command reads the clipboard explicitly for the same thing.
 */
import type { App } from '../../app/app';
import { claimPaste } from '../../app/pasteClaim';
import { confirmDialog } from '../modal';
import { sniffSceneText } from './clipboardScene';
import { importSceneText } from './sceneImport';

const isEditable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
};

/** Ask, then open the scene held in `text`. Returns false when the text is not a scene. */
export async function offerPastedScene(app: App, text: string): Promise<boolean> {
  const sniff = sniffSceneText(text);
  if (!sniff) return false;
  const ok = await confirmDialog(
    'Paste scene from clipboard?',
    `The clipboard holds the scene “${sniff.name}” (${sniff.entities} object${sniff.entities === 1 ? '' : 's'}). Opening it replaces the current scene; your current scene is autosaved.`,
    'Open pasted scene',
  );
  if (ok) await importSceneText(app, text, 'paste', true);
  return true;
}

export function installClipboardPaste(app: App): void {
  window.addEventListener('paste', (e) => {
    if (isEditable(e.target)) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!sniffSceneText(text)) return;
    e.preventDefault();
    claimPaste();
    void offerPastedScene(app, text);
  });
}

/** The "Paste scene from clipboard" command: reads the clipboard (the browser may ask for permission). */
export async function pasteSceneFromClipboard(app: App): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    app.toast(
      'The browser did not let PhysicsLab read the clipboard. Click the page and press Ctrl+V instead.',
      'warn',
    );
    return;
  }
  if (!(await offerPastedScene(app, text))) app.toast('The clipboard does not hold a PhysicsLab scene.', 'warn');
}

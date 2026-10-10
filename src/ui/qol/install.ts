/** One call from main.ts (after `app.start()`): wires every browser-side listener of UI-41 and UI-42. */
import type { App } from '../../app/app';
import { getPresenter } from '../present/presenter';
import { installClipboardPaste } from './clipboard';
import { installDropTarget } from './dropHandlers';
import { installRecentScenes } from './recentScenes';

let installed = false;

export function installQol(app: App): void {
  if (installed) return;
  installed = true;
  getPresenter(app); // restores the remembered lighting / lens and listens for Esc
  installRecentScenes(app);
  installDropTarget(app);
  installClipboardPaste(app);
}

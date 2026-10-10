// -- UI-B: quality of life (UI-42): "Open recent" in the File menu, paste scene from the clipboard --
import { registerCommand, registerMenuEntry } from '../../app/registry';
import type { MenuItem } from '../../app/registry/menus';
import { pasteSceneFromClipboard } from '../qol/clipboard';
import { ago } from '../qol/recents';
import { openRecent } from '../qol/recentScenes';
import { recentScenes } from '../qol/stores';

registerCommand({
  id: 'file.pasteScene',
  label: 'Paste scene from clipboard',
  category: 'File',
  icon: 'copy',
  description: 'Open a PhysixLab scene that was copied as JSON text',
  keywords: ['clipboard', 'json', 'import', 'paste'],
  run: ({ app }) => pasteSceneFromClipboard(app),
});

registerCommand({
  id: 'file.clearRecent',
  label: 'Clear recent scenes',
  category: 'File',
  icon: 'trash',
  palette: true,
  enabled: () => recentScenes().list().length > 0,
  run: ({ app }) => {
    recentScenes().clear();
    app.toast('Recent scenes cleared');
  },
});

// The menu has no nested submenus, so the recent scenes are a headed block right under "New scene".
registerMenuEntry({
  id: 'menu.file.recent',
  menu: 'file',
  group: 'scene',
  order: 105,
  items: (app): MenuItem[] => {
    const list = recentScenes().list().slice(0, 8);
    if (!list.length)
      return [{ heading: 'Open recent' }, { label: 'No recent scenes yet', action: () => undefined, disabled: true }];
    return [
      { heading: 'Open recent' },
      ...list.map((e): MenuItem => ({
        label: e.name,
        kbd: ago(e.at),
        icon: 'folder',
        action: () => openRecent(app, e),
      })),
      { label: 'Clear recent scenes', action: () => recentScenes().clear(), icon: 'trash' },
    ];
  },
});

registerMenuEntry({
  id: 'menu.file.pasteScene',
  menu: 'file',
  group: 'io',
  order: 315,
  command: 'file.pasteScene',
  icon: 'copy',
});

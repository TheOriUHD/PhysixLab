/**
 * Built-in commands that open dialogs or pickers (so they need the DOM). The rest are in
 * `src/app/builtin/commands.ts`.
 */
import type { CommandDef } from '../../app/registry/commands';
import { showShortcuts, showWelcome } from '../dialogs';
import { togglePalette } from '../palette/palette';
import { promptText } from '../modal';
import { newScene, pickAndImportDocument } from '../sceneActions';

export function uiCommands(): CommandDef[] {
  return [
    {
      id: 'file.new',
      label: 'New scene',
      category: 'File',
      icon: 'plus',
      keywords: ['empty', 'blank', 'clear'],
      run: ({ app }) => newScene(app),
    },
    {
      id: 'file.import',
      label: 'Import scene file…',
      category: 'File',
      icon: 'upload',
      keywords: ['open', 'load', 'json'],
      run: () => pickAndImportDocument(),
    },
    {
      id: 'file.share',
      label: 'Copy share link',
      category: 'File',
      icon: 'share',
      description: 'Pack the scene into a URL; anyone opening it gets this scene',
      keywords: ['url', 'send'],
      run: async ({ app }) => {
        let url: string;
        try {
          url = await app.persistence.shareLink();
        } catch (e) {
          app.toast((e as Error).message, 'error');
          return;
        }
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
    {
      id: 'app.palette',
      label: 'Command palette',
      category: 'Help',
      icon: 'search',
      description: 'Search every command, setting, scene, prefab and map',
      shortcut: 'Mod+K',
      palette: false,
      allowWhileTyping: true,
      // Not over a dialog: Esc would close the dialog first and the palette would be stranded behind it.
      enabled: () => typeof document === 'undefined' || !document.querySelector('.modal-back'),
      run: ({ app }) => togglePalette(app),
    },
    {
      id: 'help.shortcuts',
      label: 'Keyboard shortcuts',
      category: 'Help',
      icon: 'keyboard',
      keywords: ['keys', 'hotkeys', 'cheat sheet'],
      shortcut: '?',
      run: () => showShortcuts(),
    },
    {
      id: 'help.welcome',
      label: 'Welcome & quick start',
      category: 'Help',
      icon: 'info',
      keywords: ['intro', 'tutorial', 'getting started'],
      run: ({ app }) => showWelcome(app),
    },
  ];
}

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
        let info;
        try {
          info = await app.persistence.shareInfo();
        } catch (e) {
          app.toast((e as Error).message, 'error');
          return;
        }
        if (info.tooLarge) {
          app.toast(
            `This scene is too large for a link (${Math.round(info.url.length / 1000)} kB). Saving it as a file instead — files have no size limit.`,
            'warn',
          );
          app.persistence.exportFile();
          return;
        }
        const url = info.url;
        const saved = Math.max(0, Math.round((1 - info.chars / info.v1Chars) * 100));
        const size = `${(url.length / 1000).toFixed(1)} kB${info.format === 'v2' && saved > 0 ? `, ${saved} % shorter than before` : ''}`;
        try {
          await navigator.clipboard.writeText(url);
          app.toast(`Share link copied (${size}). Anyone opening it gets this scene.`, 'success');
        } catch {
          await promptText('Share link', `Copy this link (${size}):`, url, 'Done');
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
      run: ({ app }) => showShortcuts(app),
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

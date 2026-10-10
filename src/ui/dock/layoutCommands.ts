/** Layout commands + View-menu entries (UI-1): presets, save / recall / delete layouts, reset, maximise. */
import type { CommandDef } from '../../app/registry/commands';
import { registerMenuEntry, type MenuEntryDef } from '../../app/registry/menus';
import { openMenu } from '../menu';
import { promptText } from '../modal';
import { getDock, peekDock } from './dockManager';
import { BUILTIN_PRESETS } from './presets';

export function layoutCommands(): CommandDef[] {
  const cmds: CommandDef[] = BUILTIN_PRESETS.map((p) => ({
    id: `layout.preset.${p.id}`,
    label: `Layout: ${p.label}`,
    category: 'View',
    icon: 'panelRight',
    description: p.description,
    keywords: ['layout', 'workspace', 'panels', p.id],
    run: ({ app }) => getDock(app).applyPreset(p.spec),
  }));
  cmds.push(
    {
      id: 'layout.reset',
      label: 'Reset layout',
      category: 'View',
      icon: 'reset',
      description: 'Put every panel back where it started',
      keywords: ['layout', 'panels', 'default', 'dock'],
      run: ({ app }) => getDock(app).resetLayout(),
    },
    {
      id: 'layout.save',
      label: 'Save layout as…',
      category: 'View',
      icon: 'save',
      description: 'Remember the current arrangement of the panels under a name',
      keywords: ['layout', 'panels', 'store'],
      run: async ({ app }) => {
        const name = await promptText('Save layout', 'Name of the layout', 'My layout', 'Save');
        if (name) {
          getDock(app).saveCurrent(name.slice(0, 40));
          app.toast(`Layout “${name}” saved`, 'success');
        }
      },
    },
    {
      id: 'layout.delete',
      label: 'Delete a saved layout…',
      category: 'View',
      icon: 'trash',
      keywords: ['layout', 'remove'],
      enabled: (app) => (peekDock(app)?.saved.length ?? 0) > 0,
      run: ({ app }) => {
        const dock = getDock(app);
        openMenu(
          dock.saved.map((s) => ({ label: `Delete “${s.name}”`, action: () => dock.deleteSaved(s.name) })),
          { x: window.innerWidth / 2 - 100, y: 120 },
        );
      },
    },
    {
      id: 'layout.maximise',
      label: 'Maximise / restore panel',
      category: 'View',
      icon: 'frame',
      description: 'Blow the panel you used last up to the full window (Esc restores)',
      keywords: ['layout', 'fullscreen', 'zoom panel'],
      run: ({ app }) => getDock(app).toggleMaximise(),
    },
  );
  return cmds;
}

export function registerLayoutMenu(): (() => void)[] {
  const entries: MenuEntryDef[] = [
    { id: 'menu.view.layoutHeading', menu: 'view', group: 'layout', order: 600, heading: 'Layout' },
    ...BUILTIN_PRESETS.map((p, i): MenuEntryDef => ({
      id: `menu.view.layout.${p.id}`,
      menu: 'view',
      group: 'layout',
      order: 610 + i,
      command: `layout.preset.${p.id}`,
      label: p.label,
    })),
    {
      id: 'menu.view.layout.saved',
      menu: 'view',
      group: 'layout',
      order: 650,
      items: (app) =>
        (peekDock(app)?.saved ?? []).map((s) => ({
          label: s.name,
          icon: 'panelRight',
          action: () => void getDock(app).applySaved(s.name),
        })),
    },
    { id: 'menu.view.layout.save', menu: 'view', group: 'layout', order: 660, command: 'layout.save' },
    { id: 'menu.view.layout.reset', menu: 'view', group: 'layout', order: 670, command: 'layout.reset' },
  ];
  return entries.map((e) => registerMenuEntry(e));
}

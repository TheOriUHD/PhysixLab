/**
 * The built-in menus: the menu bar (File, Edit, View, Help) and the viewport context menu, as registrations that
 * point at commands. Labels, shortcuts, enabled and check states all come from the commands.
 */
import type { App } from '../../app/app';
import { COLOR_MODE_LABELS, type ColorMode } from '../../render/bodyViews';
import { QUALITY_MENU_LABELS } from '../../app/builtin/commands';
import { listTemplates } from '../../model/content';
import { registerMenu, registerMenuEntry, type MenuEntryDef, type MenuItem } from '../../app/registry/menus';
import { confirmReplace } from '../sceneActions';

const hasSelection = (app: App) => app.store.selection.length > 0;

export function registerBuiltinMenus(): (() => void)[] {
  const offs: (() => void)[] = [];
  offs.push(
    registerMenu({ id: 'file', label: 'File', order: 10 }),
    registerMenu({ id: 'edit', label: 'Edit', order: 20 }),
    registerMenu({ id: 'view', label: 'View', order: 30 }),
    registerMenu({ id: 'help', label: 'Help', order: 90 }),
    registerMenu({ id: 'context', label: 'Viewport', order: 100, bar: false }),
  );
  const entries: MenuEntryDef[] = [
    // ── File ──
    { id: 'menu.file.new', menu: 'file', group: 'scene', order: 100, command: 'file.new', icon: 'plus' },
    { id: 'menu.file.examples', menu: 'file', group: 'scene', order: 110, heading: 'Examples' },
    {
      id: 'menu.file.templates',
      menu: 'file',
      group: 'scene',
      order: 120,
      items: (app): MenuItem[] =>
        listTemplates().map((t) => ({
          label: t.name,
          action: () => confirmReplace(app, () => app.loadTemplate(t.id)),
        })),
    },
    { id: 'menu.file.save', menu: 'file', group: 'library', order: 200, command: 'file.save', icon: 'save' },
    { id: 'menu.file.library', menu: 'file', group: 'library', order: 210, command: 'file.library', icon: 'folder' },
    { id: 'menu.file.export', menu: 'file', group: 'io', order: 300, command: 'file.export', icon: 'download' },
    { id: 'menu.file.import', menu: 'file', group: 'io', order: 310, command: 'file.import', icon: 'upload' },
    { id: 'menu.file.share', menu: 'file', group: 'io', order: 320, command: 'file.share', icon: 'share' },

    // ── Edit ──
    { id: 'menu.edit.undo', menu: 'edit', group: 'history', order: 100, command: 'edit.undo', icon: 'undo' },
    { id: 'menu.edit.redo', menu: 'edit', group: 'history', order: 110, command: 'edit.redo', icon: 'redo' },
    {
      id: 'menu.edit.duplicate',
      menu: 'edit',
      group: 'clipboard',
      order: 200,
      command: 'edit.duplicate',
      icon: 'copy',
    },
    { id: 'menu.edit.copy', menu: 'edit', group: 'clipboard', order: 210, command: 'edit.copy' },
    { id: 'menu.edit.paste', menu: 'edit', group: 'clipboard', order: 220, command: 'edit.paste' },
    { id: 'menu.edit.delete', menu: 'edit', group: 'clipboard', order: 230, command: 'edit.delete', icon: 'trash' },
    { id: 'menu.edit.selectAll', menu: 'edit', group: 'select', order: 300, command: 'edit.selectAll' },
    {
      id: 'menu.edit.group',
      menu: 'edit',
      group: 'select',
      order: 310,
      command: 'edit.group',
      icon: 'group',
      // With nothing selected Ctrl+G adds an empty group, but the menu item is about grouping the selection.
      enabled: hasSelection,
    },
    { id: 'menu.edit.ungroup', menu: 'edit', group: 'select', order: 320, command: 'edit.ungroup' },
    { id: 'menu.edit.rotate90', menu: 'edit', group: 'select', order: 330, command: 'edit.rotate90' },
    { id: 'menu.edit.frame', menu: 'edit', group: 'select', order: 340, command: 'view.frameSelection', icon: 'frame' },
    { id: 'menu.edit.capture', menu: 'edit', group: 'sim', order: 400, command: 'edit.capture' },

    // ── View ──
    { id: 'menu.view.colorHeading', menu: 'view', group: 'color', order: 100, heading: 'Colour bodies by' },
    ...(Object.keys(COLOR_MODE_LABELS) as ColorMode[]).map((m, i): MenuEntryDef => ({
      id: `menu.view.color.${m}`,
      menu: 'view',
      group: 'color',
      order: 110 + i,
      command: `view.color.${m}`,
      label: COLOR_MODE_LABELS[m],
    })),
    {
      id: 'menu.view.overlaysHeading',
      menu: 'view',
      group: 'overlays',
      order: 200,
      heading: 'Overlays (live while simulating)',
    },
    { id: 'menu.view.velocity', menu: 'view', group: 'overlays', order: 210, command: 'view.overlay.velocity' },
    { id: 'menu.view.force', menu: 'view', group: 'overlays', order: 220, command: 'view.overlay.force' },
    { id: 'menu.view.contacts', menu: 'view', group: 'overlays', order: 230, command: 'view.overlay.contacts' },
    { id: 'menu.view.com', menu: 'view', group: 'overlays', order: 240, command: 'view.overlay.com' },
    { id: 'menu.view.trails', menu: 'view', group: 'overlays', order: 250, command: 'view.overlay.trails' },
    { id: 'menu.view.joints', menu: 'view', group: 'scene', order: 300, command: 'view.joints' },
    { id: 'menu.view.follow', menu: 'view', group: 'scene', order: 310, command: 'view.follow' },
    { id: 'menu.view.qualityHeading', menu: 'view', group: 'quality', order: 400, heading: 'Graphics quality' },
    ...(['low', 'medium', 'high'] as const).map((q, i): MenuEntryDef => ({
      id: `menu.view.quality.${q}`,
      menu: 'view',
      group: 'quality',
      order: 410 + i,
      command: `view.quality.${q}`,
      label: QUALITY_MENU_LABELS[q],
    })),
    { id: 'menu.view.frameAll', menu: 'view', group: 'camera', order: 500, command: 'view.frameAll', icon: 'frame' },

    // ── Help ──
    { id: 'menu.help.shortcuts', menu: 'help', group: 'help', order: 100, command: 'help.shortcuts', icon: 'keyboard' },
    { id: 'menu.help.palette', menu: 'help', group: 'help', order: 90, command: 'app.palette', icon: 'search' },
    { id: 'menu.help.welcome', menu: 'help', group: 'help', order: 110, command: 'help.welcome', icon: 'info' },

    // ── right-click in the viewport ──
    {
      id: 'menu.context.frame',
      menu: 'context',
      group: 'object',
      order: 100,
      command: 'view.frameSelection',
      label: 'Frame',
      icon: 'frame',
    },
    {
      id: 'menu.context.duplicate',
      menu: 'context',
      group: 'object',
      order: 110,
      command: 'edit.duplicate',
      icon: 'copy',
    },
    {
      id: 'menu.context.hide',
      menu: 'context',
      group: 'object',
      order: 120,
      command: 'edit.hide',
      label: 'Hide / show',
      icon: 'eye',
    },
    {
      id: 'menu.context.lock',
      menu: 'context',
      group: 'object',
      order: 130,
      command: 'edit.lock',
      label: 'Lock / unlock',
      icon: 'lock',
    },
    { id: 'menu.context.delete', menu: 'context', group: 'delete', order: 200, command: 'edit.delete', icon: 'trash' },
    {
      id: 'menu.context.simulate',
      menu: 'context',
      group: 'sim',
      order: 300,
      command: (app) => (app.sim.active ? 'sim.reset' : 'sim.toggle'),
      label: (app) => (app.sim.active ? 'Reset simulation' : 'Simulate'),
      icon: (app) => (app.sim.active ? 'reset' : 'play'),
    },
  ];
  for (const e of entries) offs.push(registerMenuEntry(e));
  return offs;
}

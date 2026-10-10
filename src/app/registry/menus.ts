/**
 * The menu registry — the top menu bar and the viewport context menu.
 *
 * A **menu** (`MenuDef`: File, Edit, View, Help …) is a name and an order; the **entries** (`MenuEntryDef`) say
 * which menu they belong to, in which visual group (a separator is drawn where the group changes) and in which
 * order. An entry normally points at a *command* — label, shortcut, enabled and check mark then follow the
 * command — or expands to a list of items (`items`, for the example scenes) or is a heading.
 *
 * `resolveMenu(app, id)` turns the registrations into the `MenuItem[]` that `ui/menu.ts` shows; it is called every
 * time a menu opens, so labels ("Undo Move") and states are always current.
 */
import { Registry } from '../../core/registry';
import type { App } from '../app';
import { commandChecked, commandEnabled, commandLabel, getCommand, primaryShortcut, runCommand } from './commands';
import { formatShortcut } from './shortcuts';

/** One row of a popup menu (the model `ui/menu.ts` renders). */
export type MenuItem =
  | {
      label: string;
      action: () => void | Promise<void>;
      icon?: string;
      kbd?: string;
      checked?: boolean;
      disabled?: boolean;
      keepOpen?: boolean;
      // -- ED-B: a row that opens a nested list (`action` is then unused; give it a no-op) --
      submenu?: MenuItem[];
    }
  | { sep: true }
  | { heading: string };

export interface MenuDef {
  id: string;
  label: string;
  /** Position in the menu bar. */
  order: number;
  /** Shown in the top menu bar (default true); false for popup-only menus such as the viewport context menu. */
  bar?: boolean;
}

export interface MenuEntryDef {
  id: string;
  /** Id of the `MenuDef` the entry belongs to. */
  menu: string;
  /** Entries of one group stay together; a separator is drawn between groups. */
  group: string;
  /** Position within the menu (groups are formed by consecutive entries). */
  order: number;
  /** Command to run (a function chooses one by state, e.g. Simulate / Reset). Label, shortcut, state follow it. */
  command?: string | ((app: App) => string);
  /** Overrides the command's label. */
  label?: string | ((app: App) => string);
  /** Key of `src/ui/icons.ts`. Entries show an icon only when they name one (toggles show their check mark). */
  icon?: string | ((app: App) => string);
  /** Overrides `enabled` of the command. */
  enabled?: (app: App) => boolean;
  /** Hide the entry when this returns false. */
  when?: (app: App) => boolean;
  /** A non-clickable heading. */
  heading?: string;
  /** Expand to several items (the example scenes). */
  items?: (app: App) => MenuItem[];
}

export const menuRegistry = new Registry<MenuDef>({
  kind: 'menu',
  order: (m) => m.order,
  validate(m) {
    if (!m.label.trim()) throw new Error(`menu "${m.id}" needs a label`);
    if (!Number.isFinite(m.order)) throw new Error(`menu "${m.id}" needs a numeric order`);
  },
});

export const menuEntryRegistry = new Registry<MenuEntryDef>({
  kind: 'menu entry',
  order: (e) => e.order,
  validate(e) {
    if (!menuRegistry.has(e.menu)) throw new Error(`menu entry "${e.id}": there is no menu "${e.menu}"`);
    if (!e.group) throw new Error(`menu entry "${e.id}" needs a group`);
    if (!Number.isFinite(e.order)) throw new Error(`menu entry "${e.id}" needs a numeric order`);
    if (!e.command && !e.heading && !e.items)
      throw new Error(`menu entry "${e.id}" needs a command, a heading or items`);
  },
});

export const registerMenu = (def: MenuDef): (() => void) => menuRegistry.register(def);
export const registerMenuEntry = (def: MenuEntryDef): (() => void) => menuEntryRegistry.register(def);
export const unregisterMenu = (id: string): boolean => menuRegistry.unregister(id);
export const unregisterMenuEntry = (id: string): boolean => menuEntryRegistry.unregister(id);

/** The menus of the menu bar, in order. */
export const listBarMenus = (): readonly MenuDef[] => menuRegistry.list().filter((m) => m.bar !== false);

/** Entries of one menu in order. */
export const listMenuEntries = (menu: string): readonly MenuEntryDef[] =>
  menuEntryRegistry.list().filter((e) => e.menu === menu);

const text = (v: string | ((app: App) => string), app: App): string => (typeof v === 'function' ? v(app) : v);

/** The items to show for a menu right now. */
export function resolveMenu(app: App, menu: string): MenuItem[] {
  const out: MenuItem[] = [];
  let group: string | null = null;
  const startGroup = (g: string) => {
    if (group !== null && g !== group) out.push({ sep: true });
    group = g;
  };
  for (const e of listMenuEntries(menu)) {
    if (e.when && !e.when(app)) continue;
    if (e.heading !== undefined) {
      startGroup(e.group);
      out.push({ heading: e.heading });
    } else if (e.items) {
      const items = e.items(app);
      if (!items.length) continue;
      startGroup(e.group);
      out.push(...items);
    } else if (e.command) {
      const id = text(e.command, app);
      const cmd = getCommand(id);
      if (!cmd) continue;
      startGroup(e.group);
      const shortcut = primaryShortcut(cmd);
      const checked = commandChecked(cmd, app);
      out.push({
        label: e.label ? text(e.label, app) : commandLabel(cmd, app),
        icon: typeof e.icon === 'function' ? e.icon(app) : e.icon,
        kbd: shortcut ? formatShortcut(shortcut) : undefined,
        checked,
        disabled: e.enabled ? !e.enabled(app) : !commandEnabled(cmd, app),
        action: () => {
          runCommand(id, app, 'menu');
        },
      });
    }
  }
  return out;
}

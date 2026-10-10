/**
 * The command registry — every user-invokable action of the app is one `CommandDef`.
 *
 * A command has an id (`edit.undo`), a label, a category, optional icon / keywords / shortcut(s), and three
 * behaviours: `enabled(app)`, `checked(app)` (for toggles and radio choices) and `run(ctx)`. Everything that lets
 * the user do something is *generated* from the registry:
 *
 *   keyboard shortcuts   the `Keymap` (./keymap.ts) looks events up in it; `InputController` runs the result
 *   menus                `MenuEntryDef`s (./menus.ts) point at commands: label, shortcut, enabled and checked follow
 *   toolbox / view bar   `ToolDef`s (./tools.ts) register their own command
 *   command palette      Ctrl/Cmd+K searches every enabled command (src/ui/palette)
 *   shortcut help        the dialog lists every command that has a shortcut (./help.ts)
 *
 * Adding an action = one `registerCommand({...})`; it appears everywhere above without further wiring.
 */
import { Registry } from '../../core/registry';
import type { App } from '../app';
import { chordId, formatShortcut, parseShortcut, shortcutList, type Chord } from './shortcuts';

/** Where a command was invoked from — a command may behave a little differently (e.g. only a shortcut toasts). */
export type CommandSource = 'shortcut' | 'menu' | 'palette' | 'button' | 'api';

export interface CommandContext {
  app: App;
  source: CommandSource;
  /** The key event for `source: 'shortcut'`. */
  event?: KeyboardEvent;
}

export interface CommandDef {
  /** Unique, dotted: `edit.undo`, `view.overlay.velocity`. */
  id: string;
  label: string;
  /** Groups the command in the palette and in the shortcut help: Edit, View, Simulation, Tools, File, … */
  category: string;
  /** Key of `src/ui/icons.ts`. */
  icon?: string;
  /** One line of help, shown under the label in the palette and as a tooltip. */
  description?: string;
  /** Extra search terms for the palette ("undo" for "Revert"). */
  keywords?: readonly string[];
  /** "Mod+Z" syntax (see ./shortcuts.ts); an array binds several, the first is the one displayed. */
  shortcut?: string | readonly string[];
  /** Label that depends on state ("Undo Move", "Pause"). Defaults to `label`. */
  labelFor?: (app: App) => string;
  /** Can the command run right now? Default: always. */
  enabled?: (app: App) => boolean;
  /** For toggles and radio choices: is it on? (menus show a check mark, the palette shows On / Off) */
  checked?: (app: App) => boolean;
  /** A preference the palette lists under "Settings" (toggles, radio choices, presets). */
  setting?: boolean;
  /** Offer in the command palette (default true). */
  palette?: boolean;
  /** List in the shortcut help dialog (default true when it has a shortcut). */
  help?: boolean;
  /** Fire the shortcut while a text field has focus (default false; the palette key sets it). */
  allowWhileTyping?: boolean;
  /**
   * What to do with the browser's own action for the key once it matched: `true` (the default) always prevents it —
   * the key belongs to the app, even while the command is disabled (Ctrl+D must never bookmark the page);
   * `'when-enabled'` prevents it only if the command ran; `false` never does (Ctrl+C must reach the browser).
   */
  preventDefault?: boolean | 'when-enabled';
  run: (ctx: CommandContext) => void | Promise<void>;
}

/** Categories in the order the shortcut help and the palette list them; unknown ones follow alphabetically. */
export const COMMAND_CATEGORY_ORDER: readonly string[] = [
  'Simulation',
  'Tools',
  'Edit',
  'Add',
  'Camera',
  'View',
  'World',
  'File',
  'Help',
];

export const commandRegistry = new Registry<CommandDef>({
  kind: 'command',
  validate(def) {
    for (const f of ['label', 'category'] as const)
      if (typeof def[f] !== 'string' || !def[f].trim()) throw new Error(`command "${def.id}": ${f} must not be empty`);
    if (typeof def.run !== 'function') throw new Error(`command "${def.id}" needs a run() function`);
    // Every shortcut must parse and must not collide with one that is already bound.
    const taken = new Map<string, string>();
    for (const other of commandRegistry.list())
      for (const s of shortcutList(other.shortcut)) taken.set(chordId(parseShortcut(s)), other.id);
    for (const s of shortcutList(def.shortcut)) {
      let chord: Chord;
      try {
        chord = parseShortcut(s);
      } catch (e) {
        throw new Error(`command "${def.id}": ${(e as Error).message}`, { cause: e });
      }
      const owner = taken.get(chordId(chord));
      if (owner) throw new Error(`command "${def.id}": shortcut "${s}" is already used by "${owner}"`);
      taken.set(chordId(chord), def.id);
    }
  },
});

export const registerCommand = (def: CommandDef): (() => void) => commandRegistry.register(def);
export const unregisterCommand = (id: string): boolean => commandRegistry.unregister(id);
export const getCommand = (id: string): CommandDef | undefined => commandRegistry.get(id);
export const listCommands = (): readonly CommandDef[] => commandRegistry.list();

/** The label to show right now. */
export function commandLabel(def: CommandDef, app: App): string {
  return def.labelFor ? def.labelFor(app) : def.label;
}

export function commandEnabled(def: CommandDef, app: App): boolean {
  return def.enabled ? def.enabled(app) : true;
}

/** `undefined` for commands that are not toggles. */
export function commandChecked(def: CommandDef, app: App): boolean | undefined {
  return def.checked ? def.checked(app) : undefined;
}

// -- CM-A: shortcuts can be rebound (src/app/input/inputMap.ts installs the resolver) --
let shortcutResolver: ((def: CommandDef) => readonly string[]) | null = null;
export function setShortcutResolver(fn: ((def: CommandDef) => readonly string[]) | null): void {
  shortcutResolver = fn;
}
/** The shortcuts a command has right now (the user's rebinding if any, else the registered default). */
export function shortcutsOf(def: CommandDef): readonly string[] {
  return shortcutResolver ? shortcutResolver(def) : shortcutList(def.shortcut);
}

/** The shortcut to display (the first one), or undefined. */
export function primaryShortcut(def: CommandDef): string | undefined {
  return shortcutsOf(def)[0];
}

/** "Undo (Ctrl+Z)": a tooltip with the command's current shortcut for this platform (just `text` without one). */
export function withShortcut(text: string, commandId: string): string {
  const def = commandRegistry.get(commandId);
  const shortcut = def && primaryShortcut(def);
  return shortcut ? `${text} (${formatShortcut(shortcut)})` : text;
}

/**
 * Run a command by id. Returns false when there is no such command or it is not enabled; a command that throws
 * (or whose promise rejects) is reported to the user as a toast instead of breaking the caller.
 */
export function runCommand(id: string, app: App, source: CommandSource = 'api', event?: KeyboardEvent): boolean {
  const def = commandRegistry.get(id);
  if (!def || !commandEnabled(def, app)) return false;
  const fail = (e: unknown) => {
    console.error(`[command ${id}]`, e);
    app.toast(`“${commandLabel(def, app)}” failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
  };
  try {
    const r = def.run({ app, source, event });
    if (r) r.catch(fail);
  } catch (e) {
    fail(e);
  }
  return true;
}

/**
 * The tool registry — the buttons of the two floating bars over the viewport and the interaction modes behind them.
 *
 *   toolbox   (left)   select / move / rotate / scale, joint, measure, blast, fire …, then the snapping options
 *   viewbar   (right)  overlay toggles, joints, follow, frame
 *
 * A `ToolDef` comes in two forms:
 *
 *   • **own behaviour** (`activate`, optionally `isActive`, `mode`, `pointerDown`, `hint`): registering it also
 *     registers the command `tool.<id>` (or `commandId`) with the shortcut, so the key, the menu, the palette and
 *     the button all run the same thing. A tool that is an *interaction mode* (`mode` = the value of
 *     `prefs.tool` it selects) handles the pointer through `pointerDown`; gizmo modes (move / rotate / scale) share
 *     the `select` mode and have no handler of their own.
 *   • **a button for an existing command** (`command`): the bar shows the command's enabled / checked state and
 *     shortcut and runs it on click (the overlay toggles are View-menu commands with a button).
 *
 * The bars are built from `listTools(region)`: sorted by `order`, with a separator wherever `group` changes.
 */
import { Registry } from '../../core/registry';
import type { App } from '../app';
import type { InputController } from '../input';
import { registerCommand, unregisterCommand, type CommandContext } from './commands';

export type ToolRegion = 'toolbox' | 'viewbar';

export interface ToolDef {
  /** Unique id; also the `data-tool` attribute of the button. */
  id: string;
  /** Which bar (default `toolbox`). */
  region?: ToolRegion;
  /** Buttons of one group sit together; a separator is drawn where the group changes. */
  group: string;
  order: number;
  /** Key of `src/ui/icons.ts`. */
  icon: string;
  /** Tooltip sentence; the shortcut is appended as "(Q)" unless `showShortcut` is false. */
  title?: string;
  /** Show this text on the button instead of the icon (option buttons: grid size, gizmo space). */
  text?: (app: App) => string;
  showShortcut?: boolean;

  /** Existing command this button runs and mirrors. */
  command?: string;

  // ── own behaviour (when `command` is not given) ──
  label?: string;
  shortcut?: string | readonly string[];
  activate?: (app: App, ctx: CommandContext) => void;
  isActive?: (app: App) => boolean;
  enabled?: (app: App) => boolean;
  /** The `prefs.tool` value this tool selects. Default: `id`. Pointer handling is looked up by mode. */
  mode?: string;
  /** Primary-button press in the viewport while this tool's mode is active. */
  pointerDown?: (app: App, e: PointerEvent, input: InputController) => void;
  /** The hint line under the viewport while the mode is active (HTML; null = none). */
  hint?: (app: App) => string | null;
  /** Command id (default `tool.<id>`) and palette category (default Tools). */
  commandId?: string;
  category?: string;
  keywords?: readonly string[];
  /** List the command under "Settings" in the palette (toggles such as snapping). */
  setting?: boolean;
}

function validateTool(t: ToolDef): void {
  if (!t.group) throw new Error(`tool "${t.id}" needs a group`);
  if (!t.icon) throw new Error(`tool "${t.id}" needs an icon`);
  if (!Number.isFinite(t.order)) throw new Error(`tool "${t.id}" needs a numeric order`);
  if (t.command) {
    if (t.activate || t.shortcut || t.pointerDown)
      throw new Error(`tool "${t.id}" runs the command "${t.command}" — it cannot also define its own behaviour`);
  } else {
    if (!t.label) throw new Error(`tool "${t.id}" needs a label`);
    if (typeof t.activate !== 'function') throw new Error(`tool "${t.id}" needs an activate() function`);
  }
}

export const toolRegistry = new Registry<ToolDef>({ kind: 'tool', order: (t) => t.order, validate: validateTool });

export function commandIdOf(t: ToolDef): string {
  return t.command ?? t.commandId ?? `tool.${t.id}`;
}

/** Register a tool (and, for own-behaviour tools, its command). Returns the function that removes both. */
export function registerTool(def: ToolDef): () => void {
  validateTool(def);
  if (toolRegistry.has(def.id)) throw new Error(`The tool "${def.id}" is already registered`);
  // The command goes first: the bars render as soon as the tool is registered and look the command up for the
  // shortcut in the tooltip. If anything fails nothing stays registered.
  let offCommand: (() => void) | null = null;
  if (!def.command) {
    const activate = def.activate as NonNullable<ToolDef['activate']>;
    offCommand = registerCommand({
      id: commandIdOf(def),
      label: def.label as string,
      category: def.category ?? (def.region === 'viewbar' ? 'View' : 'Tools'),
      icon: def.icon,
      description: def.title,
      keywords: def.keywords,
      shortcut: def.shortcut,
      enabled: def.enabled,
      checked: def.isActive,
      setting: def.setting,
      run: (ctx) => activate(ctx.app, ctx),
    });
  }
  let offTool: () => void;
  try {
    offTool = toolRegistry.register(def);
  } catch (e) {
    offCommand?.();
    throw e;
  }
  return () => {
    offTool();
    offCommand?.();
  };
}

export const unregisterTool = (id: string): boolean => {
  const t = toolRegistry.get(id);
  if (!t) return false;
  if (!t.command) unregisterCommand(commandIdOf(t));
  return toolRegistry.unregister(id);
};

export const getTool = (id: string): ToolDef | undefined => toolRegistry.get(id);

/** Tools of one bar in display order. */
export function listTools(region: ToolRegion = 'toolbox'): readonly ToolDef[] {
  return toolRegistry.list().filter((t) => (t.region ?? 'toolbox') === region);
}

/** The tool that handles the pointer for an interaction mode (`prefs.tool`). */
export function toolForMode(mode: string): ToolDef | undefined {
  return toolRegistry.list().find((t) => !t.command && (t.mode ?? t.id) === mode && t.pointerDown);
}

/** Every interaction mode some tool selects (for the viewport's `tool-<mode>` cursor classes). */
export function toolModes(): string[] {
  return [
    ...new Set(
      toolRegistry
        .list()
        .filter((t) => !t.command)
        .map((t) => t.mode ?? t.id),
    ),
  ];
}

/** The hint of the first tool of a mode that has one. */
export function hintForMode(mode: string, app: App): string | null {
  for (const t of toolRegistry.list()) if (!t.command && (t.mode ?? t.id) === mode && t.hint) return t.hint(app);
  return null;
}

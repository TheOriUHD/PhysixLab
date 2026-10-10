/**
 * Tool options (ED-40): a registry of the controls a tool shows in the options bar over the viewport while it is the
 * active mode (`prefs.tool`). Every control edits one key of `Prefs`, so the values persist like any other
 * preference. `src/ui/toolOptionsBar.ts` renders the bar from these registrations.
 */
import { Registry } from '../core/registry';
import type { App } from './app';
import type { Prefs } from './prefs';

type Key = keyof Prefs;

interface Common {
  /** Prefs key this control edits. */
  key: Key;
  label: string;
  title?: string;
  /** Hide the control while this is false (e.g. the "radius" of a gust). */
  when?: (p: Prefs, app: App) => boolean;
}

export type ToolOption =
  | (Common & { kind: 'select'; options: readonly { value: string; label: string }[] })
  | (Common & { kind: 'range'; min: number; max: number; step: number; unit?: string; digits?: number })
  | (Common & { kind: 'color' })
  | (Common & { kind: 'swatches'; colors: readonly string[] | ((p: Prefs) => readonly string[]) });

export interface ToolOptionsDef {
  /** The interaction mode (`ToolDef.mode`) the options belong to. */
  mode: string;
  options: readonly ToolOption[];
}

export const toolOptionsRegistry = new Registry<ToolOptionsDef & { id: string }>({
  kind: 'tool options',
  order: () => 0,
  validate(d) {
    if (!d.options.length) throw new Error(`tool options for "${d.mode}" are empty`);
  },
});

/** Register the option controls of an interaction mode. Returns the function that removes them. */
export function registerToolOptions(def: ToolOptionsDef): () => void {
  return toolOptionsRegistry.register({ ...def, id: def.mode });
}

export const optionsForMode = (mode: string): readonly ToolOption[] => toolOptionsRegistry.get(mode)?.options ?? [];

/**
 * The shortcut help — generated from the registries, so it can never disagree with what the keys really do.
 *
 * Every command that has a shortcut contributes a row (grouped by its category). What is not a command — pointer
 * gestures such as "drag to throw a body" or "right-drag to orbit" — is registered as a `HelpEntry`.
 */
import { Registry } from '../../core/registry';
import { COMMAND_CATEGORY_ORDER, listCommands, shortcutsOf } from './commands';
import { detectPlatform, shortcutTokens, type Platform } from './shortcuts';

export interface HelpEntry {
  id: string;
  /** Section title; use a command category to join its section ("Simulation", "Camera" …). */
  group: string;
  label: string;
  /** Keycaps separated by spaces, alternatives by " · ": "Right drag · Alt drag". */
  keys: string;
  /** Position among the entries of the same group. */
  order: number;
}

export const helpRegistry = new Registry<HelpEntry>({
  kind: 'help entry',
  order: (h) => h.order,
  validate(h) {
    if (!h.group || !h.label || !h.keys) throw new Error(`help entry "${h.id}" needs a group, a label and keys`);
  },
});

export const registerHelp = (entry: HelpEntry): (() => void) => helpRegistry.register(entry);

export interface HelpRow {
  label: string;
  /** Alternative ways to do it; each alternative is a list of keycaps. */
  alternatives: string[][];
}

export interface HelpSection {
  title: string;
  rows: HelpRow[];
}

/** The sections of the shortcut help, in display order. */
export function helpSections(platform: Platform = detectPlatform()): HelpSection[] {
  const groups = new Map<string, HelpRow[]>();
  const rows = (g: string) => {
    let r = groups.get(g);
    if (!r) groups.set(g, (r = []));
    return r;
  };
  for (const c of listCommands()) {
    const shortcuts = shortcutsOf(c);
    if (!shortcuts.length || c.help === false) continue;
    rows(c.category).push({ label: c.label, alternatives: shortcuts.map((s) => shortcutTokens(s, platform)) });
  }
  for (const e of helpRegistry.list())
    rows(e.group).push({ label: e.label, alternatives: e.keys.split(' · ').map((a) => a.split(' ')) });
  const rank = (t: string) => {
    const i = COMMAND_CATEGORY_ORDER.indexOf(t);
    return i < 0 ? COMMAND_CATEGORY_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([title, r]) => ({ title, rows: r }));
}

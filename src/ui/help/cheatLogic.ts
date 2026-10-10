/** The data behind the shortcut cheat-sheet (DOM-free): rows from the command registry + gesture entries, and filtering. */
import { COMMAND_CATEGORY_ORDER, listCommands, type CommandDef } from '../../app/registry/commands';
import { helpRegistry, type HelpEntry } from '../../app/registry/help';
import { detectPlatform, shortcutList, shortcutTokens, type Platform } from '../../app/registry/shortcuts';

export interface CheatRow {
  label: string;
  /** One line of help (the command's description), shown small under the label. */
  hint: string;
  /** Extra words that are searched (description, keywords). */
  description: string;
  /** Alternatives, each a list of key caps; empty for commands without a shortcut. */
  alternatives: string[][];
  /** The command to run on Enter / click (absent for pointer gestures). */
  commandId?: string;
  /** Search text (lower case). */
  haystack: string;
}

export interface CheatSection {
  title: string;
  rows: CheatRow[];
}

export interface CheatOptions {
  platform?: Platform;
  /** Also list commands that have no shortcut. */
  includeUnbound?: boolean;
  commands?: readonly CommandDef[];
  entries?: readonly HelpEntry[];
}

/** A description that only repeats the label adds nothing under it. */
const redundant = (label: string, hint?: string): boolean => {
  if (!hint) return true;
  const a = label.toLowerCase();
  const b = hint.toLowerCase();
  return b === a || b.startsWith(`${a} (`) || b.startsWith(`${a} —`);
};

/** Build the sections of the cheat-sheet: by category, in the registry's category order. */
export function cheatSections(o: CheatOptions = {}): CheatSection[] {
  const platform = o.platform ?? detectPlatform();
  const commands = o.commands ?? listCommands();
  const entries = o.entries ?? helpRegistry.list();
  const groups = new Map<string, CheatRow[]>();
  const add = (g: string, r: Omit<CheatRow, 'haystack'>) => {
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    const keysText = r.alternatives.map((a) => a.join(' ')).join(' ');
    list.push({ ...r, haystack: `${r.label} ${g} ${r.description} ${keysText}`.toLowerCase() });
  };
  for (const c of commands) {
    const shortcuts = shortcutList(c.shortcut);
    if (c.help === false) continue;
    if (!shortcuts.length && !o.includeUnbound) continue;
    add(c.category, {
      label: c.label,
      hint: redundant(c.label, c.description) ? '' : (c.description ?? ''),
      description: [c.description ?? '', ...(c.keywords ?? [])].join(' ').trim(),
      alternatives: shortcuts.map((s) => shortcutTokens(s, platform)),
      commandId: c.id,
    });
  }
  for (const e of entries)
    add(e.group, {
      label: e.label,
      hint: '',
      description: '',
      alternatives: e.keys.split(' · ').map((a) => a.split(' ')),
    });
  const rank = (t: string) => {
    const i = COMMAND_CATEGORY_ORDER.indexOf(t);
    return i < 0 ? COMMAND_CATEGORY_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([title, rows]) => ({ title, rows }));
}

/** Keep the rows that contain every word of the query (label, category, description, keys); drop empty sections. */
export function filterCheat(sections: readonly CheatSection[], query: string): CheatSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return sections.map((s) => ({ ...s }));
  // Rows whose label contains every word come first inside a section (a keyword match only is a weaker hit).
  const inLabel = (r: CheatRow) => words.every((w) => r.label.toLowerCase().includes(w));
  return sections
    .map((s) => {
      const rows = s.rows.filter((r) => words.every((w) => r.haystack.includes(w)));
      return { title: s.title, rows: [...rows.filter(inLabel), ...rows.filter((r) => !inLabel(r))] };
    })
    .filter((s) => s.rows.length);
}

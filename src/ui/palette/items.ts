/**
 * What the command palette can run, collected from the registries every time it opens: commands (and the
 * settings among them), example scenes, saved scenes, prefabs and maps. Nothing here is palette-specific
 * behaviour — every item runs the same function the corresponding menu entry, tab or shortcut runs.
 */
import type { App } from '../../app/app';
import {
  commandChecked,
  commandEnabled,
  commandLabel,
  listCommands,
  primaryShortcut,
  runCommand,
} from '../../app/registry/commands';
import { formatShortcut } from '../../app/registry/shortcuts';
import { listMaps, listPrefabs, listTemplates } from '../../model/content';
import { confirmReplace } from '../sceneActions';
import type { Searchable } from './search';

export type PaletteKind = 'command' | 'setting' | 'example' | 'saved' | 'prefab' | 'map';

export interface PaletteItem extends Searchable {
  kind: PaletteKind;
  /** Small label at the right edge: "Command", "Setting", "Example" … */
  tag: string;
  /** Key of `src/ui/icons.ts`. */
  icon?: string;
  /** Formatted shortcut ("Ctrl+Z"). */
  shortcut?: string;
  /** For settings: "On" / "Off". */
  state?: string;
  run: () => void;
}

const TAGS: Record<PaletteKind, string> = {
  command: 'Command',
  setting: 'Setting',
  example: 'Example',
  saved: 'Saved scene',
  prefab: 'Prefab',
  map: 'Map',
};

/** All items that can be run right now. */
export function buildPaletteItems(app: App): PaletteItem[] {
  const out: PaletteItem[] = [];

  for (const c of listCommands()) {
    if (c.palette === false || !commandEnabled(c, app)) continue;
    const kind: PaletteKind = c.setting ? 'setting' : 'command';
    const checked = commandChecked(c, app);
    const shortcut = primaryShortcut(c);
    const label = commandLabel(c, app);
    out.push({
      id: `cmd:${c.id}`,
      kind,
      label,
      // A tool's tooltip often just repeats its name ("Select" / "Select"); a second line must say something new.
      detail: c.description && c.description.toLowerCase() !== label.toLowerCase() ? c.description : undefined,
      group: c.setting ? 'Settings' : c.category,
      tag: TAGS[kind],
      icon: c.icon,
      shortcut: shortcut ? formatShortcut(shortcut) : undefined,
      state: c.setting && checked !== undefined ? (checked ? 'On' : 'Off') : undefined,
      keywords: [c.category, ...(c.keywords ?? [])],
      run: () => {
        runCommand(c.id, app, 'palette');
      },
    });
  }

  for (const t of listTemplates())
    out.push({
      id: `example:${t.id}`,
      kind: 'example',
      label: t.name,
      detail: t.blurb,
      group: 'Examples',
      tag: TAGS.example,
      icon: 'layers',
      keywords: [t.category, 'open', 'load', 'scene', 'example'],
      run: () => void confirmReplace(app, () => app.loadTemplate(t.id)),
    });

  for (const e of app.persistence.library())
    out.push({
      id: `saved:${e.id}`,
      kind: 'saved',
      label: e.name,
      detail: `${e.bodies} bodies · ${new Date(e.savedAt).toLocaleString()}`,
      group: 'Saved scenes',
      tag: TAGS.saved,
      icon: 'folder',
      keywords: ['open', 'load', 'scene', 'library', 'saved'],
      run: () => {
        const doc = app.persistence.openFromLibrary(e.id);
        if (doc) void confirmReplace(app, () => app.loadDocument(doc, 'frame', { kind: 'library', id: e.id }));
      },
    });

  for (const p of listPrefabs())
    out.push({
      id: `prefab:${p.id}`,
      kind: 'prefab',
      label: p.name,
      detail: p.blurb,
      group: 'Prefabs',
      tag: TAGS.prefab,
      icon: p.icon,
      keywords: ['insert', 'add', 'assembly', ...(p.category ? [p.category] : [])],
      run: () => app.insertPrefab(p.id),
    });

  for (const m of listMaps())
    out.push({
      id: `map:${m.id}`,
      kind: 'map',
      label: m.name,
      detail: m.description,
      group: 'Maps',
      tag: TAGS.map,
      icon: m.icon ?? 'layers',
      keywords: [m.category, ...m.tags, 'open', 'load', 'level', 'map'],
      run: () => void confirmReplace(app, () => app.loadMap(m.id)),
    });

  return out;
}

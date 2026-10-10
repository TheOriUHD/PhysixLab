import type { SceneDocument } from '../../model/types';

export interface DocDiff {
  added: string[];
  removed: string[];
  changed: string[];
  settingsChanged: boolean;
  /** One line for the UI, e.g. "+3 added, −1 removed, 5 changed". */
  summary: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What differs between two documents, by entity id (names are used for display). `from` is the older one. */
export function diffDocuments(from: SceneDocument, to: SceneDocument): DocDiff {
  const a = new Map(from.entities.map((e) => [e.id, e]));
  const b = new Map(to.entities.map((e) => [e.id, e]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, e] of b) {
    const old = a.get(id);
    if (!old) added.push(e.name);
    else if (!same(old, e)) changed.push(e.name);
  }
  for (const [id, e] of a) if (!b.has(id)) removed.push(e.name);
  const settingsChanged = !same(from.settings, to.settings) || from.name !== to.name;
  const parts: string[] = [];
  if (added.length) parts.push(`+${added.length} added`);
  if (removed.length) parts.push(`−${removed.length} removed`);
  if (changed.length) parts.push(`${changed.length} changed`);
  if (settingsChanged) parts.push('settings changed');
  return { added, removed, changed, settingsChanged, summary: parts.length ? parts.join(', ') : 'identical' };
}

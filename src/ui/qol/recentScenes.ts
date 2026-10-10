/**
 * Wiring of recent scenes and scene thumbnails (UI-42): records every scene the user opens, keeps a small thumbnail
 * of the current scene fresh (after a load, and a few seconds after edits — the autosave cadence), and reopens an
 * entry of the list.
 */
import type { App, SceneSource } from '../../app/app';
import { parseDocument, serializeDocument } from '../../model/serialize';
import { getMap, getTemplate } from '../../model/content';
import { confirmReplace } from '../sceneActions';
import type { RecentEntry } from './recents';
import { recentScenes, thumbStore } from './stores';

/** Key of a scene in the thumbnail cache, shared by the recents list, the library cards and the template cards. */
export const thumbKey = (kind: 'template' | 'map' | 'library' | 'file' | 'paste', id: string): string =>
  `${kind}:${id}`;

export function installRecentScenes(app: App): void {
  let current: string | null = null; // thumbnail key of the scene being edited
  let timer = 0;
  let lastShot = 0;

  const shoot = () => {
    if (!current) return;
    try {
      const url = app.viewport.thumbnail();
      if (url) thumbStore().set(current, url);
      lastShot = performance.now();
    } catch {
      /* a thumbnail is a nicety: never let it break the app */
    }
  };
  const later = (ms: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(shoot, ms);
  };

  app.on('sceneLoaded', ({ source, name, bodies }) => {
    if (!source) {
      current = null;
      return;
    }
    const json =
      source.kind === 'file' || source.kind === 'paste' ? serializeDocument(app.store.toDocument()) : undefined;
    recentScenes().record(source, name, bodies, json);
    current = thumbKey(source.kind, 'id' in source ? source.id : name);
    // The camera is still flying to the scene's view: wait for it before taking the picture.
    later(1100);
  });

  // Keep the thumbnail of the open scene in step with edits, at most every 6 s.
  app.store.on('change', () => {
    if (!current) return;
    const wait = Math.max(2500, 6000 - (performance.now() - lastShot));
    later(wait);
  });

  app.persistence.onLibrarySaved = (entry) => {
    // A scene saved to the library is a recent scene too, with the picture taken right now.
    const source: SceneSource = { kind: 'library', id: entry.id };
    recentScenes().record(source, entry.name, entry.bodies);
    current = thumbKey('library', entry.id);
    shoot();
  };
}

/** Open an entry of the recent list. */
export async function openRecent(app: App, entry: RecentEntry): Promise<void> {
  const s = entry.source;
  const gone = (what: string) => {
    app.toast(`“${entry.name}” is no longer available (${what}).`, 'warn');
    recentScenes().remove(entry.key);
  };
  if (s.kind === 'template') {
    if (!getTemplate(s.id)) return gone('that example no longer exists');
    return confirmReplace(app, () => app.loadTemplate(s.id));
  }
  if (s.kind === 'map') {
    if (!getMap(s.id)) return gone('that map no longer exists');
    return confirmReplace(app, () => app.loadMap(s.id));
  }
  if (s.kind === 'library') {
    const doc = app.persistence.openFromLibrary(s.id);
    if (!doc) return gone('it was deleted from the library');
    return confirmReplace(app, () => app.loadDocument(doc, 'frame', { kind: 'library', id: s.id }));
  }
  const json = recentScenes().dataOf(entry.key);
  if (!json) {
    app.toast(`“${entry.name}” came from a file and is too large to keep; import the file again to reopen it.`, 'warn');
    return;
  }
  try {
    const doc = parseDocument(json);
    return confirmReplace(app, () => app.loadDocument(doc, 'frame', { kind: s.kind }));
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}

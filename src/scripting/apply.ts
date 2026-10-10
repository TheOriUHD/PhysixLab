/**
 * DT-32: put a built scene into the editor as ONE undoable step.
 *   replace — everything in the scene is removed and the script's objects take its place (settings and name too)
 *   add     — the script's objects are added next to what is there
 */
import type { SceneStore } from '../model/store';
import type { SceneDocument } from '../model/types';

export type ApplyMode = 'replace' | 'add';

export function applyScriptScene(store: SceneStore, doc: SceneDocument, mode: ApplyMode): number {
  store.begin(mode === 'replace' ? 'Scene script (replace)' : 'Scene script (add)');
  try {
    if (mode === 'replace') {
      const ids = store.all().map((e) => e.id);
      if (ids.length) store.remove(ids, 'Scene script');
      store.updateSettings(structuredClone(doc.settings), 'Scene script');
      store.setName(doc.name);
    }
    store.add(structuredClone(doc.entities), 'Scene script', false);
  } finally {
    store.end();
  }
  return doc.entities.length;
}

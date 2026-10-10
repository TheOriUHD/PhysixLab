// ── ED-A prefabs (ED-22): the "My prefabs" tab, the save / insert / update / import / export commands and their menu entries ──
import { insertUserPrefab, prefabLibrary, updatePrefabFromSelection } from '../../app/edit/prefabActions';
import { registerCommand, registerMenuEntry, registerPanel } from '../../app/registry';
import type { App } from '../../app/app';
import { openMenu, type MenuItem } from '../menu';
import { confirmDialog } from '../modal';
import { exportDialog, importPackDialog, saveSelectionDialog } from '../edit/prefabDialogs';
import { buildMyPrefabsPanel } from '../edit/prefabPanel';

registerPanel({
  id: 'myprefabs',
  label: 'My prefabs',
  icon: 'component',
  region: 'left',
  order: 25, // right after the built-in Prefabs tab (20)
  title: 'Your own prefabs: save a selection, insert it again, share packs',
  build: buildMyPrefabsPanel,
});

/** Where a list menu opens: the middle of the viewport. */
function viewCentre(app: App): { x: number; y: number } {
  const r = app.viewport.dom.getBoundingClientRect();
  return { x: r.left + r.width / 2 - 100, y: r.top + r.height / 3 };
}

/** Pop up a menu of the user's prefabs; `pick` receives the chosen one. Toasts a hint when there are none. */
function choosePrefab(app: App, heading: string, pick: (id: string) => void | Promise<void>): void {
  const list = prefabLibrary(app).list();
  if (!list.length) {
    app.toast('You have no prefabs yet. Select objects and use “Save selection as prefab…” first.', 'info');
    return;
  }
  const items: MenuItem[] = [
    { heading },
    ...list.slice(0, 40).map((p): MenuItem => ({ label: p.name, icon: 'layers', action: () => pick(p.id) })),
  ];
  openMenu(items, viewCentre(app));
}

const hasSelection = (app: App) => app.store.selection.length > 0;

registerCommand({
  id: 'prefab.saveSelection',
  label: 'Save selection as prefab…',
  category: 'Prefabs',
  icon: 'save',
  description: 'Keep the selected objects (with a thumbnail, tags and variables) as a reusable prefab in “My prefabs”',
  keywords: ['prefab', 'template', 'blueprint', 'reuse', 'library', 'create prefab'],
  enabled: hasSelection,
  run: ({ app }) => void saveSelectionDialog(app),
});

registerCommand({
  id: 'prefab.insert',
  label: 'Insert prefab…',
  category: 'Prefabs',
  icon: 'plus',
  description: 'Choose one of your prefabs and insert it on the surface under the view',
  keywords: ['prefab', 'place', 'my prefabs', 'user prefab'],
  enabled: (app) => !app.sim.active,
  run: ({ app }) => choosePrefab(app, 'Insert prefab', (id) => void insertUserPrefab(app, id)),
});

registerCommand({
  id: 'prefab.updateFromSelection',
  label: 'Update prefab from selection…',
  category: 'Prefabs',
  icon: 'save',
  description: 'Replace the objects of a prefab with the current selection (name, tags, variants and nesting are kept)',
  keywords: ['prefab', 'replace', 'overwrite', 'refresh'],
  enabled: hasSelection,
  run: ({ app }) =>
    choosePrefab(app, 'Update prefab from selection', async (id) => {
      const p = prefabLibrary(app).get(id);
      if (
        p &&
        (await confirmDialog(
          'Update prefab',
          `Replace the objects of “${p.name}” with the current selection?`,
          'Update',
        ))
      ) {
        await updatePrefabFromSelection(app, id);
      }
    }),
});

registerCommand({
  id: 'prefab.import',
  label: 'Import prefab pack…',
  category: 'Prefabs',
  icon: 'upload',
  description: 'Add the prefabs of a pack file to “My prefabs”',
  keywords: ['prefab', 'pack', 'load', 'open'],
  run: ({ app }) => importPackDialog(app),
});

registerCommand({
  id: 'prefab.export',
  label: 'Export prefab pack…',
  category: 'Prefabs',
  icon: 'download',
  description: 'Download some or all of “My prefabs” as one pack file',
  keywords: ['prefab', 'pack', 'save', 'share'],
  run: ({ app }) => exportDialog(app),
});

// Edit menu (own group after the "select" group) and File menu (with the other import / export entries).
registerMenuEntry({
  id: 'menu.edit.prefabSave',
  menu: 'edit',
  group: 'prefab',
  order: 350,
  command: 'prefab.saveSelection',
});
registerMenuEntry({
  id: 'menu.edit.prefabInsert',
  menu: 'edit',
  group: 'prefab',
  order: 351,
  command: 'prefab.insert',
});
registerMenuEntry({
  id: 'menu.edit.prefabUpdate',
  menu: 'edit',
  group: 'prefab',
  order: 352,
  command: 'prefab.updateFromSelection',
});
registerMenuEntry({
  id: 'menu.file.prefabImport',
  menu: 'file',
  group: 'io',
  order: 330,
  command: 'prefab.import',
  icon: 'upload',
});
registerMenuEntry({
  id: 'menu.file.prefabExport',
  menu: 'file',
  group: 'io',
  order: 331,
  command: 'prefab.export',
  icon: 'download',
});

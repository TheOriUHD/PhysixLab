/**
 * ED-22 — the "My prefabs" tab of the left (library) region: a searchable, tag-filterable grid of the user's
 * prefabs. A tile is dragged into the viewport (a ghost of every object shows where it lands) or clicked to arm
 * placement; double-click inserts at the surface under the view centre.
 */
import type { App } from '../../app/app';
import { insertUserPrefab, prefabLibrary, updatePrefabFromSelection } from '../../app/edit/prefabActions';
import { userPrefabPlaceable } from '../../app/placeables'; // -- ghost placement
import type { PanelContext, PanelView } from '../../app/registry/panels';
import type { StoredPrefab } from '../../model/edit/userPrefab';
import { clear, h } from '../dom';
import { emptyState } from '../emptyState'; // -- UI-B: empty states --
import { icon } from '../icons';
import { openMenu, type MenuItem } from '../menu';
import { confirmDialog } from '../modal';
import { bindPlaceable } from '../placementTiles'; // -- ghost placement
import {
  editPrefabDialog,
  exportDialog,
  importPackDialog,
  insertWithValuesDialog,
  saveSelectionDialog,
} from './prefabDialogs';

/** Distinct from the built-in prefab cards' type (ED-15 drop controller), which only knows registered prefab ids. */
export const PREFAB_MIME = 'text/x-physixlab-user-prefab';

/** The items of a prefab's ⋯ menu. */
export function prefabMenu(app: App, p: StoredPrefab): MenuItem[] {
  const lib = prefabLibrary(app);
  const items: MenuItem[] = [
    { label: 'Insert', icon: 'plus', action: () => void insertUserPrefab(app, p.id) },
    { label: 'Insert with values…', icon: 'settings', action: () => insertWithValuesDialog(app, p.id) },
  ];
  if (p.variants.length) {
    items.push({ heading: 'Insert variant' });
    for (const v of p.variants) {
      items.push({
        label: v.name,
        icon: 'layers',
        action: () => void insertUserPrefab(app, p.id, { variantId: v.id }),
      });
    }
  }
  items.push(
    { sep: true },
    {
      label: 'Update from selection',
      icon: 'save',
      disabled: app.store.selection.length === 0,
      action: async () => {
        if (
          await confirmDialog(
            'Update prefab',
            `Replace the objects of “${p.name}” with the current selection? Name, tags, variants and nesting are kept.`,
            'Update',
          )
        ) {
          await updatePrefabFromSelection(app, p.id);
        }
      },
    },
    { label: 'Rename, tags, variables & variants…', icon: 'settings', action: () => editPrefabDialog(app, p.id) },
    {
      label: 'Duplicate',
      icon: 'copy',
      action: async () => {
        try {
          const c = await lib.duplicate(p.id);
          app.toast(`Created “${c.name}”`, 'success');
        } catch (e) {
          app.toast(e instanceof Error ? e.message : String(e), 'error');
        }
      },
    },
    { label: 'Export this prefab…', icon: 'download', action: () => exportDialog(app, [p.id]) },
    { sep: true },
    {
      label: 'Delete',
      icon: 'trash',
      action: async () => {
        const deps = lib.dependents(p.id);
        const extra = deps.length
          ? ` ${deps.map((d) => `“${d.name}”`).join(', ')} nest${deps.length === 1 ? 's' : ''} it and will lose that part.`
          : '';
        if (
          !(await confirmDialog(
            'Delete prefab',
            `Delete “${p.name}” from your library? Objects already in the scene stay.${extra}`,
            'Delete',
            true,
          ))
        )
          return;
        try {
          await lib.remove(p.id);
          app.toast(`Deleted “${p.name}”`);
        } catch (e) {
          app.toast(e instanceof Error ? e.message : String(e), 'error');
        }
      },
    },
  );
  return items;
}

function tile(app: App, p: StoredPrefab): HTMLElement {
  const thumb = h('span', { class: 'ed-pf-thumb' });
  if (p.thumbnail) thumb.appendChild(h('img', { src: p.thumbnail, alt: '', draggable: false, loading: 'lazy' }));
  else thumb.appendChild(icon('layers'));
  const badges: string[] = [];
  if (p.variables.length) badges.push(`${p.variables.length} var`);
  if (p.variants.length) badges.push(`${p.variants.length} variant${p.variants.length === 1 ? '' : 's'}`);
  if (p.nested.length) badges.push(`${p.nested.length} nested`);
  const main = h(
    'button',
    {
      class: 'ed-pf-main',
      type: 'button',
      title: `${p.name} — ${p.entities.length} objects\nDrag into the scene, or click and then click where it should go.\nDouble-click: insert at the centre of the view`,
    },
    thumb,
    h('span', { class: 'ed-pf-name' }, p.name),
    h(
      'span',
      { class: 'ed-pf-tags' },
      ...p.tags.slice(0, 3).map((t) => h('span', { class: 'chip-tag' }, t)),
      ...badges.map((b) => h('span', { class: 'chip-tag ed-pf-badge' }, b)),
    ),
  );
  // -- ghost placement: drag shows a ghost of every object; a click arms it (src/app/placementGhost.ts) --
  bindPlaceable(app, main, `userprefab:${p.id}`, () => userPrefabPlaceable(app, p.id));
  const more = h(
    'button',
    { class: 'icon-btn ed-pf-more', type: 'button', title: 'Prefab actions', 'aria-label': `Actions for ${p.name}` },
    '⋯',
  );
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(prefabMenu(app, p), more);
  });
  const el = h('div', { class: 'ed-pf-tile', dataset: { prefab: p.id, name: p.name } }, main, more);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(prefabMenu(app, p), { x: e.clientX, y: e.clientY });
  });
  return el;
}

/** Drag a tile into the viewport to drop it on the surface under the pointer. */
function installDrop(app: App): void {
  const host = app.viewport.dom.parentElement;
  if (!host) return;
  const mine = (e: DragEvent) => !!e.dataTransfer?.types.includes(PREFAB_MIME);
  host.addEventListener('dragover', (e) => {
    if (!mine(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  host.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData(PREFAB_MIME);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    insertUserPrefab(app, id, { pointer: e });
  });
}

export function buildMyPrefabsPanel(app: App, ctx: PanelContext): PanelView {
  const lib = prefabLibrary(app);
  installDrop(app);
  const el = h('div', { class: 'panel-body ed-pf-panel' });
  let query = '';
  const active = new Set<string>();

  const input = h('input', {
    type: 'text',
    placeholder: 'Search my prefabs…',
    spellcheck: false,
    'aria-label': 'Search my prefabs',
  });
  input.addEventListener('input', () => {
    query = input.value;
    renderList();
  });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  const tagRow = h('div', { class: 'ed-pf-tagrow' });
  const list = h('div', { class: 'ed-pf-list' });

  const actions = h('div', { class: 'ed-pf-actions' });
  const mk = (label: string, ic: string, title: string, fn: () => void) => {
    const b = h('button', { class: 'btn small', type: 'button', title }, icon(ic), h('span', null, label));
    b.addEventListener('click', fn);
    return b;
  };
  actions.append(
    mk('Save selection…', 'save', 'Save the selected objects as a reusable prefab', () => {
      if (!app.store.selection.length) app.toast('Select the objects to save as a prefab first.', 'warn');
      else void saveSelectionDialog(app);
    }),
    mk('Import…', 'upload', 'Import a prefab pack file', () => importPackDialog(app)),
    mk('Export…', 'download', 'Export prefabs as a pack file', () => exportDialog(app)),
  );

  const renderList = () => {
    clear(tagRow);
    clear(list);
    for (const t of [...active]) if (!lib.tags().some(([x]) => x === t)) active.delete(t);
    for (const [t, n] of lib.tags()) {
      const chip = h(
        'button',
        { class: `ed-pf-chip ${active.has(t) ? 'on' : ''}`, type: 'button', title: `${n} prefab${n === 1 ? '' : 's'}` },
        t,
      );
      chip.addEventListener('click', () => {
        if (!active.delete(t)) active.add(t);
        renderList();
      });
      tagRow.appendChild(chip);
    }
    const found = lib.search(query, [...active]);
    if (!found.length) {
      const empty = !lib.size;
      list.appendChild(
        h(
          'div',
          { class: 'ed-pf-empty' },
          emptyState({
            art: !lib.loaded ? 'recent' : empty ? 'folder' : 'search',
            title: !lib.loaded ? 'Loading…' : empty ? 'No prefabs yet' : 'No prefab matches',
            hint: !lib.loaded
              ? 'Reading your library.'
              : empty
                ? 'Select objects in the scene, then choose “Save selection…” (or Edit → Save selection as prefab…) to keep them as a reusable prefab. Prefabs are stored in this browser; export a pack to share them.'
                : 'Try another word or clear the tag filter.',
          }),
        ),
      );
      return;
    }
    const grid = h('div', { class: 'ed-pf-grid' });
    for (const p of found) grid.appendChild(tile(app, p));
    list.appendChild(grid);
  };

  el.append(h('div', { class: 'search' }, input), actions, tagRow, list);
  lib.on('change', () => {
    if (ctx.active()) renderList();
  });
  renderList();
  return { el, onShow: renderList };
}

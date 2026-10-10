/**
 * The four tabs of the left (library) region: Add, Prefabs, Maps and Scenes. Each is a `PanelDef`; the region
 * (`panelRegion.ts`) and the registry decide where and when they appear.
 */
import type { App } from '../app/app';
import { JOINT_ITEMS, LIGHT_ITEMS, SOFT_ITEMS } from '../app/addCatalog';
import type { PanelDef } from '../app/registry/panels';
import { shortcutTokens } from '../app/registry/shortcuts';
import {
  listMaps,
  listPrefabs,
  listTemplates,
  MAP_DIFFICULTY_LABELS,
  onContentChange,
  templateCategories,
  type MapInfo,
} from '../model/content';
import { listShapes } from '../model/shapeRegistry';
import { button } from './controls';
import { clear, h } from './dom';
import { icon } from './icons';
import { confirmReplace, importDocument } from './sceneActions';
import { zoneTiles } from './zoneTiles'; // -- ZN
import { buildShapePalette } from './shapePalette'; // -- SH

// ── Add ───────────────────────────────────────────────────────────────────────────────────────────

function addTab(app: App): HTMLElement {
  const { prefs } = app;
  const root = h('div');
  // -- SH: categories, search and generated thumbnails (src/ui/shapePalette.ts) replace the flat grid of shapes
  root.appendChild(buildShapePalette(app));

  root.appendChild(h('div', { class: 'group-title' }, 'Soft bodies'));
  const st = h('div', { class: 'tiles' });
  for (const s of SOFT_ITEMS) {
    const t = h('button', { class: 'tile', type: 'button', title: `${s.blurb} — click to add` }, icon(s.icon), s.label);
    t.addEventListener('click', () => app.addSoft(s.type));
    st.appendChild(t);
  }
  root.appendChild(st);

  root.appendChild(h('div', { class: 'group-title' }, 'Lights, paths & groups'));
  const sc = h('div', { class: 'tiles' });
  for (const l of LIGHT_ITEMS) {
    const t = h(
      'button',
      { class: 'tile', type: 'button', title: `${l.blurb} — click to add a ${l.label.toLowerCase()} light` },
      icon(l.icon),
      l.label,
    );
    t.addEventListener('click', () => app.addLight(l.type));
    sc.appendChild(t);
  }
  const pathTile = h(
    'button',
    { class: 'tile', type: 'button', title: 'A spline through points — a track for movers and cameras. Click to add' },
    icon('path'),
    'Path',
  );
  pathTile.addEventListener('click', () => app.addPath());
  const groupTile = h(
    'button',
    {
      class: 'tile',
      type: 'button',
      title: 'Group the selection into a folder that moves as one (Ctrl+G); with nothing selected, add an empty group',
    },
    icon('group'),
    'Group',
  );
  groupTile.addEventListener('click', () => app.addGroup());
  sc.append(pathTile, groupTile);
  root.appendChild(sc);

  root.append(...zoneTiles(app)); // -- ZN: trigger zones, race lines, launch pads …

  root.appendChild(h('div', { class: 'group-title' }, 'Connect & constrain'));
  const jt = h('div', { class: 'tiles three' });
  for (const j of JOINT_ITEMS) {
    const on = prefs.value.tool === 'joint' && prefs.value.jointType === j.type;
    const t = h(
      'button',
      {
        class: `tile ${on ? 'on' : ''}`,
        type: 'button',
        title: `${j.blurb}\nClick, then click two bodies in the scene (J).`,
      },
      icon(j.icon),
      j.label,
    );
    t.addEventListener('click', () => app.startJointTool(j.type));
    jt.appendChild(t);
  }
  root.appendChild(jt);
  root.appendChild(
    h(
      'p',
      { class: 'hint-text', style: { padding: '8px 12px 0' } },
      'Pick a joint, then click the first body, then the second (or empty ground to pin to the world). The joint appears at your first click; select it to add limits, a motor, or spring settings.',
    ),
  );

  root.appendChild(h('div', { class: 'group-title' }, 'Quick tips'));
  const keys = Math.min(9, listShapes().length);
  root.appendChild(
    h(
      'ul',
      { class: 'hint-text', style: { padding: '0 12px 12px 28px', margin: '0' } },
      h(
        'li',
        null,
        'Press ',
        h('kbd', null, '1'),
        '–',
        h('kbd', null, String(keys)),
        ' to add shapes at the view centre.',
      ),
      h('li', null, 'Drag a body to move it; hold ', h('kbd', null, 'Shift'), ' to lift it.'),
      h('li', null, 'Press ', h('kbd', null, 'Space'), ' to simulate — then drag bodies to throw them.'),
      h(
        'li',
        null,
        'Press ',
        ...shortcutTokens('Mod+K').flatMap((k, i) => [i ? ' ' : '', h('kbd', null, k)]),
        ' to search every command, scene and setting.',
      ),
      h('li', null, 'Open ', h('b', null, 'Scenes'), ' for ready-made experiments.'),
    ),
  );
  return root;
}

export const addPanel: PanelDef = {
  id: 'add',
  label: 'Add',
  icon: 'plus',
  region: 'left',
  order: 10,
  title: 'Add shapes, soft bodies, lights, paths and joints',
  build(app, ctx) {
    const el = h('div', { class: 'panel-body' });
    const render = () => {
      clear(el);
      el.appendChild(addTab(app));
    };
    // The joint tiles show which joint type is armed.
    app.prefs.on('change', (k) => {
      if ((k.includes('jointType') || k.includes('tool')) && ctx.active()) render();
    });
    return { el, onShow: render };
  },
};

// ── Prefabs ───────────────────────────────────────────────────────────────────────────────────────

function prefabTab(app: App): HTMLElement {
  const root = h('div');
  const groups = new Map<string, ReturnType<typeof listPrefabs>[number][]>();
  for (const p of listPrefabs()) {
    const title = p.category ?? 'Insert an assembly';
    const list = groups.get(title);
    if (list) list.push(p);
    else groups.set(title, [p]);
  }
  for (const [title, prefabs] of groups) {
    root.appendChild(h('div', { class: 'group-title' }, title));
    const cards = h('div', { class: 'cards' });
    for (const p of prefabs) {
      const c = h(
        'button',
        // -- ED-A snap: cards can be dragged onto a surface of the scene (ED-15) --
        {
          class: 'card',
          type: 'button',
          draggable: true,
          title: 'Click to insert at the centre of the view, or drag onto a surface',
        },
        h('h4', null, icon(p.icon), p.name),
        h('p', null, p.blurb),
      );
      c.addEventListener('click', () => app.insertPrefab(p.id));
      c.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/x-physicslab-prefab', p.id);
        e.dataTransfer?.setData('text/plain', p.name);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });
      cards.appendChild(c);
    }
    root.appendChild(cards);
  }
  return root;
}

export const prefabsPanel: PanelDef = {
  id: 'prefabs',
  label: 'Prefabs',
  icon: 'layers',
  region: 'left',
  order: 20,
  title: 'Ready-made assemblies to drop into the scene',
  build(app, ctx) {
    const el = h('div', { class: 'panel-body' });
    const render = () => {
      clear(el);
      el.appendChild(prefabTab(app));
    };
    onContentChange((c) => {
      if (c.kind === 'prefab' && ctx.active()) render();
    });
    return { el, onShow: render };
  },
};

// ── Maps ──────────────────────────────────────────────────────────────────────────────────────────

/** Thumbnails already produced, by map id — the list is re-rendered on every keystroke of the filter. */
const thumbnails = new Map<string, string | Promise<string>>();

/** The thumbnail of a map: its image, or — until an asynchronous one arrives, or without one — the map's icon. */
function mapThumb(m: MapInfo): HTMLElement {
  const box = h('span', { class: 'map-thumb' }, icon(m.icon ?? 'layers'));
  if (!m.thumbnail) return box;
  const put = (url: string) => {
    const img = h('img', { src: url, alt: '', draggable: false, loading: 'lazy' });
    box.replaceChildren(img);
  };
  try {
    let t = thumbnails.get(m.id);
    if (t === undefined) {
      t = typeof m.thumbnail === 'function' ? m.thumbnail() : m.thumbnail;
      thumbnails.set(m.id, t);
    }
    if (typeof t === 'string') put(t);
    else t.then(put, () => undefined); // keep the icon if the thumbnail cannot be produced
  } catch {
    /* keep the icon */
  }
  return box;
}

// A map registered again under an old id (tests, hot content) must not show the old picture.
onContentChange((c) => {
  if (c.kind === 'map') thumbnails.delete(c.id);
});

function mapsTab(app: App, query: string): HTMLElement {
  const root = h('div');
  const q = query.trim().toLowerCase();
  const maps = listMaps().filter(
    (m) =>
      !q ||
      [m.name, m.description, m.category, ...m.tags, MAP_DIFFICULTY_LABELS[m.difficulty]].some((s) =>
        s.toLowerCase().includes(q),
      ),
  );
  if (!maps.length) {
    root.appendChild(
      h(
        'div',
        { class: 'empty-state' },
        icon('layers', 'icon big'),
        h('h4', null, q ? 'No map matches' : 'No maps registered'),
        h(
          'p',
          null,
          q
            ? `Nothing matches “${query.trim()}”. Try a category, a tag or a difficulty.`
            : 'Maps are registered from src/model/content (see docs/EXTENDING.md).',
        ),
      ),
    );
    return root;
  }
  const byCategory = new Map<string, MapInfo[]>();
  for (const m of maps) {
    const list = byCategory.get(m.category);
    if (list) list.push(m);
    else byCategory.set(m.category, [m]);
  }
  for (const [category, list] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    root.appendChild(h('div', { class: 'group-title' }, category));
    const cards = h('div', { class: 'cards' });
    for (const m of list) {
      const card = h(
        'button',
        {
          class: 'card map-card',
          type: 'button',
          title: `${m.objective}\nClick to open this map`,
          dataset: { map: m.id },
        },
        mapThumb(m),
        h(
          'span',
          { class: 'map-info' },
          h('h4', null, m.name),
          h('p', null, m.description),
          // The difficulty sits in the tag row: next to a short name it made the title wrap in the 268 px panel.
          h(
            'span',
            { class: 'map-tags' },
            h('span', { class: `tag diff-${m.difficulty}` }, MAP_DIFFICULTY_LABELS[m.difficulty]),
            ...m.tags.map((t) => h('span', { class: 'chip-tag' }, t)),
          ),
        ),
      );
      card.addEventListener('click', () => void confirmReplace(app, () => app.loadMap(m.id)));
      cards.appendChild(card);
    }
    root.appendChild(cards);
  }
  return root;
}

export const mapsPanel: PanelDef = {
  id: 'maps',
  label: 'Maps',
  icon: 'map',
  region: 'left',
  order: 30,
  title: 'Arenas and levels, each with its own camera',
  build(app, ctx) {
    const el = h('div', { class: 'panel-body' });
    let query = '';
    const input = h('input', {
      type: 'text',
      placeholder: 'Filter maps…',
      spellcheck: false,
      'aria-label': 'Filter maps',
    });
    const list = h('div');
    input.addEventListener('input', () => {
      query = input.value;
      renderList();
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    const renderList = () => {
      clear(list);
      list.appendChild(mapsTab(app, query));
    };
    el.append(h('div', { class: 'search' }, input), list);
    onContentChange((c) => {
      if (c.kind === 'map' && ctx.active()) renderList();
    });
    return { el, onShow: renderList };
  },
};

// ── Scenes ────────────────────────────────────────────────────────────────────────────────────────

function scenesTab(app: App, rerender: () => void): HTMLElement {
  const root = h('div');
  root.appendChild(h('div', { class: 'group-title' }, 'My scenes'));
  const lib = app.persistence.library();
  const mine = h('div', { class: 'cards', style: { paddingBottom: '2px' } });
  if (!lib.length)
    mine.appendChild(
      h(
        'p',
        { class: 'hint-text', style: { margin: '0' } },
        'Nothing saved yet. Use File → Save to library (Ctrl+S). Your current scene is always autosaved.',
      ),
    );
  for (const e of lib) {
    const open = h(
      'button',
      { class: 'card', type: 'button', style: { flex: '1' } },
      h('h4', null, icon('folder'), e.name),
      h('p', null, `${e.bodies} bodies · ${new Date(e.savedAt).toLocaleString()}`),
    );
    open.addEventListener('click', () => {
      const doc = app.persistence.openFromLibrary(e.id);
      if (doc) void confirmReplace(app, () => app.loadDocument(doc, 'frame'));
    });
    const del = h('button', { class: 'icon-btn', type: 'button', title: 'Delete from library' }, icon('trash'));
    del.addEventListener('click', () => {
      app.persistence.deleteFromLibrary(e.id);
      rerender();
    });
    mine.appendChild(h('div', { class: 'card-row' }, open, del));
  }
  root.appendChild(mine);
  const actions = h('div', { style: { display: 'flex', gap: '6px', padding: '4px 12px 8px' } });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (f) void importDocument(app, f);
  });
  actions.append(
    button(
      'Save current',
      () => {
        const e = app.persistence.saveToLibrary();
        if (e) {
          app.toast(`Saved “${e.name}”`, 'success');
          rerender();
        }
      },
      { icon: 'save', cls: 'small' },
    ),
    button('Import…', () => fileIn.click(), { icon: 'upload', cls: 'small' }),
    fileIn,
  );
  root.appendChild(actions);

  for (const cat of templateCategories()) {
    root.appendChild(h('div', { class: 'group-title' }, cat));
    const cards = h('div', { class: 'cards' });
    for (const t of listTemplates().filter((x) => x.category === cat)) {
      const c = h('button', { class: 'card', type: 'button' }, h('h4', null, t.name), h('p', null, t.blurb));
      c.addEventListener('click', () => void confirmReplace(app, () => app.loadTemplate(t.id)));
      cards.appendChild(c);
    }
    root.appendChild(cards);
  }
  return root;
}

export const scenesPanel: PanelDef = {
  id: 'scenes',
  label: 'Scenes',
  icon: 'folder',
  region: 'left',
  order: 40,
  title: 'Example scenes and your saved scenes',
  build(app, ctx) {
    const el = h('div', { class: 'panel-body' });
    const render = () => {
      clear(el);
      el.appendChild(scenesTab(app, render));
    };
    onContentChange((c) => {
      if (c.kind === 'template' && ctx.active()) render();
    });
    return { el, onShow: render };
  },
};

export const LIBRARY_PANELS: readonly PanelDef[] = [addPanel, prefabsPanel, mapsPanel, scenesPanel];

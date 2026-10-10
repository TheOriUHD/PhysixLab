/**
 * The shape palette of the Add tab: every registered shape as a tile with a generated thumbnail, grouped by
 * category (Basic, Structural, Mechanical, Solids, Special) in collapsible sections, with a search box. The first
 * nine shapes of the registry carry their number key as a badge (1–9 add them at the view centre); drag a tile
 * into the scene or click it to add.
 *
 * Keyboard: Tab enters the grid at one tile; the arrow keys move between tiles (Home / End jump to the ends), Enter
 * or Space adds; in the search box ↓ moves to the first result, Enter adds the best match and Escape clears.
 */
import type { App } from '../app/app';
import { shapePlaceable } from '../app/placeables';
import { listShapes, type ShapeDef } from '../model/shapeRegistry';
import { requestThumbnail } from '../render/thumbnails';
import { button } from './controls';
import { h } from './dom';
import { emptyState } from './emptyState'; // -- UI-B: empty states --
import { icon } from './icons';
import { bindPlaceable } from './placementTiles';
import { groupByCategory, searchShapes, type ShapeHit } from './shapeSearch';
import '../styles/shapePalette.css';
// -- UI-B: favourites --
import { favStar } from './qol/favUi';
import { favouriteStore } from './qol/stores';
// -- end UI-B --

const COLLAPSED_KEY = 'physicslab.shapePalette.collapsed';

/** State that outlives a re-render of the Add tab. */
const state = { query: '', collapsed: null as Set<string> | null, focusId: '' };

function collapsedSet(): Set<string> {
  if (state.collapsed) return state.collapsed;
  state.collapsed = new Set();
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) for (const c of JSON.parse(raw) as unknown[]) if (typeof c === 'string') state.collapsed.add(c);
  } catch {
    /* no storage: groups simply start open */
  }
  return state.collapsed;
}

function saveCollapsed(): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedSet()]));
  } catch {
    /* not persisted */
  }
}

function tooltip(def: ShapeDef, index: number): string {
  const key = index < 9 ? ` (${index + 1})` : '';
  return `${def.label}${def.blurb ? ` — ${def.blurb}` : ''}\nDrag into the scene, or click and then click where it should go${key}\nDouble-click: add at the view centre`;
}

function tile(app: App, hit: ShapeHit, tabbable: boolean): HTMLButtonElement {
  const { def, index } = hit;
  const art = h('span', { class: 'tile-art' }, icon(def.icon));
  const t = h(
    'button',
    {
      class: 'tile shape-tile',
      type: 'button',
      title: tooltip(def, index),
      tabIndex: tabbable ? 0 : -1,
      dataset: { shape: def.id, ...(index < 9 ? { key: String(index + 1) } : {}) },
    },
    art,
    h('span', { class: 'tile-name' }, def.label),
  );
  requestThumbnail(def, (url) => {
    const img = h('img', { src: url, alt: '', draggable: false, width: 40, height: 40 });
    art.replaceChildren(img);
  });
  t.appendChild(favStar('shape', def.id, def.label)); // -- UI-B --
  // -- ghost placement: press and move drags a ghost into the scene, a click arms it, a double-click adds at the centre --
  bindPlaceable(app, t, `shape:${def.id}`, () => shapePlaceable(def.id));
  t.addEventListener('focus', () => (state.focusId = def.id));
  return t;
}

/** The tile above / below `from` (the nearest one in the neighbouring row), by position on screen. */
function neighbourRow(tiles: HTMLElement[], from: HTMLElement, dir: 1 | -1): HTMLElement | null {
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  let best: HTMLElement | null = null;
  let bestRow = Infinity;
  let bestDx = Infinity;
  for (const t of tiles) {
    if (t === from) continue;
    const b = t.getBoundingClientRect();
    const dy = (b.top - r.top) * dir;
    if (dy < r.height * 0.5) continue; // the same row or the wrong way
    const dx = Math.abs(b.left + b.width / 2 - cx);
    if (dy < bestRow - 2 || (Math.abs(dy - bestRow) <= 2 && dx < bestDx)) {
      best = t;
      bestRow = dy;
      bestDx = dx;
    }
  }
  return best;
}

export function buildShapePalette(app: App): HTMLElement {
  const root = h('div', { class: 'shape-palette' });
  const defs = listShapes();
  const input = h('input', {
    type: 'text',
    class: 'shape-search-input',
    placeholder: 'Search shapes…',
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Search shapes',
    value: state.query,
  });
  const clearBtn = h(
    'button',
    { class: 'icon-btn small shape-search-clear', type: 'button', title: 'Clear search', 'aria-label': 'Clear search' },
    icon('close'),
  );
  const status = h('div', { class: 'shape-status', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'shape-groups' });
  root.append(h('div', { class: 'search shape-search' }, icon('search'), input, clearBtn), status, body);

  const visibleTiles = (): HTMLElement[] => [...body.querySelectorAll<HTMLElement>('.shape-tile')];

  const render = () => {
    const hits = searchShapes(defs, state.query);
    const searching = state.query.trim().length > 0;
    clearBtn.hidden = !state.query;
    body.replaceChildren();
    status.textContent = searching ? `${hits.length} ${hits.length === 1 ? 'shape matches' : 'shapes match'}` : '';
    if (!hits.length) {
      const clear = button(
        'Clear search',
        () => {
          state.query = '';
          input.value = '';
          render();
          input.focus();
        },
        { cls: 'small' },
      );
      // -- UI-B: empty state with an illustration --
      const none = emptyState({
        art: 'search',
        title: 'No shape matches',
        hint: `Nothing matches “${state.query.trim()}”. Try a general word like “ramp”, “dice”, “gear” or “beam”.`,
      });
      none.appendChild(h('div', { style: { marginTop: '10px' } }, clear));
      body.appendChild(none);
      return;
    }
    // the tile that Tab enters: the one focused last if it is still shown, else the first
    const tabbableId = hits.some((x) => x.def.id === state.focusId) ? state.focusId : hits[0].def.id;
    if (searching) {
      body.appendChild(
        h(
          'div',
          { class: 'group-title shape-group-title static' },
          h('span', null, 'Results'),
          h('i', null, String(hits.length)),
        ),
      );
      body.appendChild(
        h(
          'div',
          { class: 'tiles shape-tiles', role: 'group', 'aria-label': 'Search results' },
          hits.map((x) => tile(app, x, x.def.id === tabbableId)),
        ),
      );
      return;
    }
    // -- UI-B: starred shapes first --
    const favHits = hits.filter((x) => favouriteStore().has('shape', x.def.id));
    if (favHits.length)
      body.appendChild(
        h(
          'div',
          { dataset: { favourites: 'shape' } },
          h(
            'div',
            { class: 'group-title shape-group-title static' },
            h('span', null, '★ Favourites'),
            h('i', null, String(favHits.length)),
          ),
          h(
            'div',
            { class: 'tiles shape-tiles', role: 'group', 'aria-label': 'Favourite shapes' },
            favHits.map((x) => tile(app, x, false)),
          ),
        ),
      );
    // -- end UI-B --
    const collapsed = collapsedSet();
    for (const group of groupByCategory(hits)) {
      const open = !collapsed.has(group.category);
      const title = h(
        'button',
        {
          class: `group-title shape-group-title${open ? '' : ' closed'}`,
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          title: open ? `Collapse ${group.label}` : `Expand ${group.label}`,
          dataset: { category: group.category },
        },
        icon('chevronDown', 'icon caret'),
        h('span', null, group.label),
        h('i', null, String(group.hits.length)),
      );
      title.addEventListener('click', () => {
        if (collapsed.has(group.category)) collapsed.delete(group.category);
        else collapsed.add(group.category);
        saveCollapsed();
        render();
        body.querySelector<HTMLElement>(`[data-category="${group.category}"]`)?.focus();
      });
      body.appendChild(title);
      if (open)
        body.appendChild(
          h(
            'div',
            { class: 'tiles shape-tiles', role: 'group', 'aria-label': group.label },
            group.hits.map((x) => tile(app, x, x.def.id === tabbableId)),
          ),
        );
    }
  };

  // ---- search box
  input.addEventListener('input', () => {
    state.query = input.value;
    render();
  });
  clearBtn.addEventListener('click', () => {
    state.query = '';
    input.value = '';
    render();
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing must not trigger the 1–9 / letter shortcuts
    if (e.key === 'Escape') {
      if (state.query) {
        state.query = '';
        input.value = '';
        render();
      } else input.blur();
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      visibleTiles()[0]?.focus();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      const first = searchShapes(defs, state.query)[0];
      if (first && state.query.trim()) {
        // -- ghost placement: arm it and hand the keyboard to the scene (Enter there places it, Esc cancels) --
        app.placement.ghost.arm(shapePlaceable(first.def.id));
        input.blur();
        e.preventDefault();
      }
    }
  });

  // ---- arrow-key navigation over the tiles
  body.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('shape-tile')) return;
    const tiles = visibleTiles();
    const at = tiles.indexOf(target);
    let next: HTMLElement | null | undefined;
    switch (e.key) {
      case 'ArrowRight':
        next = tiles[at + 1];
        break;
      case 'ArrowLeft':
        next = tiles[at - 1];
        break;
      case 'ArrowDown':
        next = neighbourRow(tiles, target, 1);
        break;
      case 'ArrowUp':
        next = neighbourRow(tiles, target, -1);
        if (!next) {
          input.focus();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        break;
      case 'Home':
        next = tiles[0];
        break;
      case 'End':
        next = tiles[tiles.length - 1];
        break;
      default:
        return;
    }
    // the arrows must not nudge the selected body
    e.preventDefault();
    e.stopPropagation();
    if (next) {
      for (const t of tiles) t.tabIndex = t === next ? 0 : -1;
      next.focus();
    }
  });

  render();
  // -- UI-B: a star toggled anywhere redraws the palette (and the subscription ends with the palette) --
  const off = favouriteStore().onChange((k) => {
    if (!root.isConnected) off();
    else if (k === 'shape') render();
  });
  // -- end UI-B --
  return root;
}

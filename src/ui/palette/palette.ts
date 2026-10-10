/**
 * The command palette (Ctrl/Cmd+K): one search box over every command, setting, example scene, saved scene, prefab
 * and map. Typing filters with fuzzy matching (`./fuzzy.ts`, `./search.ts`); ↑ ↓ move, Enter runs, Esc closes; what
 * was run last comes first. The item list is collected from the registries each time the palette opens
 * (`./items.ts`), so anything a package registers is searchable without further wiring.
 *
 * Accessibility: the input is an ARIA combobox that controls a listbox and points at the active option with
 * `aria-activedescendant` (focus never leaves the input); results are announced through a polite live region.
 */
import type { App } from '../../app/app';
import { COMMAND_CATEGORY_ORDER } from '../../app/registry/commands';
import { clear, h } from '../dom';
import { icon } from '../icons';
import { paletteHistory } from './history';
import { buildPaletteItems, type PaletteItem } from './items';
import { rankItems, type Ranked } from './search';

interface OpenPalette {
  close(): void;
}
let current: OpenPalette | null = null;

export const isPaletteOpen = (): boolean => current !== null;

export function togglePalette(app: App): void {
  if (current) current.close();
  else openPalette(app);
}

const GROUP_ORDER: readonly string[] = [
  ...COMMAND_CATEGORY_ORDER,
  'Settings',
  'Examples',
  'Saved scenes',
  'Prefabs',
  'Maps',
];
const groupRank = (g: string): number => {
  const i = GROUP_ORDER.indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
};

/** The label with the matched stretches wrapped in <mark>. */
function highlighted(label: string, ranges: [number, number][]): (string | HTMLElement)[] {
  const out: (string | HTMLElement)[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) out.push(label.slice(at, a));
    out.push(h('mark', null, label.slice(a, b)));
    at = b;
  }
  if (at < label.length) out.push(label.slice(at));
  return out;
}

interface Section {
  title: string | null;
  rows: Ranked<PaletteItem>[];
}

/** With a query: one flat, best-first list. Without: recent items first, then every group in a fixed order. */
function sectionsFor(ranked: Ranked<PaletteItem>[], hasQuery: boolean): Section[] {
  if (hasQuery) return ranked.length ? [{ title: null, rows: ranked }] : [];
  const recent = ranked.filter((r) => r.recent);
  const groups = new Map<string, Ranked<PaletteItem>[]>();
  for (const r of ranked) {
    if (r.recent) continue;
    const list = groups.get(r.item.group);
    if (list) list.push(r);
    else groups.set(r.item.group, [r]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => groupRank(a) - groupRank(b));
  return [
    ...(recent.length ? [{ title: 'Recent', rows: recent }] : []),
    ...ordered.map(([title, rows]) => ({ title, rows })),
  ];
}

export function openPalette(app: App): void {
  if (current) return;
  const items = buildPaletteItems(app);
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    role: 'combobox',
    spellcheck: false,
    autocomplete: 'off',
    placeholder: 'Search commands, settings, scenes, prefabs and maps…',
    'aria-label': 'Search commands',
    'aria-expanded': 'true',
    'aria-controls': 'palette-list',
    'aria-autocomplete': 'list',
    'aria-activedescendant': '',
  });
  const list = h('div', { class: 'palette-list', id: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
  const status = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const foot = h(
    'div',
    { class: 'palette-foot', 'aria-hidden': 'true' },
    h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' navigate'),
    h('span', null, h('kbd', null, '↵'), ' run'),
    h('span', null, h('kbd', null, 'Esc'), ' close'),
  );
  const box = h(
    'div',
    { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    h('div', { class: 'palette-input-row' }, icon('search'), input),
    list,
    status,
    foot,
  );
  const back = h('div', { class: 'palette-back' }, box);

  let rows: { el: HTMLElement; ranked: Ranked<PaletteItem> }[] = [];
  let active = 0;

  const setActive = (i: number, scroll = true) => {
    if (!rows.length) {
      input.setAttribute('aria-activedescendant', '');
      return;
    }
    active = (i + rows.length) % rows.length;
    rows.forEach((r, k) => r.el.setAttribute('aria-selected', k === active ? 'true' : 'false'));
    input.setAttribute('aria-activedescendant', rows[active].el.id);
    if (scroll) rows[active].el.scrollIntoView({ block: 'nearest' });
  };

  const run = (i: number) => {
    const r = rows[i]?.ranked;
    if (!r) return;
    paletteHistory.record(r.item.id);
    close();
    // After the palette is gone, so a dialog the command opens gets the focus.
    queueMicrotask(() => r.item.run());
  };

  const render = () => {
    const query = input.value;
    const hasQuery = query.trim().length > 0;
    const ranked = rankItems(items, query, paletteHistory.list());
    clear(list);
    rows = [];
    if (!ranked.length) {
      list.appendChild(
        h(
          'div',
          { class: 'palette-empty' },
          `Nothing matches “${query.trim()}”. Try a command, a scene, a prefab or a setting.`,
        ),
      );
      status.textContent = 'No results';
      setActive(0);
      return;
    }
    let n = 0;
    sectionsFor(ranked, hasQuery).forEach((section, si) => {
      const group = h('div', {
        class: 'palette-group',
        role: 'group',
        'aria-label': section.title ?? 'Results',
      });
      if (section.title)
        group.appendChild(h('div', { class: 'palette-heading', 'aria-hidden': 'true' }, section.title));
      for (const r of section.rows) {
        const idx = n++;
        const it = r.item;
        const el = h(
          'div',
          { class: 'palette-item', role: 'option', id: `palette-opt-${si}-${idx}`, 'aria-selected': 'false' },
          h('span', { class: 'palette-icon' }, it.icon ? icon(it.icon) : null),
          h(
            'span',
            { class: 'palette-text' },
            h('span', { class: 'palette-label' }, ...highlighted(it.label, r.ranges)),
            it.detail ? h('span', { class: 'palette-detail' }, it.detail) : null,
          ),
          h(
            'span',
            { class: 'palette-meta' },
            it.state ? h('span', { class: `palette-state ${it.state === 'On' ? 'on' : ''}` }, it.state) : null,
            it.shortcut ? h('kbd', null, it.shortcut) : null,
            hasQuery || section.title === 'Recent' ? h('span', { class: 'palette-tag' }, it.tag) : null,
          ),
        );
        el.addEventListener('pointermove', () => {
          if (active !== idx) setActive(idx, false);
        });
        el.addEventListener('click', () => run(idx));
        rows.push({ el, ranked: r });
        group.appendChild(el);
      }
      list.appendChild(group);
    });
    status.textContent = `${rows.length} ${rows.length === 1 ? 'result' : 'results'}`;
    setActive(0);
    list.scrollTop = 0;
  };

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive(active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive(active - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        setActive(Math.min(rows.length - 1, active + 8));
        break;
      case 'PageUp':
        e.preventDefault();
        setActive(Math.max(0, active - 8));
        break;
      case 'Enter':
        e.preventDefault();
        run(active);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        e.preventDefault(); // focus stays in the search box
        break;
    }
  });
  // Clicking inside the palette must not take focus away from the search box.
  box.addEventListener('pointerdown', (e) => {
    if (e.target !== input) e.preventDefault();
  });
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close();
  });

  function close(): void {
    if (current?.close !== close) return;
    current = null;
    back.remove();
    if (previouslyFocused && previouslyFocused.isConnected && previouslyFocused !== document.body)
      previouslyFocused.focus({ preventScroll: true });
  }
  current = { close };

  document.body.appendChild(back);
  render();
  input.focus();
}

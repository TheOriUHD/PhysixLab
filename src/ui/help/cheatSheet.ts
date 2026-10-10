/** The shortcut cheat-sheet overlay: searchable, keyboard-navigable, built from the command registry (UI-44). */
import type { App } from '../../app/app';
import { commandEnabled, getCommand, runCommand } from '../../app/registry/commands';
import { h } from '../dom';
import { emptyState } from '../emptyState';
import { openModal } from '../modal';
import { cheatSections, filterCheat, type CheatRow } from './cheatLogic';
import { openHelp } from './helpPanel';

const UNBOUND_KEY = 'physixlab.cheat.unbound';

function readUnbound(): boolean {
  try {
    return localStorage.getItem(UNBOUND_KEY) === '1';
  } catch {
    return false;
  }
}

/** Open the cheat-sheet. With an `app`, Enter / click on a row runs its command. */
export function openCheatSheet(app?: App): { close(): void; el: HTMLElement } {
  let unbound = readUnbound();
  let query = '';
  let active = 0;
  let rows: { row: CheatRow; el: HTMLElement }[] = [];

  const input = h('input', {
    class: 'plain cheat-filter',
    type: 'search',
    placeholder: 'Filter shortcuts and commands…  (↑ ↓ to move, Enter to run)',
    spellcheck: false,
    autofocus: true,
    'aria-label': 'Filter shortcuts',
    title: 'Filter shortcuts and commands',
  });
  const toggle = h('input', {
    type: 'checkbox',
    checked: unbound,
    'aria-label': 'Also list commands without a shortcut',
  });
  const toggleLabel = h(
    'label',
    { class: 'cheat-toggle', title: 'Also list commands that have no shortcut' },
    toggle,
    'Show commands without shortcuts',
  );
  const count = h('span', { class: 'cheat-count' });
  const list = h('div', { class: 'kbd-grid cheat-list', role: 'listbox', 'aria-label': 'Shortcuts' });
  const helpLink = h('button', { class: 'btn', type: 'button', title: 'Open the Help panel' }, 'Open Help (F1)');
  const bar = h('div', { class: 'cheat-bar' }, input, toggleLabel);

  const caps = (row: CheatRow): HTMLElement => {
    const wrap = h('span', { class: 'cheat-keys' });
    if (!row.alternatives.length) {
      wrap.appendChild(h('span', { class: 'cheat-none' }, 'no shortcut'));
      return wrap;
    }
    row.alternatives.forEach((keys, i) => {
      if (i) wrap.appendChild(h('span', { class: 'cheat-or' }, 'or'));
      wrap.appendChild(h('span', null, ...keys.map((k) => h('kbd', null, k))));
    });
    return wrap;
  };

  const setActive = (i: number, scroll = true) => {
    if (!rows.length) return;
    active = (i + rows.length) % rows.length;
    rows.forEach((r, k) => {
      r.el.classList.toggle('active', k === active);
      r.el.setAttribute('aria-selected', String(k === active));
    });
    if (scroll) rows[active].el.scrollIntoView({ block: 'nearest' });
  };

  const activate = (r: CheatRow) => {
    if (!app || !r.commandId) return;
    const def = getCommand(r.commandId);
    if (!def || !commandEnabled(def, app)) return;
    modal.close();
    // Run after the dialog is gone so commands that open dialogs of their own are not stranded behind it.
    setTimeout(() => runCommand(r.commandId!, app, 'palette'), 0);
  };

  const render = () => {
    list.replaceChildren();
    rows = [];
    const sections = filterCheat(cheatSections({ includeUnbound: unbound }), query);
    let n = 0;
    for (const s of sections) {
      list.appendChild(h('div', { class: 'kbd-group' }, s.title));
      for (const row of s.rows) {
        const el = h(
          'div',
          {
            class: `kbd-row cheat-row${row.commandId && app ? ' runnable' : ''}`,
            role: 'option',
            'aria-selected': 'false',
          },
          h('span', { class: 'cheat-label' }, row.label, row.hint ? h('small', null, row.hint) : null),
          caps(row),
        );
        const idx = rows.length;
        el.addEventListener('mousemove', () => {
          if (active !== idx) setActive(idx, false);
        });
        el.addEventListener('click', () => activate(row));
        list.appendChild(el);
        rows.push({ row, el });
        n++;
      }
    }
    if (!n)
      list.appendChild(
        emptyState({
          art: 'search',
          title: 'No shortcut matches',
          hint: unbound
            ? `Nothing matches “${query}”.`
            : `Nothing matches “${query}”. Tick “Show commands without shortcuts” to search every command.`,
        }),
      );
    count.textContent = n ? `${n} ${n === 1 ? 'entry' : 'entries'}` : '';
    active = 0;
    setActive(0, false);
  };

  input.addEventListener('input', () => {
    query = input.value;
    render();
  });
  toggle.addEventListener('change', () => {
    unbound = toggle.checked;
    try {
      localStorage.setItem(UNBOUND_KEY, unbound ? '1' : '0');
    } catch {
      /* private mode */
    }
    render();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
      if (r) activate(r.row);
    }
  });

  const modal = openModal({
    title: 'Keyboard shortcuts',
    body: [bar, list],
    footer: [count, h('span', { class: 'grow' }), helpLink],
    width: '780px',
  });
  modal.el.classList.add('cheat');
  helpLink.addEventListener('click', () => {
    modal.close();
    if (app) openHelp(app, 'keyboard-shortcuts');
  });
  if (!app) helpLink.remove();
  render();
  input.focus();
  return modal;
}

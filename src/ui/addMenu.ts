// -- ED-B: the Shift+A categorised Add menu with search (ED-32) --
import type { App } from '../app/app';
import type { Vec3 } from '../core/math';
import { fuzzyMatch } from './palette/fuzzy';
import { JOINT_ENTRIES, listAddEntries, type AddEntry } from './addEntries';
import { h } from './dom';
import { icon } from './icons';

interface Row {
  label: string;
  icon: string;
  blurb: string;
  section: string;
  group: string;
  run: (app: App, at: Vec3) => void;
}

let close: (() => void) | null = null;

/** Last pointer position seen anywhere on the page (the add menu uses it when it lies inside the viewport). */
let lastPointer: { x: number; y: number } | null = null;
if (typeof window !== 'undefined')
  window.addEventListener(
    'pointermove',
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    true,
  );

function allRows(): Row[] {
  const rows: Row[] = listAddEntries().map((e: AddEntry) => ({
    label: e.label,
    icon: e.icon,
    blurb: e.blurb,
    section: e.section,
    group: e.group,
    run: e.add,
  }));
  for (const j of JOINT_ENTRIES)
    rows.push({
      label: j.label,
      icon: j.icon,
      blurb: j.blurb,
      section: 'Joints',
      group: '',
      run: (app) => j.start(app),
    });
  return rows;
}

/** Entries matching `query`, best first; with an empty query the catalogue in menu order. */
export function filterRows<T extends { label: string; section: string; group: string }>(rows: T[], query: string): T[] {
  const q = query.trim();
  if (!q) return rows;
  const scored: { row: T; score: number }[] = [];
  for (const row of rows) {
    const byLabel = fuzzyMatch(q, row.label);
    const byAll = fuzzyMatch(q, `${row.label} ${row.group} ${row.section}`);
    const score = byLabel ? byLabel.score + 20 : byAll ? byAll.score : null;
    if (score !== null) scored.push({ row, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.row);
}

export function closeAddMenu(): void {
  close?.();
}

/** Open the add menu at the pointer (when it is over the viewport) or the viewport centre. */
export function openAddMenu(app: App): void {
  closeAddMenu();
  const vr = app.viewport.dom.getBoundingClientRect();
  const inside =
    lastPointer &&
    lastPointer.x >= vr.left &&
    lastPointer.x <= vr.right &&
    lastPointer.y >= vr.top &&
    lastPointer.y <= vr.bottom;
  const anchor = inside && lastPointer ? lastPointer : { x: vr.left + vr.width / 2, y: vr.top + vr.height / 2 };
  const ev = { clientX: anchor.x, clientY: anchor.y };

  // Where new objects land: the surface under the pointer, else the ground, else the view target.
  const hit = app.pickEntity(ev, { joints: false });
  const ground = app.picker.groundPoint(ev, 0);
  const t = app.viewport.controls.target;
  const at: Vec3 = hit ? [hit.point.x, hit.point.y, hit.point.z] : ground ? [ground.x, 0, ground.z] : [t.x, 0, t.z];

  const rows = allRows();
  const input = h('input', {
    class: 'addmenu-search',
    type: 'text',
    placeholder: 'Add… (type to search)',
    'aria-label': 'Search objects to add',
    autocomplete: 'off',
    spellcheck: false,
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'addmenu-list',
  });
  const list = h('div', { class: 'addmenu-list', id: 'addmenu-list', role: 'listbox' });
  const root = h('div', { class: 'addmenu', role: 'dialog', 'aria-label': 'Add object' }, input, list);

  let shown: Row[] = [];
  let active = 0;
  const choose = (row: Row) => {
    closeAddMenu();
    row.run(app, at);
  };
  const setActive = (i: number) => {
    const els = list.querySelectorAll<HTMLElement>('.addmenu-item');
    if (!els.length) return;
    active = (i + els.length) % els.length;
    els.forEach((el, k) => {
      el.classList.toggle('on', k === active);
      el.setAttribute('aria-selected', k === active ? 'true' : 'false');
    });
    els[active].scrollIntoView?.({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', els[active].id);
  };
  const render = () => {
    shown = filterRows(rows, input.value);
    const q = input.value.trim();
    const out: HTMLElement[] = [];
    let lastHead = '';
    shown.forEach((row, i) => {
      const head = q ? '' : row.group ? `${row.section} · ${row.group}` : row.section;
      if (head !== lastHead) {
        if (head) out.push(h('div', { class: 'addmenu-head' }, head));
        lastHead = head;
      }
      const el = h(
        'div',
        { class: 'addmenu-item', role: 'option', id: `addmenu-opt-${i}`, title: row.blurb, 'aria-selected': 'false' },
        icon(row.icon),
        h('span', { class: 'grow' }, row.label),
        q ? h('span', { class: 'addmenu-tag' }, row.section) : null,
      );
      el.addEventListener('pointermove', () => {
        if (active !== i) setActive(i);
      });
      el.addEventListener('click', () => choose(row));
      out.push(el);
    });
    if (!shown.length) out.push(h('div', { class: 'addmenu-empty' }, `Nothing matches “${q}”`));
    list.replaceChildren(...out);
    setActive(0);
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') setActive(active + 1);
    else if (e.key === 'ArrowUp') setActive(active - 1);
    else if (e.key === 'Enter') {
      if (shown[active]) choose(shown[active]);
    } else if (e.key === 'Escape') closeAddMenu();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  document.body.appendChild(root);
  render();
  const r = root.getBoundingClientRect();
  root.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8))}px`;
  root.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8))}px`;
  input.focus();

  const onDown = (e: PointerEvent) => {
    if (!root.contains(e.target as Node)) closeAddMenu();
  };
  setTimeout(() => window.addEventListener('pointerdown', onDown, true), 0);
  close = () => {
    window.removeEventListener('pointerdown', onDown, true);
    root.remove();
    close = null;
  };
}

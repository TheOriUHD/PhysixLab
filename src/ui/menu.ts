import type { MenuItem } from '../app/registry/menus';
import { h } from './dom';
import { icon } from './icons';

export type { MenuItem };

let openMenuEl: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeMenu(): void {
  cleanup?.();
  cleanup = null;
  openMenuEl?.remove();
  openMenuEl = null;
}

/** Show a popup menu anchored below `anchor` (or at explicit coordinates). */
export function openMenu(
  items: MenuItem[],
  anchor: HTMLElement | { x: number; y: number },
  onClose?: () => void,
): void {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  // -- ED-B: submenus replace the popup content; `stack` remembers where "Back" goes --
  const stack: { list: MenuItem[]; heading: string }[] = [];
  const build = (list: MenuItem[], heading?: string) => {
    menu.replaceChildren();
    if (heading !== undefined) {
      const back = h(
        'button',
        { class: 'menu-item menu-back', type: 'button' },
        h('span', { class: 'grow' }, '‹ Back'),
      );
      back.addEventListener('click', () => {
        const prev = stack.pop();
        if (prev) build(prev.list, prev.heading || undefined);
      });
      menu.appendChild(back);
      menu.appendChild(h('div', { class: 'menu-label' }, heading));
    }
    for (const it of list) {
      if ('sep' in it) {
        menu.appendChild(h('div', { class: 'menu-sep' }));
        continue;
      }
      if ('heading' in it) {
        menu.appendChild(h('div', { class: 'menu-label' }, it.heading));
        continue;
      }
      const b = h(
        'button',
        { class: 'menu-item', type: 'button', disabled: !!it.disabled },
        it.checked !== undefined
          ? h('span', { class: 'check' }, it.checked ? '✓' : '')
          : it.icon
            ? icon(it.icon)
            : h('span', { style: { width: '16px' } }),
        h('span', { class: 'grow' }, it.label),
        it.kbd ? h('span', { class: 'kb' }, it.kbd) : null,
        it.submenu ? h('span', { class: 'menu-chev' }, '›') : null,
      );
      b.addEventListener('click', () => {
        if (it.submenu) {
          stack.push({ list, heading: heading ?? '' });
          build(it.submenu, it.label);
          menu.querySelector<HTMLElement>('.menu-item:not(:disabled)')?.focus();
          return;
        }
        void it.action();
        if (it.keepOpen)
          build(
            list.map((x) => ('label' in x && x === it && x.checked !== undefined ? { ...x, checked: !x.checked } : x)),
          );
        else closeMenu();
      });
      menu.appendChild(b);
    }
  };
  build(items);
  document.body.appendChild(menu);
  openMenuEl = menu;

  const place = () => {
    const r = menu.getBoundingClientRect();
    let x: number, y: number;
    if (anchor instanceof HTMLElement) {
      const a = anchor.getBoundingClientRect();
      x = a.left;
      y = a.bottom + 4;
    } else {
      x = anchor.x;
      y = anchor.y;
    }
    x = Math.min(x, window.innerWidth - r.width - 8);
    y = Math.min(y, window.innerHeight - r.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
  };
  place();

  const onDown = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) {
      closeMenu();
      onClose?.();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeMenu();
      onClose?.();
      return;
    }
    // -- ED-B: keyboard navigation inside the popup --
    const rowsEl = [...menu.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)')];
    const i = rowsEl.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = rowsEl.length;
      if (!n) return;
      rowsEl[e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n].focus();
    } else if (e.key === 'ArrowRight') {
      if (i < 0 || !rowsEl[i].querySelector('.menu-chev')) return;
      rowsEl[i].click();
    } else if (e.key === 'ArrowLeft') {
      if (!stack.length) return;
      menu.querySelector<HTMLElement>('.menu-back')?.click();
      menu.querySelector<HTMLElement>('.menu-item')?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
  cleanup = () => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  };
}

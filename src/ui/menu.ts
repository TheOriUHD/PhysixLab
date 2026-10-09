import { h } from './dom';
import { icon } from './icons';

export type MenuItem =
  | {
      label: string;
      action: () => void | Promise<void>;
      icon?: string;
      kbd?: string;
      checked?: boolean;
      disabled?: boolean;
      keepOpen?: boolean;
    }
  | { sep: true }
  | { heading: string };

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
  const build = (list: MenuItem[]) => {
    menu.replaceChildren();
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
      );
      b.addEventListener('click', () => {
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
    }
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

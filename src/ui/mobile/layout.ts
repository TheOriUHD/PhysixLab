/**
 * Mobile / tablet layout (CM-13). Below 900 px the three docked regions stop being columns: the library (left) and
 * the inspector group (right) become drawers, the telemetry dock a bottom sheet, and the viewport takes the rest of
 * the window. The geometry is all CSS (`src/styles/cm-mobile.css`, media queries); this module adds what CSS cannot:
 *
 *  - which sheet is open. It reuses the panel preferences (`showLeft` / `showRight` / `showBottom`), so every command,
 *    the dock manager and "Show <panel>" keep working; at most one sheet is open at a time.
 *  - the bottom navigation (Library · Inspector · Data · Tools · View · Menu), the scrim and the close button;
 *  - the Tools / View popovers, which show the floating toolbox and view bar on demand;
 *  - the combined File / Edit / View / Help menu that the hidden menu bar leaves behind.
 *
 * The desktop panel arrangement is remembered while the window is narrow and restored when it is wide again.
 */
import type { App } from '../../app/app';
import { runCommand } from '../../app/registry/commands';
import { listBarMenus, resolveMenu, type MenuItem } from '../../app/registry/menus';
import { h, svg } from '../dom';
import { icon } from '../icons';
import { openMenu } from '../menu';
import { SHEETS, SHOW, enterNarrow, leaveNarrow, parsePanels, sheetToKeep, type Panels, type Sheet } from './sheets';

export type { Sheet };

/** The width at and below which the sheet layout applies (keep in sync with `cm-mobile.css`). */
export const NARROW_QUERY = '(max-width: 900px)';

const STASH_KEY = 'physicslab:desktop-panels';
/** Fallback when storage is unavailable: the arrangement is still restored within this page's life. */
let memoryStash: Panels | null = null;

function readStash(): Panels | null {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (raw) return parsePanels(JSON.parse(raw));
  } catch {
    /* fall through to the in-memory copy */
  }
  return memoryStash;
}
function writeStash(p: Panels | null): void {
  memoryStash = p;
  try {
    if (p) localStorage.setItem(STASH_KEY, JSON.stringify(p));
    else localStorage.removeItem(STASH_KEY);
  } catch {
    /* storage unavailable: the in-memory copy above is all there is */
  }
}

const hamburger = () =>
  svg(
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    'icon',
  );

export interface MobileLayout {
  /** Is the narrow layout active right now? */
  readonly narrow: boolean;
  /** Open one sheet (closing the others), or close all of them with `null`. */
  setSheet(which: Sheet | null): void;
  dispose(): void;
}

export function mountMobileLayout(app: App, root: HTMLElement): MobileLayout {
  const prefs = app.prefs;
  const mq = window.matchMedia(NARROW_QUERY);
  let narrow = mq.matches;
  let popover: 'tools' | 'view' | null = null;
  let wasOpen = false;
  let last: Record<Sheet, boolean> = { left: false, right: false, bottom: false };
  /** The navigation button that opened the current sheet / popover (focus goes back to it on close). */
  let opener: HTMLElement | null = null;

  const openSheets = (): Sheet[] => SHEETS.filter((s) => prefs.value[SHOW[s]]);

  const setSheet = (which: Sheet | null): void => {
    prefs.set({ showLeft: which === 'left', showRight: which === 'right', showBottom: which === 'bottom' });
  };

  // ---- DOM -------------------------------------------------------------------------------------
  const scrim = h('div', { class: 'm-scrim' });
  scrim.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setSheet(null);
    setPopover(null);
  });
  const close = h(
    'button',
    { class: 'm-close', type: 'button', title: 'Close panel', 'aria-label': 'Close panel' },
    icon('close'),
  );
  close.addEventListener('click', () => setSheet(null));

  const navBtn = (id: string, label: string, title: string, ic: SVGSVGElement, onClick: () => void) => {
    const b = h(
      'button',
      { class: 'm-nav-btn', type: 'button', title, 'aria-label': title, dataset: { nav: id }, 'aria-pressed': 'false' },
      ic,
      h('span', { class: 'm-nav-label' }, label),
    );
    b.addEventListener('click', () => {
      opener = b;
      onClick();
    });
    return b;
  };
  const toggleSheet = (s: Sheet) => () => setSheet(prefs.value[SHOW[s]] ? null : s);
  const bLeft = navBtn(
    'left',
    'Library',
    'Library: add shapes, prefabs, scenes',
    icon('panelLeft'),
    toggleSheet('left'),
  );
  const bRight = navBtn(
    'right',
    'Inspector',
    'Inspector, outliner and world',
    icon('panelRight'),
    toggleSheet('right'),
  );
  const bBottom = navBtn(
    'bottom',
    'Data',
    'Telemetry, timeline and charts',
    icon('panelBottom'),
    toggleSheet('bottom'),
  );
  const bTools = navBtn('tools', 'Tools', 'Tools: select, move, rotate, joints …', icon('move'), () =>
    setPopover(popover === 'tools' ? null : 'tools'),
  );
  const bView = navBtn('view', 'View', 'View options and cameras', icon('camera'), () =>
    setPopover(popover === 'view' ? null : 'view'),
  );
  const bMenu = navBtn('menu', 'Menu', 'File, edit, view and help menus', hamburger(), () => {
    closeAll();
    const items: MenuItem[] = [];
    for (const m of listBarMenus()) {
      if (items.length) items.push({ sep: true });
      items.push({ heading: m.label }, ...resolveMenu(app, m.id));
    }
    items.push(
      { sep: true },
      {
        label: 'Command palette…',
        icon: 'search',
        action: () => void runCommand('app.palette', app, 'button'),
      },
    );
    const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 48;
    openMenu(items, { x: 8, y: top + 4 });
  });
  const nav = h(
    'nav',
    { class: 'm-nav', 'aria-label': 'Panels and tools' },
    bLeft,
    bRight,
    bBottom,
    bTools,
    bView,
    bMenu,
  );
  root.append(scrim, close, nav);

  const closeAll = () => {
    setSheet(null);
    setPopover(null);
  };

  function setPopover(p: 'tools' | 'view' | null): void {
    popover = p;
    sync();
  }

  // ---- state -----------------------------------------------------------------------------------
  function sync(): void {
    const open = openSheets();
    for (const s of SHEETS) root.classList.toggle(`m-open-${s}`, narrow && open.includes(s));
    root.classList.toggle('m-sheet', narrow && open.length > 0);
    root.classList.toggle('m-tools', narrow && popover === 'tools' && !open.length);
    root.classList.toggle('m-view', narrow && popover === 'view' && !open.length);
    const on: Record<string, boolean> = {
      left: open.includes('left'),
      right: open.includes('right'),
      bottom: open.includes('bottom'),
      tools: popover === 'tools' && !open.length,
      view: popover === 'view' && !open.length,
    };
    for (const b of nav.querySelectorAll<HTMLElement>('[data-nav]')) {
      const state = on[b.dataset.nav ?? ''] ?? false;
      b.classList.toggle('on', state);
      b.setAttribute('aria-pressed', String(state));
      if (b.dataset.nav !== 'menu') b.setAttribute('aria-expanded', String(state));
    }
    // While a sheet is open the page behind the scrim is not reachable by keyboard or assistive technology.
    const sheetOpen = narrow && open.length > 0;
    for (const el of root.querySelectorAll<HTMLElement>('.topbar, .stage')) el.inert = sheetOpen;
    if (sheetOpen && !wasOpen) requestAnimationFrame(() => close.focus({ preventScroll: true }));
    if (!sheetOpen && wasOpen && opener?.isConnected) opener.focus({ preventScroll: true });
    wasOpen = sheetOpen;
  }

  /** Enter or leave the narrow layout: remember / restore the desktop arrangement of the three regions. */
  const apply = (): void => {
    narrow = mq.matches;
    root.classList.toggle('m-narrow', narrow);
    popover = null;
    if (narrow) {
      const v = prefs.value;
      const plan = enterNarrow({ showLeft: v.showLeft, showRight: v.showRight, showBottom: v.showBottom }, readStash());
      writeStash(plan.stash);
      if (openSheets().length) prefs.set(plan.panels);
    } else {
      const restore = leaveNarrow(readStash());
      writeStash(null);
      if (restore) prefs.set(restore);
    }
    last = { left: prefs.value.showLeft, right: prefs.value.showRight, bottom: prefs.value.showBottom };
    sync();
  };

  const offPrefs = prefs.on('change', (keys) => {
    if (!keys.some((k) => k === 'showLeft' || k === 'showRight' || k === 'showBottom')) return;
    if (narrow) {
      // One sheet at a time: the one that was just opened wins.
      const now = openSheets();
      const fresh = sheetToKeep(now, last);
      if (fresh) {
        last = { left: fresh === 'left', right: fresh === 'right', bottom: fresh === 'bottom' };
        setSheet(fresh);
        return;
      }
      if (now.length) popover = null;
    }
    last = { left: prefs.value.showLeft, right: prefs.value.showRight, bottom: prefs.value.showBottom };
    sync();
  });
  const onMq = () => apply();
  mq.addEventListener('change', onMq);

  // Escape closes a sheet or popover (unless a menu / dialog is on top of it, which handle Escape themselves).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !narrow || e.defaultPrevented) return;
    if (document.querySelector('.menu, .modal, .palette')) return;
    if (openSheets().length || popover) {
      closeAll();
      e.preventDefault();
      e.stopImmediatePropagation(); // the editor's own Escape (deselect, cancel the tool) must not also run
    }
  };
  window.addEventListener('keydown', onKey, true);
  // Tapping the viewport dismisses an open popover.
  const dismiss = () => {
    if (popover) setPopover(null);
  };
  app.viewport.dom.addEventListener('pointerdown', dismiss);

  apply();

  return {
    get narrow() {
      return narrow;
    },
    setSheet,
    dispose() {
      offPrefs();
      mq.removeEventListener('change', onMq);
      window.removeEventListener('keydown', onKey, true);
      app.viewport.dom.removeEventListener('pointerdown', dismiss);
      scrim.remove();
      close.remove();
      nav.remove();
    },
  };
}

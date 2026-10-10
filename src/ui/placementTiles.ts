/**
 * Makes a library tile (a shape, a soft body, a prefab card, a zone, a light …) place things with a ghost:
 *
 *   press and move   → a ghost follows the pointer into the viewport; release over the viewport places it
 *   click            → arms placement: the ghost follows the cursor, click places (Shift+click: several), Esc cancels
 *   double-click     → adds it at the centre of the view at once, without a ghost
 *   touch            → long-press the tile, then drag (a quick swipe still scrolls the panel)
 *
 * The behaviour itself lives in `app.placement.ghost` (`src/app/placementGhost.ts`); this file only turns pointer
 * events on a tile into `arm()` / `beginDrag()`. Tiles are deliberately not natively draggable: the browser's own
 * drag-and-drop shows a ghost image, hides the keyboard from the page and does not exist on touch screens.
 */
import type { App } from '../app/app';
import type { Placeable } from '../app/placeables';
import '../styles/placement.css';

/** Pixels a mouse must travel before a press becomes a drag. */
const MOUSE_SLOP = 5;
/** Pixels a finger may drift during a long-press (further, and it is a scroll). */
const TOUCH_SLOP = 10;
const LONG_PRESS_MS = 380;

interface Press {
  id: number;
  x: number;
  y: number;
  touch: boolean;
  dragging: boolean;
  timer: number;
  first: PointerEvent;
  off: () => void;
}

/**
 * Bind the tile `el`. `id` is the placeable's id (`Placeable.id`), kept on the element as `data-placeable` so the
 * tile can be highlighted while it is armed; `make` creates the placeable on demand (nothing is built until used).
 */
export function bindPlaceable(app: App, el: HTMLElement, id: string, make: () => Placeable | null): void {
  el.dataset.placeable = id;
  el.classList.add('placeable');
  el.draggable = false;
  const ghost = app.placement.ghost;
  let press: Press | null = null;
  let suppressClick = false;

  const endPress = (): void => {
    if (!press) return;
    window.clearTimeout(press.timer);
    press.off();
    press = null;
  };

  const startDrag = (e: PointerEvent): void => {
    const p = press;
    if (!p || p.dragging) return;
    const placeable = make();
    if (!placeable) return;
    p.dragging = true;
    suppressClick = true;
    ghost.beginDrag(placeable, e);
  };

  el.addEventListener('dragstart', (e) => e.preventDefault());
  el.addEventListener('contextmenu', (e) => {
    if (press?.touch) e.preventDefault(); // the long-press menu of touch browsers
  });

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    // a control nested in the tile (a favourite star) keeps its own click
    const inner = (e.target as Element).closest('button, a, input, select, textarea');
    if (inner && inner !== el) return;
    endPress();
    suppressClick = false;
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    const p: Press = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      touch,
      dragging: false,
      timer: 0,
      first: e,
      off: () => undefined,
    };
    press = p;
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== p.id || p.dragging) return;
      const dist = Math.hypot(ev.clientX - p.x, ev.clientY - p.y);
      if (touch) {
        // before the long-press has fired, moving is a scroll of the panel
        if (dist > TOUCH_SLOP) endPress();
        return;
      }
      if (dist >= MOUSE_SLOP) startDrag(ev);
    };
    const finish = (ev: PointerEvent): void => {
      if (ev.pointerId !== p.id) return;
      const dragged = p.dragging;
      endPress();
      if (dragged) window.setTimeout(() => (suppressClick = false), 0);
    };
    const stopScroll = (te: TouchEvent): void => {
      if (p.dragging && te.cancelable) te.preventDefault();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('touchmove', stopScroll, { capture: true, passive: false });
    p.off = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('touchmove', stopScroll, true);
    };
    if (touch) {
      p.timer = window.setTimeout(() => {
        try {
          navigator.vibrate?.(12);
        } catch {
          /* no haptics */
        }
        startDrag(p.first);
      }, LONG_PRESS_MS);
    }
  });

  el.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const inner = (e.target as Element).closest('button, a, input, select, textarea');
    if (inner && inner !== el) return;
    const placeable = make();
    if (placeable) ghost.arm(placeable);
  });

  el.addEventListener('dblclick', (e) => {
    const inner = (e.target as Element).closest('button, a, input, select, textarea');
    if (inner && inner !== el) return;
    e.preventDefault();
    ghost.cancel();
    make()?.addAtViewCentre(app);
  });
}

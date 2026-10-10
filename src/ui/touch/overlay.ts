/**
 * On-screen touch controls: two virtual joysticks and configurable action buttons drawn over the viewport. They write
 * into `app.input.touch` — the same pad shape a gamepad has — so the active vehicle profile maps them to the named
 * analog axes exactly like a real controller, and buttons become `Pad<Button>` key codes.
 *
 * Every control owns its pointer (pointer events + pointer capture), so both sticks and any number of buttons work at
 * once; releasing, cancelling, hiding the overlay or losing focus resets the control to zero.
 */
import type { App } from '../../app/app';
import { padLabel, type PadButton } from '../../app/input/gamepad';
import {
  clearPad,
  setPadButton,
  setStick,
  stickVector,
  type StickId,
  type StickVector,
} from '../../app/touch/joystick';
import { TOUCH_BUTTON_CHOICES, type TouchSettings } from '../../app/touch/settings';
import { h } from '../dom';

/** Is this a device whose primary input is touch? (`auto` mode.) */
export function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

const STICK_PX = 128;

export interface TouchOverlay {
  readonly el: HTMLElement;
  /** Is the overlay shown right now? */
  readonly visible: boolean;
  dispose(): void;
}

export function mountTouchOverlay(app: App): TouchOverlay {
  const hub = app.input;
  const root = h('div', { class: 'tc-overlay', hidden: true, 'aria-label': 'Touch controls' });
  app.shell.stage.appendChild(root);
  /** Pointers currently holding a control. */
  const held = new Set<number>();
  const sync = () => {
    hub.touchActive = held.size > 0;
  };
  const releaseAll = () => {
    clearPad(hub.touch);
    held.clear();
    sync();
    for (const t of root.querySelectorAll<HTMLElement>('.tc-thumb')) t.style.transform = '';
    for (const b of root.querySelectorAll('.pressed')) b.classList.remove('pressed');
  };

  // ---- stick -----------------------------------------------------------------------------------
  const makeStick = (which: StickId, scale: number): HTMLElement => {
    const thumb = h('div', { class: 'tc-thumb' });
    const el = h(
      'div',
      {
        class: 'tc-stick',
        role: 'slider',
        'aria-label': `${which === 'L' ? 'Left' : 'Right'} joystick`,
        dataset: { stick: which },
      },
      thumb,
    );
    let id = -1;
    const v: StickVector = { x: 0, y: 0, mag: 0, thumbX: 0, thumbY: 0 };
    const update = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      stickVector(r.left + r.width / 2, r.top + r.height / 2, e.clientX, e.clientY, (STICK_PX * scale) / 2, v);
      thumb.style.transform = `translate(${v.thumbX}px, ${v.thumbY}px)`;
      setStick(hub.touch, which, v.x, v.y);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      held.delete(e.pointerId);
      thumb.style.transform = '';
      el.classList.remove('pressed');
      setStick(hub.touch, which, 0, 0);
      sync();
    };
    el.addEventListener('pointerdown', (e) => {
      if (id !== -1) return;
      e.preventDefault();
      id = e.pointerId;
      held.add(id);
      el.setPointerCapture(id);
      el.classList.add('pressed');
      sync();
      update(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === id) update(e);
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) el.addEventListener(t, end);
    return el;
  };

  // ---- button ----------------------------------------------------------------------------------
  const makeButton = (b: PadButton, label: string, title: string): HTMLElement => {
    const el = h(
      'button',
      { class: `tc-btn tc-btn-${b}`, type: 'button', title, 'aria-label': title, dataset: { btn: b } },
      label,
    );
    let id = -1;
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      held.delete(e.pointerId);
      el.classList.remove('pressed');
      setPadButton(hub.touch, b, false);
      sync();
    };
    el.addEventListener('pointerdown', (e) => {
      if (id !== -1) return;
      e.preventDefault();
      id = e.pointerId;
      held.add(id);
      el.setPointerCapture(id);
      el.classList.add('pressed');
      setPadButton(hub.touch, b, true);
      sync();
      navigator.vibrate?.(8);
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) el.addEventListener(t, end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return el;
  };

  // ---- layout ----------------------------------------------------------------------------------
  const build = (cfg: TouchSettings) => {
    releaseAll();
    root.style.setProperty('--tc-s', String(cfg.size));
    root.style.setProperty('--tc-o', String(cfg.opacity));
    const zone = (logical: 'left' | 'right'): HTMLElement => {
      const stickId: StickId = logical === 'left' ? 'L' : 'R';
      const showStick = cfg.sticks === 'both' || cfg.sticks === logical;
      const btns = TOUCH_BUTTON_CHOICES.filter((c) => c.side === logical && cfg.buttons.includes(c.id));
      const screenSide = (logical === 'left') !== cfg.leftHanded ? 'left' : 'right';
      return h(
        'div',
        { class: `tc-zone tc-zone-${screenSide}`, dataset: { zone: logical } },
        btns.length
          ? h(
              'div',
              { class: 'tc-btns' },
              btns.map((c) => makeButton(c.id, c.label, `${c.title} · ${padLabel(c.id)}`)),
            )
          : null,
        showStick ? makeStick(stickId, cfg.size) : null,
      );
    };
    root.replaceChildren(zone('left'), zone('right'));
  };

  let builtFor = '';
  let shown = false;
  const refresh = () => {
    const s = hub.settings;
    const wanted = s.touchControls === 'on' || (s.touchControls === 'auto' && isTouchDevice() && app.sim.active);
    const key = JSON.stringify(s.touch);
    if (key !== builtFor) {
      builtFor = key;
      build(s.touch);
    }
    if (wanted !== shown) {
      shown = wanted;
      if (!wanted) releaseAll();
      root.hidden = !wanted;
      app.shell.stage.classList.toggle('has-touch-controls', wanted);
    }
  };

  const offs = [
    app.prefs.on('change', (k) => {
      if (k.includes('input')) refresh();
    }),
    app.sim.on('mode', refresh),
  ];
  const onBlur = () => releaseAll();
  const onVis = () => {
    if (document.hidden) releaseAll();
  };
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVis);
  let mq: MediaQueryList | null = null;
  try {
    mq = window.matchMedia('(pointer: coarse)');
    mq.addEventListener('change', refresh);
  } catch {
    mq = null;
  }
  refresh();

  return {
    el: root,
    get visible() {
      return shown;
    },
    dispose() {
      for (const o of offs) o();
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
      mq?.removeEventListener('change', refresh);
      releaseAll();
      root.remove();
    },
  };
}

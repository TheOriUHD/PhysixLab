/**
 * UI-40: the spotlight tour engine — a small, documented API (see "How to add a guided tour" in docs/EXTENDING.md).
 *
 *   registerTour({ id, title, steps })   define a tour; it gets a `help.tour.<id>` command (palette, Help menu)
 *   startTour(id, app)                   play it; one tour at a time (starting another stops the first)
 *   stopTour()                           close the running tour (counts as "skipped" only when the user did it)
 *   isTourRunning() / runningTourId()    state
 *   onTourChange(fn)                     notified when a tour starts / moves / ends
 *
 * A tour is a list of steps. A step names a `target` (CSS selector, a function that finds the element, or `null`
 * for a centred card), a title and a body, and optionally something to wait for (`waitFor` = a user action, or
 * `until` = a predicate polled a few times a second). The engine dims everything but the target, shows a card
 * with the step counter and Back / Next / Skip, repositions on resize and scroll, and never traps the user:
 * Esc always closes it and a missing target simply shows the card in the middle of the screen.
 */
import type { App } from '../../app/app';
import { registerCommand } from '../../app/registry/commands';
import { registerMenuEntry } from '../../app/registry/menus';
import { h } from '../dom';
import { icon } from '../icons';
import { guide, richText } from './guide';
import { observeSignals } from './signals';
import {
  computePlacement,
  padRect,
  TourMachine,
  waitSatisfied,
  type Placement,
  type Rect,
  type WaitSpec,
} from './tourLogic';

export type { Placement, WaitSpec } from './tourLogic';

export interface TourStep {
  /** What to spotlight: a CSS selector, a function returning the element (or null), or `null` for a centred card. */
  target: string | (() => HTMLElement | null) | null;
  title: string;
  /** Plain text (`[[Ctrl+K]]` = key cap, `**bold**`), or a DOM node you built. Never raw HTML. */
  body: string | Node;
  /** Which side of the target the card goes (default `'auto'`: where there is most room). */
  placement?: Placement | 'auto';
  /** Advance by itself when the user does this. "Skip step" stays available, so a tour can never get stuck. */
  waitFor?: WaitSpec;
  /** Advance by itself when this returns true (polled ~8×/s) — for things no event announces. */
  until?: (app: App) => boolean;
  /** Runs when the step is shown (open the right panel tab …). */
  onEnter?: (app: App) => void;
  /** Runs when the step is left in any way. */
  onExit?: (app: App) => void;
  /** Let clicks reach the app although the step waits for nothing (e.g. "try the camera"). Steps that wait always can. */
  allowInteraction?: boolean;
  /** Extra space around the spotlight in px (default 6). */
  padding?: number;
}

export interface TourDef {
  /** Unique, like command ids: lowercase, words joined by `.` `-` `_`. */
  id: string;
  title: string;
  steps: readonly TourStep[];
  /** Label of the Help-menu entry / palette command (default `Take the tour: <title>`). */
  menuLabel?: string;
  /** Called once when the tour ends: finished (`completed`) or closed early (`skipped`). */
  onEnd?: (app: App, how: 'completed' | 'skipped') => void;
}

const ID_RE = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;
const tours = new Map<string, TourDef>();
let runner: Runner | null = null;
const changeListeners = new Set<() => void>();

export function registerTour(def: TourDef): () => void {
  if (!ID_RE.test(def.id)) throw new Error(`Invalid tour id "${def.id}" (lowercase, words joined by "." "-" or "_")`);
  if (tours.has(def.id)) throw new Error(`The tour "${def.id}" is already registered`);
  if (!def.title.trim()) throw new Error(`tour "${def.id}" needs a title`);
  if (!def.steps.length) throw new Error(`tour "${def.id}" needs at least one step`);
  def.steps.forEach((s, i) => {
    if (!s.title.trim()) throw new Error(`tour "${def.id}": step ${i + 1} needs a title`);
  });
  tours.set(def.id, def);
  const label = def.menuLabel ?? `Take the tour: ${def.title}`;
  const cmdId = `help.tour.${def.id}`;
  const offs = [
    registerCommand({
      id: cmdId,
      label,
      category: 'Help',
      icon: 'info',
      description: `A guided walk-through: ${def.title}`,
      keywords: ['tour', 'tutorial', 'guide', 'walkthrough', 'help', 'intro', 'learn', def.title],
      run: ({ app }) => {
        startTour(def.id, app);
      },
    }),
    registerMenuEntry({
      id: `menu.help.tour.${def.id}`,
      menu: 'help',
      group: 'help',
      order: 108 + tours.size / 100,
      command: cmdId,
      icon: 'info',
    }),
  ];
  return () => {
    if (runner?.def === def) stopTour();
    tours.delete(def.id);
    for (const off of offs) off();
  };
}

export const getTour = (id: string): TourDef | undefined => tours.get(id);
export const listTours = (): readonly TourDef[] => [...tours.values()];
export const isTourRunning = (): boolean => runner !== null;
export const runningTourId = (): string | null => runner?.def.id ?? null;

export function onTourChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
const notify = () => changeListeners.forEach((fn) => fn());

/** Play a tour from its first step. Returns false (and says why in a toast) if it does not exist. */
export function startTour(id: string, app: App): boolean {
  const def = tours.get(id);
  if (!def) {
    app.toast(`There is no tour called “${id}”.`, 'warn');
    return false;
  }
  runner?.end('stopped');
  runner = new Runner(def, app);
  runner.begin();
  notify();
  return true;
}

/** Close the running tour (nothing is remembered about it; use Skip / Esc for "the user declined"). */
export function stopTour(): void {
  runner?.end('stopped');
}

// ── the runner ────────────────────────────────────────────────────────────────────────────────

type EndHow = 'completed' | 'skipped' | 'stopped';

class Runner {
  readonly machine: TourMachine;
  private readonly layer: HTMLElement;
  private readonly dims: HTMLElement[] = [];
  private readonly ring: HTMLElement;
  private readonly card: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly waitNote: HTMLElement;
  private readonly live: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly dots: HTMLElement;
  private cleanups: (() => void)[] = [];
  private stepCleanups: (() => void)[] = [];
  private entered = -1;
  private token = 0;
  private target: HTMLElement | null = null;
  private lastKey = '';
  private resizeObs: ResizeObserver | null = null;
  private returnFocus: Element | null = null;
  private ended = false;

  constructor(
    readonly def: TourDef,
    private readonly app: App,
  ) {
    this.machine = new TourMachine(def.steps.length);
    for (let i = 0; i < 4; i++) this.dims.push(h('div', { class: 'tour-dim' }));
    this.ring = h('div', { class: 'tour-ring' });
    this.counter = h('span', { class: 'tour-counter' });
    this.titleEl = h('h3', { class: 'tour-title', id: 'tour-title' });
    this.bodyEl = h('div', { class: 'tour-body', id: 'tour-body' });
    this.waitNote = h('div', { class: 'tour-wait' });
    this.dots = h('div', { class: 'tour-dots', 'aria-hidden': 'true' });
    for (let i = 0; i < def.steps.length; i++) this.dots.appendChild(h('i'));
    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const close = h(
      'button',
      { class: 'icon-btn tour-close', type: 'button', title: 'Close the tour (Esc)', 'aria-label': 'Close the tour' },
      icon('close'),
    );
    close.addEventListener('click', () => this.end('skipped'));
    const skip = h(
      'button',
      { class: 'btn ghost tour-skip', type: 'button', title: 'Close the tour (Esc)' },
      'Skip tour',
    );
    skip.addEventListener('click', () => this.end('skipped'));
    this.backBtn = h('button', { class: 'btn', type: 'button' }, 'Back');
    this.backBtn.addEventListener('click', () => this.go(-1));
    this.nextBtn = h('button', { class: 'btn primary tour-next', type: 'button' }, 'Next');
    this.nextBtn.addEventListener('click', () => this.go(1));
    this.card = h(
      'div',
      {
        class: 'tour-card',
        role: 'dialog',
        'aria-modal': 'false',
        'aria-labelledby': 'tour-title',
        'aria-describedby': 'tour-body',
        tabindex: '-1',
      },
      h('div', { class: 'tour-head' }, this.counter, this.dots, close),
      this.titleEl,
      this.bodyEl,
      this.waitNote,
      h('div', { class: 'tour-foot' }, skip, h('span', { class: 'grow' }), this.backBtn, this.nextBtn),
    );
    this.layer = h('div', { class: 'tour-layer' }, ...this.dims, this.ring, this.card, this.live);
  }

  begin(): void {
    this.returnFocus = document.activeElement;
    document.body.appendChild(this.layer);
    // The element clicked last, for function targets with `waitFor: { event: 'click' }` (this runs before the signal).
    const onClick = (e: MouseEvent) => this.noteClick(e);
    document.addEventListener('click', onClick, true);
    this.cleanups.push(() => document.removeEventListener('click', onClick, true));
    this.machine.start();
    const relayout = () => this.layout();
    window.addEventListener('resize', relayout);
    document.addEventListener('scroll', relayout, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Esc belongs to a dialog / the palette while one is open on top of the tour.
      if (document.querySelector('.modal-back, .palette-back')) return;
      e.preventDefault();
      e.stopPropagation();
      this.end('skipped');
    };
    window.addEventListener('keydown', onKey, true);
    const timer = window.setInterval(relayout, 250);
    this.cleanups.push(
      () => window.removeEventListener('resize', relayout),
      () => document.removeEventListener('scroll', relayout, true),
      () => window.removeEventListener('keydown', onKey, true),
      () => window.clearInterval(timer),
    );
    this.show();
  }

  private go(delta: 1 | -1): void {
    if (this.ended) return;
    if (delta > 0) {
      if (!this.machine.next()) {
        this.end('completed');
        return;
      }
    } else if (!this.machine.back()) return;
    this.show();
  }

  private get step(): TourStep {
    return this.def.steps[this.machine.index];
  }

  private leaveStep(): void {
    this.token++;
    for (const off of this.stepCleanups.splice(0)) off();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    if (this.entered >= 0) {
      const prev = this.def.steps[this.entered];
      try {
        prev?.onExit?.(this.app);
      } catch (e) {
        console.error(`[tour ${this.def.id}] onExit`, e);
      }
    }
    this.entered = -1;
  }

  /** Show the step the machine is on. */
  private show(): void {
    this.leaveStep();
    const step = this.step;
    const token = this.token;
    this.entered = this.machine.index;
    try {
      step.onEnter?.(this.app);
    } catch (e) {
      console.error(`[tour ${this.def.id}] onEnter`, e);
    }

    const waits = !!(step.waitFor || step.until);
    this.counter.textContent = this.machine.label;
    [...this.dots.children].forEach((d, i) => {
      d.className = i === this.machine.index ? 'on' : i < this.machine.index ? 'done' : '';
    });
    this.titleEl.textContent = step.title;
    this.bodyEl.replaceChildren(richText(step.body));
    this.backBtn.hidden = this.machine.isFirst;
    this.nextBtn.textContent = this.machine.isLast ? 'Done' : waits ? 'Skip step' : 'Next';
    this.nextBtn.classList.toggle('primary', !waits);
    this.nextBtn.title = waits ? 'Do it yourself, or skip this step' : '';
    this.waitNote.textContent = waits ? 'Try it now — the tour moves on when you do.' : '';
    this.waitNote.hidden = !waits;
    this.live.textContent = `${this.machine.label}: ${step.title}. ${this.bodyEl.textContent ?? ''}`;
    this.layer.classList.toggle('interactive', waits || !!step.allowInteraction);
    this.lastKey = '';

    // Look for the target now and keep looking (a tab or panel may need a moment to appear).
    this.target = null;
    this.resolveTarget(true);
    this.layout();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.layout());
      this.resizeObs.observe(document.body);
      if (this.target) this.resizeObs.observe(this.target);
    }

    // Wait for the user.
    if (step.waitFor) {
      const spec = step.waitFor;
      const fnTarget = typeof step.target === 'function' ? step.target : null;
      const sel = typeof step.target === 'string' ? step.target : undefined;
      this.stepCleanups.push(
        observeSignals(this.app, (signal) => {
          if (token !== this.token) return;
          let ok = waitSatisfied(spec, signal, sel);
          if (ok && spec.event === 'click' && !spec.selector && !sel && fnTarget) {
            const el = fnTarget();
            ok = !!el && this.clickedInside(el);
          }
          if (ok) this.advanceSoon(token);
        }),
      );
    }
    if (step.until) {
      const until = step.until;
      const t = window.setInterval(() => {
        if (token !== this.token) return;
        let ok = false;
        try {
          ok = until(this.app);
        } catch (e) {
          console.error(`[tour ${this.def.id}] until`, e);
        }
        if (ok) this.advanceSoon(token);
      }, 120);
      this.stepCleanups.push(() => window.clearInterval(t));
    }

    // Focus: a step that waits for the app keeps the keyboard where it is, other steps put it on "Next".
    if (!waits) this.nextBtn.focus({ preventScroll: true });
    else if (this.card.contains(document.activeElement)) this.card.focus({ preventScroll: true });
  }

  private advancing = -1;
  private lastClick: Element | null = null;
  private clickedInside(el: HTMLElement): boolean {
    return !!this.lastClick && el.contains(this.lastClick);
  }

  /** Let the user see the result of what they just did for a moment, then move on. */
  private advanceSoon(token: number): void {
    if (this.advancing === token) return; // only the first success counts
    this.advancing = token;
    const t = window.setTimeout(() => {
      if (token === this.token && !this.ended) this.go(1);
    }, 450);
    this.stepCleanups.push(() => window.clearTimeout(t));
  }

  private resolveTarget(scroll = false): void {
    const t = this.step.target;
    let el: HTMLElement | null = null;
    try {
      if (typeof t === 'string') el = document.querySelector<HTMLElement>(t);
      else if (typeof t === 'function') el = t();
    } catch {
      el = null; // a malformed selector is a missing target, not a crash
    }
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) el = null;
    }
    if (el && el !== this.target) {
      if (scroll || this.target === null) {
        try {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch {
          /* old browser */
        }
      }
      this.resizeObs?.observe(el);
    }
    this.target = el;
  }

  /** Position the dimmed backdrop, the ring and the card. Cheap and idempotent: it runs on resize / scroll / a timer. */
  private layout(): void {
    if (this.ended) return;
    if (this.step.target !== null) this.resolveTarget();
    const W = window.innerWidth;
    const H = window.innerHeight;
    const interactive = this.layer.classList.contains('interactive');
    const wantsTarget = this.step.target !== null;
    let hole: Rect | null = null;
    if (this.target) {
      const r = this.target.getBoundingClientRect();
      const p = padRect({ x: r.left, y: r.top, w: r.width, h: r.height }, this.step.padding ?? 6);
      const x0 = Math.max(0, p.x),
        y0 = Math.max(0, p.y),
        x1 = Math.min(W, p.x + p.w),
        y1 = Math.min(H, p.y + p.h);
      if (x1 > x0 && y1 > y0) hole = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    const centred = !hole;
    // A step with no target that waits for the user gets no dimming at all (e.g. while the palette is open).
    const noDim = centred && interactive;
    const cardBox = this.card.getBoundingClientRect();
    const place = noDim
      ? computePlacement({ x: 0, y: H, w: W, h: 0 }, { w: cardBox.width, h: cardBox.height }, { w: W, h: H }, 'top', 24)
      : computePlacement(hole, { w: cardBox.width, h: cardBox.height }, { w: W, h: H }, this.step.placement ?? 'auto');
    const key = [
      hole ? `${hole.x},${hole.y},${hole.w},${hole.h}` : 'none',
      W,
      H,
      noDim,
      place.x,
      place.y,
      cardBox.height,
    ].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const rects: Rect[] = hole
      ? [
          { x: 0, y: 0, w: W, h: hole.y },
          { x: 0, y: hole.y + hole.h, w: W, h: H - hole.y - hole.h },
          { x: 0, y: hole.y, w: hole.x, h: hole.h },
          { x: hole.x + hole.w, y: hole.y, w: W - hole.x - hole.w, h: hole.h },
        ]
      : [
          { x: 0, y: 0, w: W, h: H },
          { x: 0, y: 0, w: 0, h: 0 },
          { x: 0, y: 0, w: 0, h: 0 },
          { x: 0, y: 0, w: 0, h: 0 },
        ];
    this.dims.forEach((d, i) => {
      const r = rects[i];
      d.style.cssText = `left:${r.x}px;top:${r.y}px;width:${Math.max(0, r.w)}px;height:${Math.max(0, r.h)}px;${noDim ? 'display:none' : ''}`;
    });
    if (hole) {
      this.ring.style.cssText = `left:${hole.x}px;top:${hole.y}px;width:${hole.w}px;height:${hole.h}px`;
    }
    this.ring.hidden = !hole;
    this.card.style.left = `${place.x}px`;
    this.card.style.top = `${place.y}px`;
    this.card.dataset.placement = wantsTarget && centred ? 'missing' : place.placement;
  }

  end(how: EndHow): void {
    if (this.ended) return;
    this.ended = true;
    this.leaveStep();
    for (const off of this.cleanups.splice(0)) off();
    this.layer.remove();
    if (runner === this) runner = null;
    if (how === 'completed') guide.markCompleted(this.def.id);
    else if (how === 'skipped') guide.markDismissed(this.def.id);
    const back = this.returnFocus;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) {
      try {
        back.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
    if (how !== 'stopped') {
      try {
        this.def.onEnd?.(this.app, how);
      } catch (e) {
        console.error(`[tour ${this.def.id}] onEnd`, e);
      }
    }
    notify();
  }

  /** Remember the last clicked element (for function targets with `waitFor: { event: 'click' }`). */
  noteClick(e: MouseEvent): void {
    this.lastClick = e.target instanceof Element ? e.target : null;
  }
}

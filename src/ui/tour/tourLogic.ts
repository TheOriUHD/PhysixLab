/**
 * UI-40: the DOM-free half of the guided-tour system — the step state machine, the "what is this step waiting for"
 * matching, card placement maths, and the persistence of what the user has already seen (tours finished, hints
 * shown, tip position). Nothing here touches `document`, so all of it is unit-tested in Node (tests/tour.test.ts).
 */

// ── what a step can wait for ──────────────────────────────────────────────────────────────────

/** A user action a step (or a context hint) can wait for. */
export type WaitSpec =
  /** A click on an element matching `selector` (default: the step's own target). */
  | { event: 'click'; selector?: string }
  /** A command ran (any, or the given id(s)): `{ event: 'command', id: 'edit.undo' }`. */
  | { event: 'command'; id?: string | readonly string[] }
  /** The selection changed (to anything, or to at least `min` objects). */
  | { event: 'selection'; min?: number }
  /** The simulation changed mode (to anything, or to `mode`). */
  | { event: 'sim-mode'; mode?: 'edit' | 'running' | 'paused' }
  /** The scene document changed: objects added / removed / updated (any, or the given kind of change). */
  | { event: 'scene-change'; type?: 'add' | 'remove' | 'update' | 'reset' };

/** What actually happened — the engine turns app events into these and asks `waitSatisfied`. */
export type WaitSignal =
  | { event: 'click'; matches: (selector: string) => boolean }
  | { event: 'command'; id: string }
  | { event: 'selection'; count: number }
  | { event: 'sim-mode'; mode: string }
  | { event: 'scene-change'; type: string };

export function waitSatisfied(spec: WaitSpec, signal: WaitSignal, defaultSelector?: string): boolean {
  if (spec.event !== signal.event) return false;
  switch (spec.event) {
    case 'click': {
      const sel = spec.selector ?? defaultSelector;
      return sel ? (signal as Extract<WaitSignal, { event: 'click' }>).matches(sel) : true;
    }
    case 'command': {
      if (spec.id === undefined) return true;
      const ids = typeof spec.id === 'string' ? [spec.id] : spec.id;
      return ids.includes((signal as Extract<WaitSignal, { event: 'command' }>).id);
    }
    case 'selection':
      return (signal as Extract<WaitSignal, { event: 'selection' }>).count >= (spec.min ?? 1);
    case 'sim-mode':
      return spec.mode === undefined || spec.mode === (signal as Extract<WaitSignal, { event: 'sim-mode' }>).mode;
    case 'scene-change':
      return spec.type === undefined || spec.type === (signal as Extract<WaitSignal, { event: 'scene-change' }>).type;
  }
}

// ── step state machine ────────────────────────────────────────────────────────────────────────

export type TourStatus = 'idle' | 'running' | 'completed' | 'skipped';

/** Why a tour ended. `completed` = the last step was finished; `skipped` = Skip / Esc / stopTour(). */
export type TourEnd = 'completed' | 'skipped';

/**
 * Index bookkeeping for a tour of `count` steps. Pure: the engine owns the DOM and calls this for the numbers.
 * `next()` on the last step finishes the tour; `back()` on the first step does nothing.
 */
export class TourMachine {
  status: TourStatus = 'idle';
  index = 0;

  constructor(readonly count: number) {
    if (!Number.isInteger(count) || count < 1) throw new Error('a tour needs at least one step');
  }

  start(): void {
    this.status = 'running';
    this.index = 0;
  }

  get isRunning(): boolean {
    return this.status === 'running';
  }
  get isFirst(): boolean {
    return this.index === 0;
  }
  get isLast(): boolean {
    return this.index === this.count - 1;
  }
  /** "Step 2 of 7". */
  get label(): string {
    return `Step ${this.index + 1} of ${this.count}`;
  }

  /** Advance. Returns true if the tour moved to another step, false if it just finished (or was not running). */
  next(): boolean {
    if (!this.isRunning) return false;
    if (this.isLast) {
      this.status = 'completed';
      return false;
    }
    this.index++;
    return true;
  }

  back(): boolean {
    if (!this.isRunning || this.isFirst) return false;
    this.index--;
    return true;
  }

  skip(): void {
    if (this.isRunning) this.status = 'skipped';
  }
}

// ── placement maths ───────────────────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'center';
export interface PlacementResult {
  /** Top-left corner of the card. */
  x: number;
  y: number;
  placement: Placement;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Grow a rect by `pad` on every side. */
export const padRect = (r: Rect, pad: number): Rect => ({
  x: r.x - pad,
  y: r.y - pad,
  w: r.w + 2 * pad,
  h: r.h + 2 * pad,
});

/**
 * Where to put a `card`-sized box next to `target` inside `view` (0,0,w,h). Tries the preferred side first
 * (`'auto'` = the side with the most room), then the others; if the card fits on no side (a huge target, e.g. the
 * whole viewport) it is docked inside the target's bottom edge, and without a target it is centred.
 * The result is always clamped fully inside the view with `margin` to spare.
 */
export function computePlacement(
  target: Rect | null,
  card: { w: number; h: number },
  view: { w: number; h: number },
  pref: Placement | 'auto' = 'auto',
  gap = 14,
  margin = 12,
): PlacementResult {
  const fit = (x: number, y: number) => ({
    x: clamp(x, margin, Math.max(margin, view.w - card.w - margin)),
    y: clamp(y, margin, Math.max(margin, view.h - card.h - margin)),
  });
  if (!target || pref === 'center') {
    return { ...fit((view.w - card.w) / 2, (view.h - card.h) / 2), placement: 'center' };
  }
  const room = {
    top: target.y - gap - margin,
    bottom: view.h - (target.y + target.h) - gap - margin,
    left: target.x - gap - margin,
    right: view.w - (target.x + target.w) - gap - margin,
  };
  const need = { top: card.h, bottom: card.h, left: card.w, right: card.w };
  const sides: ('top' | 'bottom' | 'left' | 'right')[] = ['bottom', 'right', 'left', 'top'];
  const order =
    pref === 'auto'
      ? [...sides].sort((a, b) => room[b] - need[b] - (room[a] - need[a]))
      : [pref, ...sides.filter((s) => s !== pref)];
  const cx = target.x + target.w / 2 - card.w / 2;
  const cy = target.y + target.h / 2 - card.h / 2;
  for (const side of order) {
    if (room[side] < need[side]) continue;
    const p =
      side === 'top'
        ? fit(cx, target.y - gap - card.h)
        : side === 'bottom'
          ? fit(cx, target.y + target.h + gap)
          : side === 'left'
            ? fit(target.x - gap - card.w, cy)
            : fit(target.x + target.w + gap, cy);
    return { ...p, placement: side };
  }
  // No side has room: sit inside the target, near its bottom.
  return { ...fit(cx, target.y + target.h - card.h - gap), placement: 'bottom' };
}

// ── persistence ───────────────────────────────────────────────────────────────────────────────

/** The subset of `Storage` the guide uses (so tests can pass a plain object). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const GUIDE_STORAGE_KEY = 'physicslab.guide.v1';

export interface GuideState {
  /** Tours that were played to the end. */
  completed: string[];
  /** Tours the user skipped / declined (the first-run offer is not repeated for these). */
  dismissed: string[];
  /** Context hints already shown. */
  hintsSeen: string[];
  /** Global switch for context hints. */
  hintsOn: boolean;
  /** Global switch for the tip of the day. */
  tipsOn: boolean;
  /** Index of the next tip to show. */
  tipIndex: number;
  /** Local date (YYYY-MM-DD) a tip was last shown automatically. */
  tipDay: string;
}

export const defaultGuideState = (): GuideState => ({
  completed: [],
  dismissed: [],
  hintsSeen: [],
  hintsOn: true,
  tipsOn: true,
  tipIndex: 0,
  tipDay: '',
});

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))].slice(0, 500) : [];

/** Parse whatever is stored; anything malformed falls back to the defaults field by field. */
export function sanitizeGuideState(raw: unknown): GuideState {
  const d = defaultGuideState();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  return {
    completed: strings(r.completed),
    dismissed: strings(r.dismissed),
    hintsSeen: strings(r.hintsSeen),
    hintsOn: typeof r.hintsOn === 'boolean' ? r.hintsOn : d.hintsOn,
    tipsOn: typeof r.tipsOn === 'boolean' ? r.tipsOn : d.tipsOn,
    tipIndex: typeof r.tipIndex === 'number' && Number.isFinite(r.tipIndex) ? Math.max(0, Math.floor(r.tipIndex)) : 0,
    tipDay: typeof r.tipDay === 'string' ? r.tipDay.slice(0, 10) : '',
  };
}

/** What the user has already been shown, kept in localStorage under its own key. Every access is guarded. */
export class GuideStore {
  state: GuideState;

  constructor(private readonly storage: KeyValueStore | null) {
    this.state = this.read();
  }

  private read(): GuideState {
    try {
      const text = this.storage?.getItem(GUIDE_STORAGE_KEY);
      return sanitizeGuideState(text ? JSON.parse(text) : null);
    } catch {
      return defaultGuideState();
    }
  }

  private write(): void {
    try {
      this.storage?.setItem(GUIDE_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* private window / quota: the guide simply does not remember */
    }
  }

  isCompleted(tourId: string): boolean {
    return this.state.completed.includes(tourId);
  }
  /** Finished or declined: do not offer it again on its own. */
  isResolved(tourId: string): boolean {
    return this.isCompleted(tourId) || this.state.dismissed.includes(tourId);
  }
  markCompleted(tourId: string): void {
    if (!this.isCompleted(tourId)) this.state.completed.push(tourId);
    this.write();
  }
  markDismissed(tourId: string): void {
    if (!this.state.dismissed.includes(tourId)) this.state.dismissed.push(tourId);
    this.write();
  }
  resetTour(tourId: string): void {
    this.state.completed = this.state.completed.filter((t) => t !== tourId);
    this.state.dismissed = this.state.dismissed.filter((t) => t !== tourId);
    this.write();
  }

  hasSeenHint(id: string): boolean {
    return this.state.hintsSeen.includes(id);
  }
  markHintSeen(id: string): void {
    if (!this.hasSeenHint(id)) this.state.hintsSeen.push(id);
    this.write();
  }
  setHintsOn(on: boolean): void {
    this.state.hintsOn = on;
    this.write();
  }
  setTipsOn(on: boolean): void {
    this.state.tipsOn = on;
    this.write();
  }
  /** Forget everything (Settings → "Show all hints and tips again"). */
  resetAll(): void {
    this.state = defaultGuideState();
    this.write();
  }

  /** The tip to show now; moves on to the next one. `count` is the number of tips available. */
  takeTip(count: number, day = ''): number {
    const i = count > 0 ? this.state.tipIndex % count : 0;
    this.state.tipIndex = i + 1;
    if (day) this.state.tipDay = day;
    this.write();
    return i;
  }
  /** Is it time for the automatic tip of the day? At most one per calendar day. */
  tipDue(day: string): boolean {
    return this.state.tipsOn && this.state.tipDay !== day;
  }
}

/** Local calendar date as YYYY-MM-DD. */
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

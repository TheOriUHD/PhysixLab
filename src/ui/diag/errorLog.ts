/** Error bookkeeping for the error boundary (DOM-free): a bounded log of recent errors and a rate limiter. */

export interface LogEntry {
  /** Milliseconds since the page started (performance.now()). */
  t: number;
  kind: 'error' | 'rejection' | 'console' | 'boot';
  message: string;
  stack?: string;
  /** file:line:col when the browser gave it. */
  source?: string;
}

/** The last `max` entries, oldest first. Allocation happens only when something goes wrong, never per frame. */
export class ErrorLog {
  private entries: LogEntry[] = [];
  /** How many entries were ever pushed (the log itself is bounded). */
  total = 0;

  constructor(readonly max = 20) {}

  push(e: LogEntry): void {
    this.total++;
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
  }

  recent(n = this.max): LogEntry[] {
    return this.entries.slice(-n);
  }

  clear(): void {
    this.entries = [];
    this.total = 0;
  }
}

/** Message and stack of anything that was thrown or rejected. */
export function describeError(x: unknown): { message: string; stack?: string } {
  if (x instanceof Error) return { message: x.message || x.name, stack: x.stack };
  if (typeof x === 'string') return { message: x };
  if (x && typeof x === 'object') {
    const m = (x as { message?: unknown }).message;
    if (typeof m === 'string') return { message: m };
    try {
      return { message: JSON.stringify(x).slice(0, 300) };
    } catch {
      /* fall through */
    }
  }
  return { message: String(x) };
}

/** Errors that are noise, not bugs: the browser's own resize-observer notice and scripts of browser extensions. */
export function isIgnorableError(message: string, source?: string): boolean {
  if (/ResizeObserver loop/i.test(message)) return true;
  if (source && /^(chrome|moz|safari-web)-extension:/i.test(source)) return true;
  return false;
}

export type GateDecision =
  /** Show the recovery card now. */
  | 'card'
  /** The card is already open: just update its counter. */
  | 'count'
  /** Recently handled: show one short toast. */
  | 'toast'
  /** Recently handled and a toast was shown a moment ago: stay quiet (the error is still logged and counted). */
  | 'quiet';

export interface GateOptions {
  /** After a card was dismissed, the next card waits this long (default 15 s). */
  cardCooldownMs?: number;
  /** Minimum time between two toasts (default 5 s). */
  toastCooldownMs?: number;
  /** An "error loop" is this many errors within `loopWindowMs` (defaults 5 in 10 s). */
  loopCount?: number;
  loopWindowMs?: number;
}

/**
 * Decides what an uncaught error does to the screen, so a runaway error loop (an exception inside a frame callback
 * fires 60 times a second) shows one card and a counter instead of thousands of cards and toasts.
 */
export class ErrorGate {
  private open = false;
  private lastCard = -Infinity;
  private lastToast = -Infinity;
  private recentTimes: number[] = [];
  /** Errors since the card was last opened. */
  suppressed = 0;
  private readonly o: Required<GateOptions>;

  constructor(o: GateOptions = {}) {
    this.o = { cardCooldownMs: 15000, toastCooldownMs: 5000, loopCount: 5, loopWindowMs: 10000, ...o };
  }

  /** Report an error at time `now`; returns what to do. */
  report(now: number): GateDecision {
    this.recentTimes.push(now);
    if (this.recentTimes.length > 50) this.recentTimes.shift();
    if (this.open) {
      this.suppressed++;
      return 'count';
    }
    if (now - this.lastCard >= this.o.cardCooldownMs) {
      this.lastCard = now;
      this.open = true;
      this.suppressed = 0;
      return 'card';
    }
    this.suppressed++;
    if (now - this.lastToast >= this.o.toastCooldownMs) {
      this.lastToast = now;
      return 'toast';
    }
    return 'quiet';
  }

  /** The card was closed (dismissed or an action was taken). */
  closed(now: number): void {
    this.open = false;
    this.lastCard = now;
  }

  /** Are errors repeating right now (the card then says so and recommends reloading)? */
  looping(now: number): boolean {
    let n = 0;
    for (let i = this.recentTimes.length - 1; i >= 0 && now - this.recentTimes[i]! <= this.o.loopWindowMs; i--) n++;
    return n >= this.o.loopCount;
  }
}

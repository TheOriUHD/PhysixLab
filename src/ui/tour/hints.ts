/**
 * UI-40: context hints (a one-time card the first time the user does something) and the tip of the day.
 *
 *   registerHint({ id, text, trigger?, when? })   show `text` once, the first time `trigger` happens and `when` holds
 *
 * Hints and tips share one small card above the status bar; only one is on screen at a time, they wait while a tour
 * or a dialog is open, and each hint is remembered as seen (localStorage, see `guide.ts`). The user can switch hints
 * and tips off for good with the "Context hints" / "Tip of the day" settings (palette → Settings).
 */
import type { App } from '../../app/app';
import { h } from '../dom';
import { icon } from '../icons';
import { guide, guideQuiet, richText } from './guide';
import { isTourRunning } from './engine';
import { observeSignals } from './signals';
import { localDay, waitSatisfied, type WaitSpec } from './tourLogic';

export interface HintDef {
  /** Unique id; remembered once the hint was shown. */
  id: string;
  /** What to say (same light markup as tour bodies: `[[Ctrl+K]]`, `**bold**`). */
  text: string;
  /** The user action that makes the hint due. Without it the hint is checked about once a second via `when`. */
  trigger?: WaitSpec;
  /** An extra condition, checked when the trigger fires (or polled when there is no trigger). */
  when?: (app: App) => boolean;
  /** Wait this long after the trigger before showing (ms, default 600) so the action's own feedback comes first. */
  delayMs?: number;
}

const hints = new Map<string, HintDef>();

export function registerHint(def: HintDef): () => void {
  if (!/^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/.test(def.id)) throw new Error(`Invalid hint id "${def.id}"`);
  if (hints.has(def.id)) throw new Error(`The hint "${def.id}" is already registered`);
  if (!def.text.trim()) throw new Error(`hint "${def.id}" needs a text`);
  if (!def.trigger && !def.when) throw new Error(`hint "${def.id}" needs a trigger or a when()`);
  hints.set(def.id, def);
  return () => hints.delete(def.id);
}
export const listHints = (): readonly HintDef[] => [...hints.values()];

// ── the card ──────────────────────────────────────────────────────────────────────────────────

interface CardSpec {
  key: string;
  text: string;
  /** Extra buttons (left of "Got it"). */
  actions?: { label: string; run: () => void; keepOpen?: boolean }[];
  /** Label of the closing button (default "Got it"). */
  ok?: string;
  autoHideMs?: number;
  onClose?: () => void;
}

let cardEl: HTMLElement | null = null;
let cardTimer = 0;

export function closeGuideCard(): void {
  window.clearTimeout(cardTimer);
  const el = cardEl;
  cardEl = null;
  if (!el) return;
  el.classList.add('leaving');
  window.setTimeout(() => el.remove(), 260);
}

export function guideCardOpen(): boolean {
  return cardEl !== null;
}

/** Show the one guide card (replacing the current one). Not for direct use by features: register a hint instead. */
export function showGuideCard(spec: CardSpec): void {
  closeGuideCard();
  const done = () => {
    closeGuideCard();
    spec.onClose?.();
  };
  const btn = (label: string, cls: string, run: () => void) => {
    const b = h('button', { class: `btn ${cls}`, type: 'button' }, label);
    b.addEventListener('click', run);
    return b;
  };
  const actions = h(
    'div',
    { class: 'tour-hint-actions' },
    ...(spec.actions ?? []).map((a) =>
      btn(a.label, 'ghost', () => {
        if (!a.keepOpen) closeGuideCard();
        a.run();
      }),
    ),
    btn(spec.ok ?? 'Got it', 'primary', done),
  );
  const el = h(
    'div',
    { class: 'tour-hint', role: 'status', 'aria-live': 'polite', dataset: { key: spec.key } },
    h(
      'div',
      { class: 'tour-hint-row' },
      h('span', { class: 'tour-hint-ic' }, icon('sparkle')),
      h('div', { class: 'tour-hint-text' }, richText(spec.text)),
    ),
    actions,
  );
  document.body.appendChild(el);
  cardEl = el;
  if (spec.autoHideMs) {
    let hover = false;
    el.addEventListener('pointerenter', () => (hover = true));
    el.addEventListener('pointerleave', () => (hover = false));
    const tick = () => {
      if (cardEl !== el) return;
      if (hover || el.contains(document.activeElement)) cardTimer = window.setTimeout(tick, 1500);
      else done();
    };
    cardTimer = window.setTimeout(tick, spec.autoHideMs);
  }
}

// ── the queue ─────────────────────────────────────────────────────────────────────────────────

/** Something else owns the screen (tour, dialog, palette, menu): wait. */
const busy = () =>
  isTourRunning() ||
  guideCardOpen() ||
  !!document.querySelector('.modal-back, .palette-back, .menu, .tour-layer') ||
  document.hidden;

const queue: { key: string; show: () => void }[] = [];
let pumpTimer = 0;

function pump(): void {
  if (!queue.length) return;
  if (busy()) {
    pumpTimer = window.setTimeout(pump, 1200);
    return;
  }
  queue.shift()?.show();
  if (queue.length) pumpTimer = window.setTimeout(pump, 1200);
}
function enqueue(key: string, show: () => void): void {
  if (queue.some((q) => q.key === key)) return;
  queue.push({ key, show });
  window.clearTimeout(pumpTimer);
  pumpTimer = window.setTimeout(pump, 50);
}

// ── hints ─────────────────────────────────────────────────────────────────────────────────────

function dueHint(app: App, def: HintDef): void {
  if (!guide.state.hintsOn || guide.hasSeenHint(def.id)) return;
  try {
    if (def.when && !def.when(app)) return;
  } catch (e) {
    console.error(`[hint ${def.id}]`, e);
    return;
  }
  window.setTimeout(
    () => {
      // Re-check: the user may have switched hints off, or another path showed it, in the meantime.
      if (!guide.state.hintsOn || guide.hasSeenHint(def.id)) return;
      enqueue(`hint:${def.id}`, () => {
        if (!guide.state.hintsOn || guide.hasSeenHint(def.id)) return;
        guide.markHintSeen(def.id);
        showGuideCard({
          key: def.id,
          text: def.text,
          autoHideMs: 14000,
          actions: [
            {
              label: 'Turn hints off',
              run: () => {
                guide.setHintsOn(false);
                app.toast(
                  'Context hints are off. You can turn them back on in the command palette (Ctrl+K → “Context hints”).',
                );
              },
            },
          ],
        });
      });
    },
    Math.max(0, def.delayMs ?? 600),
  );
}

// ── tips ──────────────────────────────────────────────────────────────────────────────────────

export const TIPS: readonly string[] = [
  'Press [[Ctrl+K]] to search every command, setting and example scene.',
  'Right-drag orbits the camera, middle-drag pans and the wheel zooms. [[F]] frames the selection.',
  'Every edit is undoable: [[Ctrl+Z]] steps back, [[Ctrl+Shift+Z]] steps forward.',
  'While the simulation runs, drag any body with the mouse to push it around — great for testing a design.',
  'The number keys [[1]]–[[9]] pick a shape: a ghost follows the pointer and a click places it ([[Esc]] cancels).',
  'Press [[J]] for the joint tool, then click two bodies to connect them with a hinge, spring, slider and more.',
  'The Inspector on the right edits whatever is selected — mass, material, colour, size and components.',
  'Slow motion lives next to the clock in the top bar. Use it to watch a collision frame by frame.',
  '“Copy share link” in the File menu packs the whole scene into a URL you can send to a friend.',
  'Your work is autosaved in this browser. Use File → Export to keep a copy as a file.',
  'Press [[?]] for the full keyboard shortcut list.',
  'Shift-click adds to the selection; drag on empty space to box-select. Double-click frames the object under the pointer.',
];

export function showTip(app: App, auto: boolean): void {
  const i = guide.takeTip(TIPS.length, auto ? localDay() : '');
  const tip = TIPS[i % TIPS.length];
  showGuideCard({
    key: `tip:${i}`,
    text: `**Tip:** ${tip}`,
    ok: 'Got it',
    autoHideMs: auto ? 20000 : undefined,
    actions: [
      { label: 'Next tip', keepOpen: true, run: () => showTip(app, false) },
      {
        label: 'Don’t show tips',
        run: () => {
          guide.setTipsOn(false);
          app.toast('Tips are off. You can turn them back on in the command palette (Ctrl+K → “Tip of the day”).');
        },
      },
    ],
  });
}

/** Offer the first-run tour: a card that never blocks anything; declining is remembered. */
export function offerTour(tourId: string, text: string, start: () => void): void {
  showGuideCard({
    key: `offer:${tourId}`,
    text,
    ok: 'Show me around',
    actions: [
      {
        label: 'No thanks',
        run: () => guide.markDismissed(tourId),
      },
    ],
    onClose: start,
  });
}

// ── start-up ──────────────────────────────────────────────────────────────────────────────────

/** Begin watching for hint triggers and (when due) schedule the tip of the day. */
export function installHints(app: App, opts: { tipOfTheDay: boolean }): void {
  const quiet = guideQuiet();
  if (!quiet) {
    observeSignals(app, (signal) => {
      for (const def of hints.values()) if (def.trigger && waitSatisfied(def.trigger, signal)) dueHint(app, def);
    });
    // Hints without a trigger are conditions: look about once a second (cheap predicates only).
    window.setInterval(() => {
      if (!guide.state.hintsOn || busy()) return;
      for (const def of hints.values()) if (!def.trigger) dueHint(app, def);
    }, 1000);
  }
  if (!quiet && opts.tipOfTheDay && guide.tipDue(localDay())) {
    window.setTimeout(() => enqueue('tip', () => guide.tipDue(localDay()) && showTip(app, true)), 5000);
  }
}

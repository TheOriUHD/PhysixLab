/**
 * The status-bar tip registry (UI-44): short, useful sentences the status bar shows one at a time.
 *
 *   registerStatusTip({ id: 'tip.snap', text: 'Press G to toggle grid snapping' });
 *   registerStatusTip({ id: 'tip.select', text: 'Click an object…', when: (app) => !app.store.selection.length, priority: 10 });
 *
 * A tip without `when` is a general tip and rotates with the others. A tip with `when` only shows while the condition
 * holds; a higher `priority` shows sooner (contextual tips use 10): when the context changes the rotation restarts at the
 * highest priority tip that applies.
 * `text` may be a function of the app for tips that mention a shortcut ("Press Ctrl+K …" with the platform's keys).
 */
import { Registry } from '../../core/registry';
import type { App } from '../app';

export interface StatusTipDef {
  id: string;
  /** The sentence, or a function that builds it from the app (shortcut text, current state). */
  text: string | ((app: App) => string);
  /** Show only while this holds (a contextual tip). */
  when?: (app: App) => boolean;
  /** Higher shows first among the tips that apply (default 0; contextual tips usually use 10). */
  priority?: number;
  /** A short label shown in front of the sentence ("Tip" by default). */
  label?: string;
}

export const statusTipRegistry = new Registry<StatusTipDef>({
  kind: 'status tip',
  validate(t) {
    if (typeof t.text !== 'string' && typeof t.text !== 'function') throw new Error(`status tip "${t.id}" needs text`);
    if (typeof t.text === 'string' && !t.text.trim()) throw new Error(`status tip "${t.id}" needs text`);
  },
});

export const registerStatusTip = (def: StatusTipDef): (() => void) => statusTipRegistry.register(def);
export const listStatusTips = (): readonly StatusTipDef[] => statusTipRegistry.list();

/**
 * Pick the tip for rotation step `step` among `tips` (already filtered by `when`). They are ordered by priority (highest
 * first, registration order within equal priority) and `step` walks that list, so step 0 is always the most relevant
 * tip and the rotation then reaches the general ones. Returns undefined for an empty list. Pure, for tests.
 */
export function chooseTip<T extends { priority?: number }>(tips: readonly T[], step: number): T | undefined {
  if (!tips.length) return undefined;
  const ordered = tips.map((t, i) => ({ t, i })).sort((a, b) => (b.t.priority ?? 0) - (a.t.priority ?? 0) || a.i - b.i);
  return ordered[((step % ordered.length) + ordered.length) % ordered.length]!.t;
}

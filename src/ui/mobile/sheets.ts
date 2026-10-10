/** Pure rules of the mobile sheet layout (no DOM): which panels are remembered, which sheet wins. */

export type Sheet = 'left' | 'right' | 'bottom';
export const SHEETS: readonly Sheet[] = ['left', 'right', 'bottom'];

/** The three panel-visibility preferences. */
export interface Panels {
  showLeft: boolean;
  showRight: boolean;
  showBottom: boolean;
}

export const SHOW = { left: 'showLeft', right: 'showRight', bottom: 'showBottom' } as const;

export const NO_PANELS: Panels = { showLeft: false, showRight: false, showBottom: false };

/**
 * The window became narrow. The desktop arrangement to remember is the one already stashed (the preferences then hold
 * the closed sheets of an earlier narrow session), otherwise the current one; every panel closes.
 */
export function enterNarrow(current: Panels, stash: Panels | null): { stash: Panels; panels: Panels } {
  return { stash: stash ?? { ...current }, panels: { ...NO_PANELS } };
}

/** The window became wide again: the stashed arrangement comes back (null = nothing to restore, keep the preferences). */
export function leaveNarrow(stash: Panels | null): Panels | null {
  return stash ? { ...stash } : null;
}

/**
 * At most one sheet is open. Given the sheets open now and the ones open before, the sheet to keep is the one that was
 * just opened (the newest); null when zero or one sheet is open (nothing to do).
 */
export function sheetToKeep(open: readonly Sheet[], before: Record<Sheet, boolean>): Sheet | null {
  if (open.length <= 1) return null;
  return open.find((s) => !before[s]) ?? open[open.length - 1];
}

/** Coerce anything stored into a `Panels` (a missing field counts as shown, like the defaults). */
export function parsePanels(raw: unknown): Panels | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<Record<keyof Panels, unknown>>;
  return { showLeft: v.showLeft !== false, showRight: v.showRight !== false, showBottom: v.showBottom !== false };
}

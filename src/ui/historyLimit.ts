// -- ED-B: persisted undo-history limit (kept out of the shared preferences) --
const KEY = 'physixlab:historyLimit';
export const HISTORY_LIMIT_MIN = 10;
export const HISTORY_LIMIT_MAX = 1000;
export const HISTORY_LIMIT_DEFAULT = 200;

export const clampHistoryLimit = (n: number): number =>
  Number.isFinite(n) ? Math.max(HISTORY_LIMIT_MIN, Math.min(HISTORY_LIMIT_MAX, Math.round(n))) : HISTORY_LIMIT_DEFAULT;

export function loadHistoryLimit(): number {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? HISTORY_LIMIT_DEFAULT : clampHistoryLimit(Number(raw));
  } catch {
    return HISTORY_LIMIT_DEFAULT;
  }
}

export function saveHistoryLimit(n: number): number {
  const v = clampHistoryLimit(n);
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* storage unavailable: the choice lasts for this session only */
  }
  return v;
}

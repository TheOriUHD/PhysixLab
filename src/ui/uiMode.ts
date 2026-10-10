/**
 * Simple vs Advanced interface mode (UI-3).
 *
 * Simple hides the advanced inspector sections (components, logic, solver, collision layers, analysis …) and shows
 * friendlier labels; Advanced shows everything. The choice is per user (localStorage) and applied as a class on
 * `#app` (`ui-simple`), so hiding is pure CSS: a section is advanced when its `section()` id is registered with
 * `markAdvancedSection`, or when an inspector-section registration says `advanced: true`.
 */
type Listener = (advanced: boolean) => void;
export type UiMode = 'simple' | 'advanced';

const KEY = 'physixlab:uimode:v1';
const ASKED_KEY = 'physixlab:uimode:asked';
const listeners = new Set<Listener>();
const advancedIds = new Set<string>([
  'components',
  'logic',
  'solver',
  'collision',
  'collision-layers',
  'layers',
  'analysis',
  'forces',
  'live',
  'joint-limits',
  'world-bounds',
]);

function read(): UiMode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'simple' || v === 'advanced' ? v : null;
  } catch {
    return null;
  }
}

let stored = read();
let mode: UiMode = stored ?? 'advanced';

export const getUiMode = (): UiMode => mode;
/** The `app` argument keeps call sites uniform with other per-app queries. */
export const isAdvancedMode = (_app?: unknown): boolean => mode === 'advanced';
/** Has the user ever chosen a mode (or been asked)? */
export const wasModeChosen = (): boolean => {
  if (stored !== null) return true;
  try {
    return localStorage.getItem(ASKED_KEY) === '1';
  } catch {
    return false;
  }
};
export function markModeAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function onUiModeChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reflect the mode in the page (class on #app + generated stylesheet). */
export function applyUiMode(): void {
  document.getElementById('app')?.classList.toggle('ui-simple', mode === 'simple');
  document.getElementById('app')?.classList.toggle('ui-advanced', mode === 'advanced');
}

export function setUiMode(next: UiMode): void {
  stored = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
  if (next === mode) return;
  mode = next;
  applyUiMode();
  listeners.forEach((f) => f(next === 'advanced'));
}

let styleEl: HTMLStyleElement | null = null;
function refreshStyle(): void {
  if (typeof document === 'undefined') return;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'ui-a-advanced';
    document.head.appendChild(styleEl);
  }
  const sel = [...advancedIds].map((id) => `#app.ui-simple section.section[data-sid="${CSS.escape(id)}"]`);
  styleEl.textContent = `${sel.join(',\n')}{display:none !important}`;
}

/** Hide the `section(…, { id })` with this id in Simple mode. */
export function markAdvancedSection(...ids: string[]): void {
  for (const id of ids) advancedIds.add(id);
  refreshStyle();
}
export const isAdvancedSection = (id: string): boolean => advancedIds.has(id);
export function initAdvancedStyle(): void {
  refreshStyle();
}

/** Friendlier wording shown in Simple mode. */
const FRIENDLY: Record<string, string> = {
  'Lin. damping': 'Air slow-down',
  'Ang. damping': 'Spin slow-down',
  'Gravity scale': 'Gravity strength',
  'Initial motion': 'Starting motion',
  'Velocity (m/s)': 'Starting speed (m/s)',
  'Spin (rad/s)': 'Starting spin (rad/s)',
  'Lock move': 'Hold in place',
  'Lock rotate': 'Hold from turning',
  Density: 'Heaviness (density)',
  Metalness: 'Shininess (metal)',
};
export function friendly(label: string): string {
  return mode === 'simple' ? (FRIENDLY[label] ?? label) : label;
}

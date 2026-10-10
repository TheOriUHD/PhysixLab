/**
 * UI themes. Colours live in CSS custom properties: the dark defaults in `:root` of `styles/app.css`, one
 * `[data-theme="…"]` override block per theme in `styles/themes.css`. This module is the only TypeScript that
 * knows about them:
 *
 *  - `applyTheme(theme, accent)` sets `data-theme` on <html> and (for a custom accent) the `--accent*` tokens;
 *  - `cssColor('--chart-1')` reads a token for a canvas (cached until the theme changes, so it is cheap per frame);
 *  - `onThemeChange(fn)` fires after the tokens changed, so canvases and charts redraw.
 *
 * The pure colour maths (`contrast`, `accentTokens`, `legibleAccent` …) has no DOM dependency and is unit-tested.
 */
import { Emitter } from '../core/events';

export type ThemeId = 'dark' | 'light' | 'high-contrast' | 'midnight' | 'solarized' | 'blueprint';

export interface ThemeDef {
  id: ThemeId;
  label: string;
  description: string;
  /** Does the theme have light surfaces? (drives `color-scheme` for native controls and scrollbars) */
  light: boolean;
}

export const THEMES: readonly ThemeDef[] = [
  { id: 'dark', label: 'Dark', description: 'Graphite surfaces with a cool cyan accent (default)', light: false },
  { id: 'light', label: 'Light', description: 'Bright surfaces for well-lit rooms', light: true },
  {
    id: 'high-contrast',
    label: 'High contrast',
    description: 'Black and white with strong outlines; text meets a 7:1 contrast ratio',
    light: false,
  },
  { id: 'midnight', label: 'Midnight', description: 'Deep navy surfaces with a soft periwinkle accent', light: false },
  {
    id: 'solarized',
    label: 'Solarized',
    description: 'Low-glare teal and cream, after the Solarized palette',
    light: false,
  },
  { id: 'blueprint', label: 'Blueprint', description: 'White-on-blue drafting-table look', light: false },
];

export const DEFAULT_THEME: ThemeId = 'dark';

/** Quick-pick accent colours offered next to the free colour picker. */
export const ACCENT_PRESETS: readonly { value: string; label: string }[] = [
  { value: '#3ddcff', label: 'Cyan' },
  { value: '#5c9dff', label: 'Blue' },
  { value: '#a78bfa', label: 'Violet' },
  { value: '#f472b6', label: 'Pink' },
  { value: '#fb7185', label: 'Rose' },
  { value: '#fb923c', label: 'Orange' },
  { value: '#facc15', label: 'Yellow' },
  { value: '#4ade80', label: 'Green' },
];

/**
 * Every colour token a theme must define (tests/theme.test.ts checks `:root` and each theme block against this
 * list). Non-colour tokens (`--radius`, `--font` …) live only in `:root`.
 */
// prettier-ignore
export const THEME_TOKENS = [
  'bg', 'bg-deep', 'panel', 'panel-2', 'raised', 'hover', 'border', 'border-2',
  'text', 'text-2', 'text-3',
  'accent', 'accent-2', 'accent-bg', 'accent-line', 'accent-ink',
  'run', 'run-2', 'run-ink', 'run-bg', 'pause', 'pause-2', 'pause-ink', 'pause-bg',
  'danger', 'warn', 'warn-bg', 'axis-x', 'axis-y', 'axis-z',
  'shadow', 'shadow-modal', 'glass', 'scrim', 'stage-bg', 'topbar-a', 'topbar-b', 'statusbar-bg',
  'switch-thumb', 'swatch-line', 'label-bg',
  'canvas-grid', 'canvas-grid-2', 'canvas-zero', 'canvas-text', 'glyph-bg', 'glyph-line',
  'chart-total', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/** Tokens a custom accent overrides inline on <html>. */
const ACCENT_TOKENS = ['accent', 'accent-bg', 'accent-line', 'accent-ink'] as const;

// ── colour maths (pure) ────────────────────────────────────────────────────────────────────────

const HEX6 = /^#[0-9a-f]{6}$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX6.test(v);
}

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v);
}

/** A stored theme id, or the default for anything unknown. */
export function sanitizeTheme(v: unknown): ThemeId {
  return isThemeId(v) ? v : DEFAULT_THEME;
}

/** A stored accent: `#rrggbb` (lower-cased) or '' for "the theme's own accent". */
export function sanitizeAccent(v: unknown): string {
  return isHexColor(v) ? v.toLowerCase() : '';
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1 … 21) between two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on `bg` (text on an accent-coloured button). */
export function inkFor(bg: string): string {
  return contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff';
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/**
 * Nudge `accent` toward white or black until it reaches `min` contrast on `surface` (default 3:1, the WCAG
 * minimum for UI components). A colour that already passes is returned unchanged.
 */
export function legibleAccent(accent: string, surface: string, min = 3): string {
  if (contrast(accent, surface) >= min) return accent;
  const toward = contrast('#ffffff', surface) >= contrast('#000000', surface) ? '#ffffff' : '#000000';
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(accent, toward, t);
    if (contrast(c, surface) >= min) return c;
  }
  return toward;
}

/** The `--accent*` token values for a custom accent colour. */
export function accentTokens(accent: string): Record<(typeof ACCENT_TOKENS)[number], string> {
  const [r, g, b] = hexToRgb(accent);
  return {
    accent,
    'accent-bg': `rgba(${r}, ${g}, ${b}, 0.14)`,
    'accent-line': `rgba(${r}, ${g}, ${b}, 0.5)`,
    'accent-ink': inkFor(accent),
  };
}

// ── runtime ────────────────────────────────────────────────────────────────────────────────────

const events = new Emitter<{ change: { theme: ThemeId; accent: string } }>();
const cache = new Map<string, string>();
let current: { theme: ThemeId; accent: string } = { theme: DEFAULT_THEME, accent: '' };

export function currentTheme(): { theme: ThemeId; accent: string } {
  return current;
}

/** Subscribe to theme / accent changes (fires after the tokens are in place). Returns the unsubscribe function. */
export function onThemeChange(fn: (t: { theme: ThemeId; accent: string }) => void): () => void {
  return events.on('change', fn);
}

/**
 * Read a CSS token as a colour string usable in canvas `fillStyle` / `strokeStyle` (`'--chart-1'` or `'chart-1'`).
 * Cached; the cache is dropped whenever the theme changes, so it is safe to call every frame.
 */
export function cssColor(token: string, fallback = '#888888'): string {
  const name = token.startsWith('--') ? token : `--${token}`;
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let v = '';
  if (typeof document !== 'undefined') v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return fallback;
  cache.set(name, v);
  return v;
}

/**
 * Switch theme and accent ('' = the theme's own accent). A custom accent is nudged until it is legible on the
 * theme's panel colour. Safe to call repeatedly; listeners are notified only when something changed.
 */
export function applyTheme(theme: ThemeId, accent = ''): void {
  if (typeof document === 'undefined') return;
  const id = sanitizeTheme(theme);
  const acc = sanitizeAccent(accent);
  const root = document.documentElement;
  const same = current.theme === id && current.accent === acc && root.dataset.theme === id;
  if (same) return;
  root.dataset.theme = id;
  root.style.colorScheme = THEMES.find((t) => t.id === id)?.light ? 'light' : 'dark';
  for (const t of ACCENT_TOKENS) root.style.removeProperty(`--${t}`);
  cache.clear();
  if (acc) {
    const surface = cssColor('--panel', '');
    const tokens = accentTokens(isHexColor(surface) ? legibleAccent(acc, surface) : acc);
    for (const t of ACCENT_TOKENS) root.style.setProperty(`--${t}`, tokens[t]);
    cache.clear();
  }
  current = { theme: id, accent: acc };
  events.emit('change', current);
}

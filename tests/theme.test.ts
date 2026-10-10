import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  THEMES,
  THEME_TOKENS,
  accentTokens,
  contrast,
  hexToRgb,
  inkFor,
  isHexColor,
  legibleAccent,
  sanitizeAccent,
  sanitizeTheme,
} from '../src/ui/theme';

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const appCss = stripComments(readFileSync('src/styles/app.css', 'utf8'));
const themesCss = stripComments(readFileSync('src/styles/themes.css', 'utf8'));

/** Declarations of the first rule whose selector list contains `selector`. */
function block(css: string, selector: string): Record<string, string> {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (!m[1].split(',').some((s) => s.trim() === selector)) continue;
    const out: Record<string, string> = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    return out;
  }
  throw new Error(`no rule for ${selector}`);
}

function tokensOf(id: string): Record<string, string> {
  return id === 'dark' ? block(appCss, ':root') : block(themesCss, `[data-theme="${id}"]`);
}

describe('theme token completeness', () => {
  it('lists six themes with unique ids', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['dark', 'light', 'high-contrast', 'midnight', 'solarized', 'blueprint']);
  });

  for (const t of THEMES) {
    it(`${t.id} defines every token`, () => {
      const decl = tokensOf(t.id);
      const missing = THEME_TOKENS.filter((k) => !(`--${k}` in decl));
      expect(missing).toEqual([]);
      expect(decl['color-scheme']).toBe(t.light ? 'light' : 'dark');
    });
  }

  it('does not define unknown colour tokens in a theme block', () => {
    const known = new Set<string>(THEME_TOKENS.map((k) => `--${k}`));
    for (const t of THEMES.filter((x) => x.id !== 'dark')) {
      const extra = Object.keys(tokensOf(t.id)).filter((k) => k.startsWith('--') && !known.has(k));
      expect(extra, t.id).toEqual([]);
    }
  });

  it('keeps hard-coded colours out of app.css outside the :root token block', () => {
    const rest = appCss.replace(/:root,[^{]*\{[^}]*\}/, '');
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? []).toEqual([]);
  });
});

describe('theme contrast', () => {
  for (const t of THEMES) {
    const min = t.id === 'high-contrast' ? 7 : 4.5;
    it(`${t.id}: body text >= ${min}:1 on every surface`, () => {
      const d = tokensOf(t.id);
      for (const surface of ['bg', 'bg-deep', 'panel', 'panel-2', 'raised', 'hover']) {
        for (const fg of ['text', 'text-2']) {
          const c = contrast(d[`--${fg}`], d[`--${surface}`]);
          expect(c, `${fg} on ${surface}`).toBeGreaterThanOrEqual(min);
        }
      }
    });

    it(`${t.id}: accent, status colours, chart lines and canvas text are legible`, () => {
      const d = tokensOf(t.id);
      const panel = d['--panel'];
      expect(contrast(d['--accent'], panel), 'accent').toBeGreaterThanOrEqual(3);
      expect(contrast(d['--accent-ink'], d['--accent']), 'accent-ink on accent').toBeGreaterThanOrEqual(4.5);
      expect(contrast(d['--run-ink'], d['--run']), 'run-ink').toBeGreaterThanOrEqual(4.5);
      expect(contrast(d['--pause-ink'], d['--pause']), 'pause-ink').toBeGreaterThanOrEqual(4.5);
      for (const k of ['run', 'pause', 'danger', 'warn'])
        expect(contrast(d[`--${k}`], panel), k).toBeGreaterThanOrEqual(3);
      for (const k of ['total', '1', '2', '3', '4', '5'])
        expect(contrast(d[`--chart-${k}`], panel), `chart-${k}`).toBeGreaterThanOrEqual(3);
      expect(contrast(d['--canvas-text'], panel), 'canvas-text').toBeGreaterThanOrEqual(min);
      expect(contrast(d['--text-3'], panel), 'text-3').toBeGreaterThanOrEqual(t.id === 'high-contrast' ? 7 : 3);
    });
  }
});

describe('accent handling', () => {
  it('sanitises stored values', () => {
    expect(sanitizeTheme('light')).toBe('light');
    expect(sanitizeTheme('neon')).toBe('dark');
    expect(sanitizeTheme(undefined)).toBe('dark');
    expect(sanitizeAccent('#FFAA00')).toBe('#ffaa00');
    expect(sanitizeAccent('red')).toBe('');
    expect(sanitizeAccent('#fff')).toBe('');
    expect(sanitizeAccent(12)).toBe('');
    expect(isHexColor('#12abEF')).toBe(true);
  });

  it('derives the accent tokens', () => {
    const t = accentTokens('#ff8000');
    expect(t.accent).toBe('#ff8000');
    expect(t['accent-bg']).toBe('rgba(255, 128, 0, 0.14)');
    expect(t['accent-line']).toBe('rgba(255, 128, 0, 0.5)');
    expect(hexToRgb(t['accent-ink'])).toSatisfy((rgb: number[]) => rgb.every((v) => v === 0 || v === 255));
  });

  it('picks readable ink for any accent', () => {
    for (const a of ['#000000', '#ffffff', '#ffd400', '#1a237e', '#3ddcff', '#ff0000', '#808080']) {
      expect(contrast(inkFor(a), a), a).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('nudges illegible accents until they reach the requested contrast, and leaves good ones alone', () => {
    const panels = THEMES.map((t) => tokensOf(t.id)['--panel']);
    for (const panel of panels) {
      for (const a of ['#000000', '#ffffff', '#0b0f1a', '#f0f4ff', '#12161e', '#808080']) {
        expect(contrast(legibleAccent(a, panel), panel), `${a} on ${panel}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(legibleAccent('#3ddcff', '#12161e')).toBe('#3ddcff');
  });

  it('the default accent of every theme is already legible without nudging', () => {
    for (const t of THEMES) {
      const d = tokensOf(t.id);
      expect(legibleAccent(d['--accent'], d['--panel'])).toBe(d['--accent']);
    }
  });
});

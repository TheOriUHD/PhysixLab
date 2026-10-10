/**
 * Appearance: the theme picker dialog (six themes + accent colour) and the commands / menu entries that reach it.
 * Everything is a registration (commands, menu entries); the preferences store holds the choice and `PrefsSync`
 * applies it through `applyTheme`. Theme tokens live in `styles/themes.css`.
 */
import type { App } from '../app/app';
import { registerCommand, runCommand, type CommandDef } from '../app/registry/commands';
import { registerMenuEntry } from '../app/registry/menus';
import { colorField } from './controls';
import { h } from './dom';
import { icon } from './icons';
import { openModal } from './modal';
import { ACCENT_PRESETS, THEMES, type ThemeId } from './theme';

const themeCommandId = (id: ThemeId) => `view.theme.${id}`;

function appearanceCommands(): CommandDef[] {
  return [
    ...THEMES.map((t): CommandDef => ({
      id: themeCommandId(t.id),
      label: `Theme: ${t.label}`,
      category: 'View',
      description: t.description,
      icon: 'palette',
      setting: true,
      keywords: ['appearance', 'colour', 'color', 'dark', 'light', 'mode', 'skin'],
      checked: (app) => app.prefs.value.theme === t.id,
      run: ({ app }) => app.prefs.set({ theme: t.id }),
    })),
    {
      id: 'view.appearance',
      label: 'Appearance…',
      category: 'View',
      icon: 'palette',
      description: 'Choose the interface theme and accent colour',
      keywords: ['theme', 'accent', 'colour', 'color', 'dark', 'light', 'contrast'],
      run: ({ app }) => showAppearance(app),
    },
    {
      id: 'view.accent.reset',
      label: 'Accent colour: use the theme’s own',
      category: 'View',
      icon: 'palette',
      setting: true,
      keywords: ['theme', 'colour', 'color', 'default'],
      enabled: (app) => app.prefs.value.accent !== '',
      run: ({ app }) => app.prefs.set({ accent: '' }),
    },
  ];
}

/** Registers the appearance commands and View-menu entries (called from `registerUiBuiltins`). */
export function registerAppearance(): void {
  for (const c of appearanceCommands()) registerCommand(c);
  // One entry: the dialog has the six themes and the accent; each theme is also a command in the palette.
  registerMenuEntry({
    id: 'menu.view.appearance',
    menu: 'view',
    group: 'theme',
    order: 460,
    command: 'view.appearance',
    icon: 'palette',
  });
}

/** The small top-bar button that opens the dialog. */
export function appearanceButton(app: App): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn', type: 'button', title: 'Appearance: theme and accent colour' });
  b.append(icon('palette'));
  b.addEventListener('click', () => runCommand('view.appearance', app, 'button'));
  return b;
}

let open: { close(): void } | null = null;

/** The theme / accent dialog. Changes apply live and are saved with the other preferences. */
export function showAppearance(app: App): void {
  if (open) {
    open.close();
    return;
  }
  const { prefs } = app;

  // ---- themes: a radio group of preview cards (arrow keys move, Home / End jump) -------------
  const cards = THEMES.map((t) => {
    const preview = h(
      'div',
      { class: 'theme-preview', 'data-theme': t.id, 'aria-hidden': 'true' },
      h('i', { class: 'tp-top' }),
      h('i', { class: 'tp-side' }),
      h(
        'i',
        { class: 'tp-main' },
        h('b', { class: 'tp-line' }),
        h('b', { class: 'tp-line short' }),
        h('b', { class: 'tp-chip' }),
      ),
    );
    const card = h(
      'button',
      {
        class: 'theme-card',
        type: 'button',
        role: 'radio',
        title: `${t.label}: ${t.description}`,
        'aria-label': `${t.label} theme. ${t.description}`,
        dataset: { theme: t.id },
      },
      preview,
      h('span', { class: 'theme-name' }, t.label),
    );
    card.addEventListener('click', () => prefs.set({ theme: t.id }));
    return card;
  });
  const grid = h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme' }, cards);
  grid.addEventListener('keydown', (e) => {
    const i = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let n: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % cards.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i + cards.length - 1) % cards.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = cards.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    cards[n].focus();
    cards[n].click();
  });

  // ---- accent ---------------------------------------------------------------------------------
  const swatches = ACCENT_PRESETS.map((p) => {
    const b = h('button', {
      class: 'accent-swatch',
      type: 'button',
      role: 'radio',
      title: `${p.label} (${p.value})`,
      'aria-label': `Accent ${p.label}`,
      style: { background: p.value },
      dataset: { value: p.value },
    });
    b.addEventListener('click', () => prefs.set({ accent: p.value }));
    return b;
  });
  const swatchRow = h(
    'div',
    { class: 'accent-row', role: 'radiogroup', 'aria-label': 'Accent colour presets' },
    swatches,
  );
  const custom = colorField({
    value: prefs.value.accent || '#3ddcff',
    onChange: (v) => prefs.set({ accent: v }),
  });
  const resetBtn = h(
    'button',
    { class: 'btn small', type: 'button', title: 'Use the accent colour that belongs to the selected theme' },
    'Theme default',
  );
  resetBtn.addEventListener('click', () => prefs.set({ accent: '' }));

  const sync = () => {
    const { theme, accent } = prefs.value;
    cards.forEach((c) => {
      const on = c.dataset.theme === theme;
      c.classList.toggle('on', on);
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    });
    swatches.forEach((s) => {
      const on = s.dataset.value === accent;
      s.classList.toggle('on', on);
      s.setAttribute('aria-checked', String(on));
    });
    if (accent) custom.set(accent);
    resetBtn.disabled = accent === '';
  };
  const off = prefs.on('change', (keys) => {
    if (keys.includes('theme') || keys.includes('accent')) sync();
  });
  sync();

  const m = openModal({
    title: 'Appearance',
    width: 'min(560px, calc(100vw - 40px))',
    onClose: () => {
      off();
      open = null;
    },
    body: [
      h('h4', { class: 'appearance-h' }, 'Theme'),
      grid,
      h('h4', { class: 'appearance-h' }, 'Accent colour'),
      h('div', { class: 'accent-controls' }, swatchRow, custom.el, resetBtn),
      h(
        'p',
        { class: 'hint-text' },
        'Panels, charts and overlays follow the theme. The 3D viewport background is part of the scene and is not changed.',
      ),
    ],
  });
  open = m;
  (cards.find((c) => c.classList.contains('on')) ?? cards[0]).focus();
}

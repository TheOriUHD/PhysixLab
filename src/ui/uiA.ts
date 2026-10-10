/**
 * UI-A glue: Simple / Advanced mode, the quick-properties bar, the floating inspector that follows the selection,
 * and their commands + View-menu entries. `registerUiACommands()` runs with the other built-in registrations,
 * `mountUiA(app, shell)` runs once the App exists (main.ts).
 */
import type { App } from '../app/app';
import { registerCommand, type CommandDef } from '../app/registry/commands';
import { registerMenuEntry, type MenuEntryDef } from '../app/registry/menus';
import { getDock, peekDock } from './dock/dockManager';
import { h } from './dom';
import { mountQuickBar, quickBarEnabled, setQuickBarEnabled } from './quickBar';
import {
  applyUiMode,
  getUiMode,
  initAdvancedStyle,
  markModeAsked,
  onUiModeChange,
  setUiMode,
  wasModeChosen,
} from './uiMode';

const INSPECTOR = 'inspector';

function toggleFloatingInspector(app: App): void {
  const dock = getDock(app);
  if (dock.isFloating(INSPECTOR) && dock.isFollowing(INSPECTOR)) {
    dock.disableFollow(INSPECTOR);
    dock.dockPanel(INSPECTOR);
    return;
  }
  const rect = app.viewport.dom.getBoundingClientRect();
  if (!dock.isFloating(INSPECTOR)) dock.floatPanel(INSPECTOR, { x: rect.right - 380, y: rect.top + 70 });
  dock.enableFollow(INSPECTOR);
  dock.reveal(INSPECTOR);
}

export function uiACommands(): CommandDef[] {
  return [
    {
      id: 'ui.mode.simple',
      label: 'Simple interface',
      category: 'View',
      icon: 'sparkle',
      description: 'Hide the advanced inspector sections and use friendlier labels',
      keywords: ['mode', 'beginner', 'easy', 'basic'],
      setting: true,
      checked: () => getUiMode() === 'simple',
      run: () => setUiMode('simple'),
    },
    {
      id: 'ui.mode.advanced',
      label: 'Advanced interface',
      category: 'View',
      icon: 'settings',
      description: 'Show every section: components, logic, solver, collision layers, analysis',
      keywords: ['mode', 'expert', 'pro', 'full'],
      setting: true,
      checked: () => getUiMode() === 'advanced',
      run: () => setUiMode('advanced'),
    },
    {
      id: 'ui.quickbar',
      label: 'Quick properties bar',
      category: 'View',
      icon: 'bolt',
      description: 'A compact bar in the viewport for the selected object: type, mass, material, lock, hide',
      keywords: ['toolbar', 'properties', 'selection'],
      setting: true,
      checked: () => quickBarEnabled(),
      run: () => setQuickBarEnabled(!quickBarEnabled()),
    },
    {
      id: 'ui.inspector.float',
      label: 'Floating inspector',
      category: 'View',
      icon: 'settings',
      description: 'Pop the inspector out as a window that follows the selected object (pin it to keep it in place)',
      keywords: ['inspector', 'window', 'follow', 'pin', 'float'],
      checked: (app) => !!peekDock(app)?.isFloating(INSPECTOR) && !!peekDock(app)?.isFollowing(INSPECTOR),
      run: ({ app }) => toggleFloatingInspector(app),
    },
  ];
}

export function registerUiAMenu(): (() => void)[] {
  const entries: MenuEntryDef[] = [
    { id: 'menu.view.interfaceHeading', menu: 'view', group: 'interface', order: 700, heading: 'Interface' },
    { id: 'menu.view.mode.simple', menu: 'view', group: 'interface', order: 710, command: 'ui.mode.simple' },
    { id: 'menu.view.mode.advanced', menu: 'view', group: 'interface', order: 720, command: 'ui.mode.advanced' },
    { id: 'menu.view.quickbar', menu: 'view', group: 'interface', order: 730, command: 'ui.quickbar' },
    { id: 'menu.view.floatInspector', menu: 'view', group: 'interface', order: 740, command: 'ui.inspector.float' },
  ];
  return entries.map((e) => registerMenuEntry(e));
}

export function registerUiA(): void {
  for (const c of uiACommands()) registerCommand(c);
  registerUiAMenu();
}

/** Mount the UI-A pieces that need the App and the page. */
export function mountUiA(app: App): void {
  applyUiMode();
  initAdvancedStyle();
  mountQuickBar(app, app.shell.stage);
  // First run: offer Simple mode once (never again, whatever the answer).
  if (!wasModeChosen()) setTimeout(() => offerSimpleMode(app), 2500);
  onUiModeChange(() => app.store.emit('selection', app.store.selection));
}

function offerSimpleMode(app: App): void {
  if (wasModeChosen()) return;
  // Wait until a welcome dialog or any other modal is gone.
  if (document.querySelector('.modal-back')) {
    setTimeout(() => offerSimpleMode(app), 1500);
    return;
  }
  markModeAsked();
  const close = () => card.remove();
  const simple = h('button', { class: 'btn primary', type: 'button' }, 'Use Simple mode');
  const keep = h('button', { class: 'btn', type: 'button' }, 'Keep everything');
  simple.addEventListener('click', () => {
    setUiMode('simple');
    close();
  });
  keep.addEventListener('click', () => {
    setUiMode('advanced');
    close();
  });
  const card = h(
    'div',
    { class: 'mode-suggest floating', role: 'dialog', 'aria-label': 'Choose an interface mode' },
    h(
      'div',
      { class: 'ms-text' },
      h('b', null, 'New here?'),
      ' Simple mode hides the expert sections. Switch any time in View.',
    ),
    simple,
    keep,
  );
  app.shell.stage.appendChild(card);
}

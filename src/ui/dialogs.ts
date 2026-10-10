import type { App } from '../app/app';
import { helpSections } from '../app/registry/help';
import { button } from './controls';
import { h } from './dom';
import { icon } from './icons';
import { openModal } from './modal';

/** The keyboard shortcut reference — generated from the command registry and the gesture entries. */
export function showShortcuts(): void {
  const grid = h('div', { class: 'kbd-grid' });
  for (const section of helpSections()) {
    grid.appendChild(h('div', { class: 'kbd-group' }, section.title));
    for (const row of section.rows) {
      const joined: (HTMLElement | string)[] = [];
      row.alternatives.forEach((keys, i) => {
        if (i) joined.push(h('span', { style: { margin: '0 6px', color: 'var(--text-3)' } }, 'or'));
        joined.push(h('span', null, ...keys.map((k) => h('kbd', { style: { marginLeft: '3px' } }, k))));
      });
      grid.appendChild(h('div', { class: 'kbd-row' }, h('span', null, row.label), h('span', null, ...joined)));
    }
  }
  openModal({ title: 'Keyboard shortcuts', body: [grid], width: '780px' });
}

export function showWelcome(app: App): void {
  const start = (id: string) => {
    m.close();
    app.loadTemplate(id);
  };
  const card = (title: string, text: string, ic: string, action: () => void) => {
    const c = h('button', { class: 'card', type: 'button' }, h('h4', null, icon(ic), title), h('p', null, text));
    c.addEventListener('click', action);
    return c;
  };
  const body = [
    h('h2', { class: 'big-title' }, 'Welcome to PhysicsLab'),
    h(
      'p',
      { class: 'sub' },
      'A real physics sandbox — rigid bodies with gravity, friction and restitution; joints, motors and springs; plus soft bodies (jelly, cloth, cables that tear) — all simulated by a WebAssembly physics engine running in a worker. Build something, press Simulate, and grab things while they move.',
    ),
    h(
      'div',
      { class: 'welcome' },
      card('Drive the car', 'Suspension, steering and a motor — press Simulate and use W A S D.', 'car', () =>
        start('car'),
      ),
      card('Wreck a wall', 'A chained ball on a crane. Drag bodies around while it runs.', 'blast', () =>
        start('wreck'),
      ),
      card(
        'Start from scratch',
        'An empty lab: add shapes from the library (or press 1–8), connect them with joints (J).',
        'plus',
        () => {
          m.close();
          app.newScene();
        },
      ),
      card(
        'Explore the examples',
        'Pendulums, springs, friction, momentum, a ball pit stress test and more.',
        'layers',
        () => {
          m.close();
          app.prefs.set({ leftTab: 'scenes', showLeft: true });
        },
      ),
    ),
    h(
      'p',
      { class: 'hint-text', style: { marginTop: '14px' } },
      'Tip: your work is autosaved in this browser, every edit is undoable (Ctrl+Z), and “Copy share link” in the File menu packs a scene into a URL.',
    ),
  ];
  const ok = button('Let’s go', () => m.close(), { cls: 'primary' });
  const m = openModal({ title: 'PhysicsLab', body, footer: [ok], onClose: () => app.prefs.set({ seenWelcome: true }) });
}

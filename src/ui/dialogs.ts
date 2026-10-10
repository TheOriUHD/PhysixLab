import type { App } from '../app/app';
import { openCheatSheet } from './help/cheatSheet';
import { button } from './controls';
import { h } from './dom';
import { icon } from './icons';
import { openModal } from './modal';
import { ONBOARDING_TOUR, startTour } from './tour';

/** The keyboard shortcut cheat-sheet (searchable; see `help/cheatSheet.ts`). */
// -- UI-B: the cheat-sheet replaced the static list --
export function showShortcuts(app?: App): void {
  openCheatSheet(app);
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
  // -- UI-B: the guided first-run tour is offered right here --
  const tour = button(
    'Take the tour',
    () => {
      m.close();
      startTour(ONBOARDING_TOUR, app);
    },
    { icon: 'info', title: 'A two-minute walk through the basics, right in the app' },
  );
  const m = openModal({
    title: 'PhysicsLab',
    body,
    footer: [tour, ok],
    onClose: () => app.prefs.set({ seenWelcome: true }),
  });
}

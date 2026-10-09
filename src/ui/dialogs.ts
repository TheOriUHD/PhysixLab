import type { App } from '../app/app';
import { button } from './controls';
import { h } from './dom';
import { icon } from './icons';
import { openModal } from './modal';

const SHORTCUTS: [string, [string, string][]][] = [
  ['Simulation', [
    ['Start / pause', 'Space'], ['Stop and return to the editable layout', 'Shift Space'], ['Single step (paused)', '.'],
    ['Throw a body while running', 'Drag'], ['Drive / actuate', 'Bound motor keys'],
  ]],
  ['Tools', [
    ['Select only', 'Q'], ['Move gizmo', 'W'], ['Rotate gizmo', 'E'], ['Scale gizmo', 'R'], ['Joint tool', 'J'],
    ['Measure', 'M'], ['Blast', 'B'], ['Fire projectile', 'T'], ['Grid snapping', 'G'], ['World / local space', 'X'],
  ]],
  ['Selection & editing', [
    ['Select / add to selection', 'Click · Shift Click'], ['Box select', 'Drag on empty space'], ['Select all', 'Ctrl A'],
    ['Duplicate', 'Ctrl D'], ['Copy · paste', 'Ctrl C · Ctrl V'], ['Delete', 'Del'], ['Undo · redo', 'Ctrl Z · Ctrl Shift Z'],
    ['Hide · lock', 'H · L'], ['Nudge', 'Arrow keys'], ['Add shape at view', '1 – 8'], ['Vertical drag-move', 'Shift + drag'],
  ]],
  ['Camera', [
    ['Orbit', 'Right drag · Alt drag'], ['Pan', 'Middle drag · Shift Right drag'], ['Zoom', 'Scroll'],
    ['Frame selection', 'F · double-click'], ['Frame everything', 'Home'], ['Follow selection', 'C'],
  ]],
  ['Scene', [['Save to library', 'Ctrl S'], ['Cancel tool / deselect', 'Esc']]],
];

export function showShortcuts(): void {
  const grid = h('div', { class: 'kbd-grid' });
  for (const [group, rows] of SHORTCUTS) {
    grid.appendChild(h('div', { class: 'kbd-group' }, group));
    for (const [label, keys] of rows) {
      const alternatives = keys.split(' · ').map((alt) => h('span', null, ...alt.split(' ').map((k) => h('kbd', { style: { marginLeft: '3px' } }, k))));
      const joined: (HTMLElement | string)[] = [];
      alternatives.forEach((a2, i) => { if (i) joined.push(h('span', { style: { margin: '0 6px', color: 'var(--text-3)' } }, 'or')); joined.push(a2); });
      grid.appendChild(h('div', { class: 'kbd-row' }, h('span', null, label), h('span', null, ...joined)));
    }
  }
  openModal({ title: 'Keyboard shortcuts', body: [grid], width: '780px' });
}

export function showWelcome(app: App): void {
  const start = (id: string) => { m.close(); app.loadTemplate(id); };
  const card = (title: string, text: string, ic: string, action: () => void) => {
    const c = h('button', { class: 'card', type: 'button' }, h('h4', null, icon(ic), title), h('p', null, text));
    c.addEventListener('click', action);
    return c;
  };
  const body = [
    h('h2', { class: 'big-title' }, 'Welcome to PhysicsLab'),
    h('p', { class: 'sub' }, 'A real physics sandbox — rigid bodies with gravity, friction and restitution; joints, motors and springs; plus soft bodies (jelly, cloth, cables that tear) — all simulated by a WebAssembly physics engine running in a worker. Build something, press Simulate, and grab things while they move.'),
    h('div', { class: 'welcome' },
      card('Drive the car', 'Suspension, steering and a motor — press Simulate and use W A S D.', 'car', () => start('car')),
      card('Wreck a wall', 'A chained ball on a crane. Drag bodies around while it runs.', 'blast', () => start('wreck')),
      card('Start from scratch', 'An empty lab: add shapes from the library (or press 1–8), connect them with joints (J).', 'plus', () => { m.close(); app.newScene(); }),
      card('Explore the examples', 'Pendulums, springs, friction, momentum, a ball pit stress test and more.', 'layers', () => { m.close(); app.prefs.set({ leftTab: 'scenes', showLeft: true }); })),
    h('p', { class: 'hint-text', style: { marginTop: '14px' } }, 'Tip: your work is autosaved in this browser, every edit is undoable (Ctrl+Z), and “Copy share link” in the File menu packs a scene into a URL.'),
  ];
  const ok = button('Let’s go', () => m.close(), { cls: 'primary' });
  const m = openModal({ title: 'PhysicsLab', body, footer: [ok], onClose: () => app.prefs.set({ seenWelcome: true }) });
}

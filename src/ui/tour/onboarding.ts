/**
 * UI-40: the first-run tour. It teaches the basics against the real UI: add a shape, select, inspect, simulate,
 * grab a body, reset, the command palette, undo, and where Help lives. Every step that asks the user to do
 * something advances by itself when they do (and offers "Skip step" when they would rather not).
 */
import type { App } from '../../app/app';
import { runCommand } from '../../app/registry/commands';
import { registerTour, type TourStep } from './engine';

export const ONBOARDING_TOUR = 'onboarding';

const paletteOpen = () => !!document.querySelector('.palette-back');
const helpMenuButton = (): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>('.menubar .menu-btn')].find((b) => b.textContent?.trim() === 'Help') ??
  null;

/** Back to the editable layout (the tour's "add a shape" needs edit mode). */
const leaveSimulation = (app: App) => {
  if (app.sim.active) runCommand('sim.reset', app, 'api');
};

export function registerOnboardingTour(): () => void {
  // Stateful `until` for the palette step: opened, then closed again.
  let paletteSeen = false;
  let paletteWatch: MutationObserver | null = null;
  const steps: TourStep[] = [
    {
      target: null,
      title: 'Welcome to PhysicsLab',
      body: 'A two-minute walk through the basics: add something, select it, set it moving and grab it. You can leave at any time with **Skip tour** or [[Esc]].',
    },
    {
      target: '#panel-add .tiles',
      title: 'Add a shape',
      body: 'The library lives on the left. **Drag a shape** into the scene — a ghost shows where it will land — or **click it, then click in the 3D view**. Try a box or a sphere.',
      placement: 'right',
      waitFor: { event: 'scene-change', type: 'add' },
      onEnter: (app) => {
        leaveSimulation(app);
        app.prefs.set({ showLeft: true, leftTab: 'add' });
      },
    },
    {
      target: '.viewport-host',
      title: 'Select it',
      body: 'Click any object in the 3D view to select it. Drag the arrows that appear to move it; [[Shift]] + click adds to the selection.',
      placement: 'bottom',
      waitFor: { event: 'selection' },
    },
    {
      target: '.panel.right',
      title: 'Edit its properties',
      body: 'The Inspector shows whatever is selected: size, mass, material, colour and components. Change a number and the scene follows.',
      placement: 'left',
      onEnter: (app) => app.prefs.set({ showRight: true, rightTab: 'inspector' }),
    },
    {
      target: '.tbtn.play, .tbtn.pause',
      title: 'Press Simulate',
      body: 'This starts the physics: gravity, collisions, friction. Your layout is kept, so you can always come back to it.',
      placement: 'bottom',
      waitFor: { event: 'sim-mode', mode: 'running' },
    },
    {
      target: '.viewport-host',
      title: 'Grab a body',
      body: 'While it runs, **press on a body and drag** to pull it around — the physics pushes back. Let go to throw it.',
      placement: 'bottom',
      until: (app) => app.viewport.dom.classList.contains('grabbing'),
    },
    {
      target: '.transport > .tbtn:nth-child(3)',
      title: 'Reset the scene',
      body: 'Stop returns everything to where you built it. ([[Shift]] + [[Space]] does the same.)',
      placement: 'bottom',
      waitFor: { event: 'sim-mode', mode: 'edit' },
    },
    {
      target: null,
      title: 'The command palette',
      body: 'Press [[Ctrl+K]] to search every command, setting and example scene. Try typing “gravity”, then close it with [[Esc]].',
      // Opened and closed again — a quick Ctrl+K, Esc must not slip between two polls, so watch the DOM.
      onEnter: () => {
        paletteSeen = paletteOpen();
        paletteWatch?.disconnect();
        paletteWatch = new MutationObserver(() => {
          if (paletteOpen()) paletteSeen = true;
        });
        paletteWatch.observe(document.body, { childList: true });
      },
      onExit: () => {
        paletteWatch?.disconnect();
        paletteWatch = null;
      },
      until: () => paletteSeen && !paletteOpen(),
    },
    {
      target: '.topbar-right .icon-btn[title^="Undo"]',
      title: 'Undo anything',
      body: 'Every edit can be undone with [[Ctrl+Z]] (and redone with [[Ctrl+Shift+Z]]). Try undoing the shape you added.',
      placement: 'bottom',
      waitFor: { event: 'command', id: 'edit.undo' },
    },
    {
      target: helpMenuButton,
      title: 'Help is always here',
      body: 'The Help menu has the keyboard shortcuts, the welcome screen and this tour again. That is all you need — have fun!',
      placement: 'bottom',
    },
  ];
  return registerTour({
    id: ONBOARDING_TOUR,
    title: 'Getting started',
    menuLabel: 'Take the tour',
    steps,
  });
}

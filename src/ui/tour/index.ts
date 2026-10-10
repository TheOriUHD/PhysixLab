/**
 * UI-40: the guided-tour system's entry point. `installTour(app)` (one line in main.ts) registers the first-run
 * tour, the built-in context hints, the tip of the day and their commands, and offers the tour to new users.
 *
 * Reusable API (see docs/EXTENDING.md → "How to add a guided tour"):
 *   registerTour / startTour / stopTour / isTourRunning     ./engine
 *   registerHint                                            ./hints
 */
import type { App } from '../../app/app';
import { registerCommand } from '../../app/registry/commands';
import { registerMenuEntry } from '../../app/registry/menus';
import { guide, guideQuiet } from './guide';
import { installHints, offerTour, registerHint, showTip } from './hints';
import { isTourRunning, startTour } from './engine';
import { ONBOARDING_TOUR, registerOnboardingTour } from './onboarding';

export {
  getTour,
  isTourRunning,
  listTours,
  onTourChange,
  registerTour,
  runningTourId,
  startTour,
  stopTour,
} from './engine';
export type { Placement, TourDef, TourStep, WaitSpec } from './engine';
export { registerHint, type HintDef } from './hints';
export { ONBOARDING_TOUR };

function registerBuiltinHints(): void {
  registerHint({
    id: 'first-selection',
    trigger: { event: 'selection' },
    text: 'Selected! Drag the arrows to move it, [[Ctrl+D]] duplicates it, [[Delete]] removes it, and the Inspector on the right edits its properties.',
  });
  registerHint({
    id: 'first-simulate',
    trigger: { event: 'sim-mode', mode: 'running' },
    delayMs: 1500,
    text: 'Running! Drag a body to push it around, slow time down with the speed buttons in the top bar, and press **Stop** to return to your layout.',
  });
  registerHint({
    id: 'first-joint',
    trigger: { event: 'scene-change', type: 'add' },
    when: (app) => app.prefs.value.tool === 'joint' && app.store.joints().length > 0,
    text: 'Your first joint. Select it to tune its limits, motor and springs in the Inspector, then press Simulate to see it work.',
  });
  registerHint({
    id: 'first-paste',
    trigger: { event: 'command', id: ['edit.paste', 'edit.duplicate'] },
    text: 'Copies are placed next to the original. Select them and drag to arrange; [[Ctrl+Z]] undoes it if it was a mistake.',
  });
  registerHint({
    id: 'first-undo',
    trigger: { event: 'command', id: 'edit.undo' },
    text: 'Undone. [[Ctrl+Shift+Z]] (or [[Ctrl+Y]]) redoes it — the history keeps going back a long way.',
  });
}

/** Wire the guide into the running app. Call once, after `app.start()`. */
export function installTour(app: App): void {
  registerOnboardingTour();
  registerBuiltinHints();

  registerCommand({
    id: 'help.tip',
    label: 'Show a tip',
    category: 'Help',
    icon: 'sparkle',
    keywords: ['hint', 'tip of the day', 'trick'],
    run: ({ app: a }) => showTip(a, false),
  });
  registerMenuEntry({
    id: 'menu.help.tip',
    menu: 'help',
    group: 'help',
    order: 120,
    command: 'help.tip',
    icon: 'sparkle',
  });
  registerCommand({
    id: 'help.hints.toggle',
    label: 'Context hints',
    category: 'Help',
    setting: true,
    description: 'Show a short one-time hint the first time you do something new',
    keywords: ['hints', 'tips', 'help', 'guide'],
    checked: () => guide.state.hintsOn,
    run: () => guide.setHintsOn(!guide.state.hintsOn),
  });
  registerCommand({
    id: 'help.tips.toggle',
    label: 'Tip of the day',
    category: 'Help',
    setting: true,
    description: 'Show a tip once a day when you open PhysicsLab',
    keywords: ['tips', 'hints', 'help', 'guide'],
    checked: () => guide.state.tipsOn,
    run: () => guide.setTipsOn(!guide.state.tipsOn),
  });
  registerCommand({
    id: 'help.guide.reset',
    label: 'Show all hints and tips again',
    category: 'Help',
    description: 'Forget which hints you have seen and turn hints and tips back on',
    keywords: ['reset', 'hints', 'tips', 'tour'],
    run: ({ app: a }) => {
      guide.resetAll();
      a.toast('Hints and tips will show up again.', 'success');
    },
  });

  installHints(app, { tipOfTheDay: guide.isResolved(ONBOARDING_TOUR) });

  // First run: once the welcome dialog is closed, offer the tour (never forced, never repeated once declined).
  if (!guideQuiet() && !guide.isResolved(ONBOARDING_TOUR)) {
    app.prefs.on('change', (keys) => {
      if (!keys.some((k) => k === 'seenWelcome') || !app.prefs.value.seenWelcome) return;
      window.setTimeout(() => {
        if (isTourRunning() || guide.isResolved(ONBOARDING_TOUR)) return;
        offerTour(ONBOARDING_TOUR, 'New here? A two-minute tour shows the basics right in the app.', () =>
          startTour(ONBOARDING_TOUR, app),
        );
      }, 500);
    });
  }
}

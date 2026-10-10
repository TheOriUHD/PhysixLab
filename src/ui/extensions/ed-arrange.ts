// ── ED-A arrange: align / distribute / drop / stack / centre / randomise — commands, the Arrange panel and menus ──
import {
  alignSelection,
  arrangeSettings,
  centreSelectionOnOrigin,
  distributeSelection,
  dropSelectionOntoSurface,
  dropSelectionToGround,
  randomiseSelection,
  stackSelection,
} from '../../app/edit/arrangeOps';
import { registerCommand, registerMenuEntry, registerPanel } from '../../app/registry';
import type { App } from '../../app/app';
import type { AlignMode, Axis } from '../../model/edit/arrange';
import { buildArrangePanel } from '../arrangePanel';

const CATEGORY = 'Arrange';
const AXES: [Axis, 'x' | 'y' | 'z'][] = [
  [0, 'x'],
  [1, 'y'],
  [2, 'z'],
];
const ALIGN_MODES: [AlignMode, string, string][] = [
  ['min', 'min', 'lowest'],
  ['centre', 'centre', 'middle'],
  ['max', 'max', 'highest'],
];

const canArrange = (min: number) => (app: App) => !app.sim.active && app.store.selection.length >= min;

registerPanel({
  id: 'arrange',
  label: 'Arrange',
  icon: 'layers',
  region: 'right',
  order: 45,
  title: 'Align, distribute, drop, stack, centre, randomise and pivot tools',
  build: (app) => {
    const p = buildArrangePanel(app);
    return { el: p.el, onShow: p.refresh, dispose: p.dispose };
  },
});

// ── align ──
for (const [axis, a] of AXES) {
  for (const [mode, label, word] of ALIGN_MODES) {
    registerCommand({
      id: `arrange.align.${a}.${mode}`,
      label: `Align ${a.toUpperCase()}: ${label}`,
      category: CATEGORY,
      icon: 'layers',
      description: `Line the ${word} ${a.toUpperCase()} faces of the selected objects up (to the selection or, when set, the active object)`,
      keywords: ['align', 'line up', a, label],
      enabled: canArrange(1),
      run: ({ app }) => void alignSelection(app, axis, mode),
    });
  }
}
registerCommand({
  id: 'arrange.alignTarget',
  label: 'Align to active object',
  category: CATEGORY,
  setting: true,
  description: 'Align to the active (last selected) object instead of the bounds of the whole selection',
  keywords: ['align', 'active', 'target'],
  checked: () => arrangeSettings.alignTarget === 'active',
  run: () => {
    arrangeSettings.alignTarget = arrangeSettings.alignTarget === 'active' ? 'selection' : 'active';
  },
});

// ── distribute ──
for (const [axis, a] of AXES) {
  for (const [mode, label] of [
    ['spacing', 'even spacing'],
    ['gaps', 'even gaps'],
  ] as const) {
    registerCommand({
      id: `arrange.distribute.${a}.${mode}`,
      label: `Distribute ${a.toUpperCase()}: ${label}`,
      category: CATEGORY,
      icon: 'layers',
      description:
        mode === 'spacing'
          ? `Space the centres evenly along ${a.toUpperCase()} (first and last stay)`
          : `Leave equal empty space between the objects along ${a.toUpperCase()} (first and last stay)`,
      keywords: ['distribute', 'space', 'spread', a],
      enabled: canArrange(3),
      run: ({ app }) => void distributeSelection(app, axis, mode),
    });
  }
}

// ── drop / stack / centre / randomise ──
registerCommand({
  id: 'arrange.dropGround',
  label: 'Drop to ground',
  category: CATEGORY,
  icon: 'layers',
  description: 'Move each selected object vertically until its lowest point touches the ground',
  keywords: ['floor', 'land', 'snap to ground', 'lower'],
  shortcut: 'End',
  enabled: canArrange(1),
  run: ({ app }) => void dropSelectionToGround(app),
});
registerCommand({
  id: 'arrange.dropSurface',
  label: 'Drop onto surface below',
  category: CATEGORY,
  icon: 'layers',
  description:
    'Rest each selected object on the highest body below it (bounding-box approximation), else on the ground',
  keywords: ['rest', 'land', 'place on', 'snap to surface'],
  shortcut: 'Shift+End',
  enabled: canArrange(1),
  run: ({ app }) => void dropSelectionOntoSurface(app),
});
registerCommand({
  id: 'arrange.stack',
  label: 'Stack vertically',
  category: CATEGORY,
  icon: 'layers',
  description: 'Pile the selected objects on top of each other with the gap set in the Arrange panel',
  keywords: ['pile', 'tower', 'column'],
  enabled: canArrange(2),
  run: ({ app }) => void stackSelection(app),
});
registerCommand({
  id: 'arrange.centreOrigin',
  label: 'Centre on origin',
  category: CATEGORY,
  icon: 'frame',
  description: 'Move the selection so the centre of its bounds is at the world origin',
  keywords: ['zero', 'origin', 'centre', 'center'],
  enabled: canArrange(1),
  run: ({ app }) => void centreSelectionOnOrigin(app),
});
registerCommand({
  id: 'arrange.centreOriginXZ',
  label: 'Centre on origin (keep height)',
  category: CATEGORY,
  icon: 'frame',
  description: 'Centre the selection on X and Z, leaving its height alone',
  keywords: ['zero', 'origin', 'centre', 'center'],
  enabled: canArrange(1),
  run: ({ app }) => void centreSelectionOnOrigin(app, [true, false, true]),
});
registerCommand({
  id: 'arrange.randomise',
  label: 'Randomise position / rotation / scale',
  category: CATEGORY,
  icon: 'sparkle',
  description: 'Jitter the selection within the ranges and seed set in the Arrange panel (same seed, same result)',
  keywords: ['random', 'jitter', 'scatter', 'noise', 'seed'],
  enabled: canArrange(1),
  run: ({ app }) => void randomiseSelection(app, false),
});
registerCommand({
  id: 'arrange.reroll',
  label: 'Re-roll randomise',
  category: CATEGORY,
  icon: 'sparkle',
  description: 'Take back the last randomise and apply a new random seed',
  keywords: ['random', 'again', 'seed'],
  enabled: canArrange(1),
  run: ({ app }) => void randomiseSelection(app, true),
});

// ── menu: an "Arrange" group in the Edit menu (the full set of align / distribute commands is in the panel and the palette) ──
registerMenuEntry({ id: 'menu.edit.arrange.h', menu: 'edit', group: 'arrange', order: 500, heading: 'Arrange' });
[
  'arrange.dropGround',
  'arrange.dropSurface',
  'arrange.stack',
  'arrange.centreOrigin',
  'arrange.randomise',
  'panel.arrange',
].forEach((command, i) =>
  registerMenuEntry({ id: `menu.edit.${command}`, menu: 'edit', group: 'arrange', order: 510 + i * 10, command }),
);

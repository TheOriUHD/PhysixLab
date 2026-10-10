// NAV: Drive mode, Play mode, the controls legend, Settings › Navigation and the navigation help.
import { fillMods, platform } from '../../app/input/platform';
import { registerCommand } from '../../app/registry/commands';
import { registerHelp } from '../../app/registry/help';
import { registerMenuEntry } from '../../app/registry/menus';
import { showInputSettings } from '../input/inputSettings';
import { legendState } from '../input/navUi';

registerCommand({
  id: 'drive.toggle',
  label: 'Drive selected vehicle',
  labelFor: (app) => (app.immersive.kind === 'drive' ? 'Exit drive mode' : 'Drive selected vehicle'),
  category: 'Simulation',
  icon: 'car',
  description:
    'Get into the selected vehicle (or the only one in the scene): a chase camera and only its controls, no editor. Esc or Tab leaves.',
  keywords: ['vehicle', 'car', 'immersive', 'chase', 'cockpit', 'steer', 'play', 'drive mode'],
  shortcut: 'V',
  enabled: (app) => app.immersive.kind !== 'play',
  run: ({ app }) => app.immersive.toggleDrive(),
});

registerCommand({
  id: 'play.toggle',
  label: 'Play mode: be in the scene',
  labelFor: (app) => (app.immersive.kind === 'play' ? 'Exit play mode' : 'Play mode: be in the scene'),
  category: 'Simulation',
  icon: 'eye',
  description: 'Run the scene and fly through it, grabbing and throwing things, with the editor out of the way. Esc or Tab leaves.',
  keywords: ['immersive', 'fly', 'first person', 'explore', 'interactive'],
  shortcut: 'Shift+V',
  enabled: (app) => app.immersive.kind !== 'drive',
  run: ({ app }) => app.immersive.togglePlay(),
});

registerCommand({
  id: 'settings.navigation',
  label: 'Settings: navigation (mouse, trackpad, touch)…',
  category: 'View',
  icon: 'keyboard',
  description: 'Choose how the camera follows a mouse, a trackpad or a touch screen, speeds and inversions',
  keywords: ['trackpad', 'mouse', 'swipe', 'pinch', 'scroll', 'orbit', 'pan', 'zoom', 'natural', 'invert', 'macos'],
  palette: true,
  help: false,
  run: ({ app }) => showInputSettings(app, 'navigation'),
});

registerCommand({
  id: 'view.legend',
  label: 'Controls legend',
  category: 'View',
  icon: 'keyboard',
  description: 'A list of what the keys and gestures do right now, bottom-left of the viewport',
  keywords: ['keys', 'controls', 'help', 'pill', 'context', 'hint'],
  setting: true,
  checked: () => legendState.expanded,
  run: () => legendState.toggle(),
});

registerMenuEntry({ id: 'menu.view.drive', menu: 'view', group: 'camera', order: 420, command: 'drive.toggle', icon: 'car' });
registerMenuEntry({ id: 'menu.view.play', menu: 'view', group: 'camera', order: 430, command: 'play.toggle', icon: 'eye' });
registerMenuEntry({ id: 'menu.view.legend', menu: 'view', group: 'settings', order: 902, command: 'view.legend' });
registerMenuEntry({
  id: 'menu.view.navigationSettings',
  menu: 'view',
  group: 'settings',
  order: 903,
  command: 'settings.navigation',
  icon: 'keyboard',
});

// Navigation gestures, printed for this platform (Cmd / Option on a Mac, Ctrl / Alt elsewhere).
const os = platform().os;
const nav = (id: string, label: string, keys: string, order: number) =>
  registerHelp({ id: `nav.${id}`, group: 'Navigation', label: fillMods(label, os), keys: fillMods(keys, os), order });
nav('trackpad.swipe', 'Trackpad: two-finger swipe orbits', 'Two-finger swipe', 10);
nav('trackpad.pan', 'Trackpad: pan', '{shift} swipe · {mod} swipe', 20);
nav('trackpad.pinch', 'Trackpad: pinch zooms towards the cursor', 'Pinch', 30);
nav('trackpad.alt', 'Trackpad: orbit with one finger', '{alt} drag', 40);
nav('space', 'Pan with one finger or the mouse', 'Space drag', 50);
nav('mouse', 'Mouse: orbit · pan · zoom', 'Right drag · Middle drag · Wheel', 60);
nav('dbl', 'Focus an object (double-click); frame everything (double-click empty space)', 'Double-click', 70);
nav('keys.orbit', 'Arrow keys orbit (with a selection, {alt} + arrows)', '↑ ↓ ← →', 80);
nav('keys.pan', 'Pan with the keyboard', 'Shift ↑ ↓ ← →', 90);
nav('keys.zoom', 'Zoom with the keyboard', '+ −', 100);
nav('keys.views', 'Front / side / top / iso view without a numpad', '{alt} 1 · {alt} 3 · {alt} 7 · {alt} 9', 110);
nav('grab', 'Holding a body: push / pull · turn 15° (Shift = 5°) · freeze', 'W S · A D / Q E · F', 120);

// CM-12: touch commands (settings shortcut, show / hide the on-screen controls) and the touch gestures in the help.
import { registerCommand } from '../../app/registry/commands';
import { registerHelp } from '../../app/registry/help';
import { registerMenuEntry } from '../../app/registry/menus';
import { showInputSettings } from '../input/inputSettings';

registerCommand({
  id: 'settings.touch',
  label: 'Settings: touch controls…',
  category: 'View',
  icon: 'keyboard',
  description: 'Choose the on-screen joysticks and buttons, the two-finger gesture and the long-press time',
  keywords: ['touch', 'joystick', 'mobile', 'tablet', 'on-screen', 'gestures', 'long press'],
  palette: true,
  help: false,
  run: ({ app }) => showInputSettings(app, 'touch'),
});

registerCommand({
  id: 'view.touchControls',
  label: 'On-screen touch controls',
  category: 'View',
  icon: 'keyboard',
  description: 'Show the virtual joysticks and buttons (otherwise: automatic on touch devices while simulating)',
  keywords: ['touch', 'joystick', 'virtual', 'gamepad', 'on-screen'],
  setting: true,
  checked: (app) => app.input.settings.touchControls === 'on',
  run: ({ app }) =>
    app.input.update_settings({ touchControls: app.input.settings.touchControls === 'on' ? 'auto' : 'on' }),
});

registerMenuEntry({
  id: 'menu.view.touchControls',
  menu: 'view',
  group: 'settings',
  order: 905,
  command: 'view.touchControls',
});

registerHelp({
  id: 'touch.tap',
  group: 'Touch',
  label: 'Select an object (tap empty space to deselect)',
  keys: 'Tap',
  order: 10,
});
registerHelp({
  id: 'touch.drag',
  group: 'Touch',
  label: 'One finger: move an object, or draw a selection box on empty space',
  keys: 'Drag',
  order: 20,
});
registerHelp({ id: 'touch.long', group: 'Touch', label: 'Hold a finger still: context menu', keys: 'Hold', order: 30 });
registerHelp({
  id: 'touch.orbit',
  group: 'Touch',
  label: 'Drag with two fingers: orbit the camera (or pan, in Settings › Touch)',
  keys: 'Two fingers',
  order: 40,
});
registerHelp({ id: 'touch.zoom', group: 'Touch', label: 'Pinch with two fingers: zoom', keys: 'Pinch', order: 50 });
registerHelp({
  id: 'touch.pan',
  group: 'Touch',
  label: 'Drag with three fingers: pan the camera',
  keys: 'Three fingers',
  order: 60,
});
registerHelp({
  id: 'touch.cancel',
  group: 'Touch',
  label: 'Put a second finger down: cancel a one-finger move or selection box',
  keys: 'Second finger',
  order: 70,
});

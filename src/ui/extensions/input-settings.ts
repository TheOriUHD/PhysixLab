// CM-A: Settings › Keyboard / Gamepad & axes / Touch.
import { registerCommand } from '../../app/registry/commands';
import { registerMenuEntry } from '../../app/registry/menus';
import { showInputSettings } from '../input/inputSettings';

registerCommand({
  id: 'settings.input',
  label: 'Settings: keyboard, gamepad & touch…',
  category: 'View',
  icon: 'keyboard',
  description: 'Rebind keys, choose a layout preset, tune gamepad axes and vehicle profiles',
  keywords: ['keybindings', 'rebind', 'controller', 'joystick', 'dead zone', 'preferences', 'controls'],
  run: ({ app }) => showInputSettings(app, 'keyboard'),
});
registerCommand({
  id: 'settings.gamepad',
  label: 'Settings: gamepad & axes…',
  category: 'View',
  icon: 'keyboard',
  keywords: ['controller', 'stick', 'trigger', 'dead zone', 'curve', 'vehicle profile'],
  palette: true,
  help: false,
  run: ({ app }) => showInputSettings(app, 'gamepad'),
});
registerMenuEntry({
  id: 'menu.view.inputSettings',
  menu: 'view',
  group: 'settings',
  order: 900,
  command: 'settings.input',
  icon: 'keyboard',
});
registerMenuEntry({
  id: 'menu.help.inputSettings',
  menu: 'help',
  group: 'help',
  order: 105,
  command: 'settings.input',
  icon: 'keyboard',
});

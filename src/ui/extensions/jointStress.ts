/** JT-11: the "Joint stress" overlay lives in the View menu (its command is registered with the other overlays). */
import { registerMenuEntry } from '../../app/registry/menus';

registerMenuEntry({
  id: 'menu.view.stress',
  menu: 'view',
  group: 'overlays',
  order: 260,
  command: 'view.overlay.stress',
});

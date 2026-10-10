// -- ED-B: Shift+A "Add menu…" command (ED-32) --
import { registerCommand } from '../../app/registry';
import { openAddMenu } from '../addMenu';

registerCommand({
  id: 'add.menu',
  label: 'Add menu…',
  category: 'Add',
  icon: 'plus',
  description: 'Search and add a shape, soft body, light, joint or prefab at the pointer',
  keywords: ['add', 'new', 'create', 'insert', 'search'],
  shortcut: 'Shift+A',
  allowWhileTyping: false,
  enabled: (app) => !app.sim.active,
  run: ({ app }) => openAddMenu(app),
});

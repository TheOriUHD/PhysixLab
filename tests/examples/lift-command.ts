// File: src/ui/extensions/lift-selection.ts   (files in src/ui/extensions are loaded at start-up, nothing to edit)
import { registerCommand, registerMenuEntry } from '../../src/app/registry';

registerCommand({
  id: 'demo.liftSelection',
  label: 'Lift selection by 1 m',
  category: 'Edit',
  icon: 'move',
  description: 'Raise the selected objects one metre',
  keywords: ['raise', 'up', 'elevate'],
  shortcut: 'Mod+Shift+U',
  enabled: (app) => app.store.selection.length > 0 && !app.sim.active,
  run: ({ app }) => app.editor.translate(app.store.selection, [0, 1, 0]),
});

// Optional: also list it in the Edit menu (group "select", after "Rotate selection 90° about Y").
registerMenuEntry({ id: 'menu.edit.lift', menu: 'edit', group: 'select', order: 335, command: 'demo.liftSelection' });

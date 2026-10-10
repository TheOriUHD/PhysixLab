// ── JT-21: "Connect all" — join the selected bodies with the joint tool's current type and options ──
import { registerCommand, registerMenuEntry } from '../../app/registry';
import { connectSelected } from '../../app/jointTool';

const selectedBodies = (app: Parameters<typeof connectSelected>[0]): number =>
  app.store.selection.filter((id) => !!app.store.body(id)).length;

registerCommand({
  id: 'joint.connectAll',
  label: 'Connect selected bodies with joints',
  category: 'Edit',
  icon: 'joint',
  description: 'Join the selected bodies in a chain, a star or all pairs with the joint tool’s type (one undo step)',
  keywords: ['joint', 'connect', 'chain', 'link', 'constraint'],
  enabled: (app) => !app.sim.active && selectedBodies(app) >= 2,
  run: ({ app }) => {
    connectSelected(app);
  },
});

registerMenuEntry({
  id: 'menu.edit.connectAll',
  menu: 'edit',
  group: 'select',
  order: 345,
  command: 'joint.connectAll',
});

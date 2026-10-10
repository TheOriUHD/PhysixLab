/** JT-B: collision / aerodynamics / mass / sleep inspector sections for bodies, and the "Wake all" command. */
import { registerCommand } from '../../app/registry/commands';
import { registerInspectorSection } from '../../app/registry/inspectorSections';
import { isBody } from '../../model/types';
import { bodyJtSections } from '../inspector/bodyJt';

registerInspectorSection({
  id: 'body-jt',
  order: 120, // right after the body panel (100)
  appliesTo: (selection) => selection.length > 0 && selection.every(isBody),
  build: (ctx, selection) => bodyJtSections(ctx, selection.filter(isBody)),
});

registerCommand({
  id: 'sim.wakeAll',
  label: 'Wake all bodies',
  description: 'Wake every sleeping body in the running simulation',
  category: 'Simulation',
  icon: 'zap',
  keywords: ['sleep', 'awake', 'wake'],
  enabled: (app) => app.sim.active,
  run: ({ app }) => app.sim.client.op({ op: 'wakeAll' }),
});

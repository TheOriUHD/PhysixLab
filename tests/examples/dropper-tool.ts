// File: src/ui/extensions/dropper-tool.ts
import { registerTool } from '../../src/app/registry';

registerTool({
  id: 'dropper',
  group: 'build',
  order: 65,
  label: 'Ball dropper',
  title: 'Drop a ball where you click',
  icon: 'sphere',
  shortcut: 'D',
  activate: (app) => app.setTool('dropper'),
  isActive: (app) => app.prefs.value.tool === 'dropper',
  // Called for a primary-button press in the viewport while this tool is the active mode.
  pointerDown: (app, e) => {
    const p = app.picker.groundPoint(e, 0);
    if (p) app.editor.addShape('sphere', [p.x, 2, p.z]);
  },
  hint: () => 'Click the ground to drop a ball from 2 m',
});

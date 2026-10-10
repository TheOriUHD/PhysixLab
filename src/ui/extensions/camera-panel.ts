// CM-A: the Camera panel and the camera buttons of the view bar.
import { registerPanel } from '../../app/registry/panels';
import { registerTool } from '../../app/registry/tools';
import { cameraModes } from '../../app/camera/modes';
import { cameraPanel } from '../camera/cameraPanel';

registerPanel(cameraPanel);

// The current mode on the view bar: a click cycles through the modes (V), the tooltip says what the mode does.
registerTool({
  id: 'cameraMode',
  region: 'viewbar',
  group: 'camera',
  order: 700,
  icon: 'camera',
  text: (app) => cameraModes.get(app.cameraRig.mode)?.label ?? 'Camera',
  title: 'Camera mode — click for the next one',
  command: 'camera.cycle',
});
registerTool({
  id: 'cameraOrtho',
  region: 'viewbar',
  group: 'camera',
  order: 710,
  icon: 'layers',
  title: 'Orthographic view on / off',
  command: 'camera.projection',
});

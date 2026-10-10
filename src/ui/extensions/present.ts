// -- UI-B: presentation / photo mode (UI-41): commands, menu entries and the Present panel --
import { registerCommand, registerMenuEntry, registerPanel } from '../../app/registry';
import { ENV_PRESETS } from '../../render/envPresets';
import { CAMERA_PRESETS, CAPTURE_SCALES, DOF_PRESETS, matchDofPreset } from '../present/model';
import { presentPanel } from '../present/panel';
import { getPresenter } from '../present/presenter';

registerCommand({
  id: 'present.toggle',
  label: 'Presentation mode',
  category: 'Presentation',
  icon: 'frame',
  description: 'Hide the whole interface for screenshots and talks (Esc brings it back)',
  keywords: ['photo', 'hide ui', 'fullscreen', 'clean', 'present'],
  shortcut: 'F10',
  // F10 types nothing, so it also works while a caption field has focus.
  allowWhileTyping: true,
  checked: (app) => getPresenter(app).active,
  run: ({ app }) => getPresenter(app).toggle(),
});

for (const scale of CAPTURE_SCALES) {
  registerCommand({
    id: `present.capture${scale}x`,
    label: `Save image ${scale}×`,
    category: 'Presentation',
    icon: 'camera',
    description: `Save the viewport as a PNG at ${scale}× its size, without the interface`,
    keywords: ['screenshot', 'photo', 'png', 'export image', 'capture'],
    run: ({ app }) => void getPresenter(app).captureAndDownload(scale),
  });
}

registerCommand({
  id: 'present.turntable',
  label: 'Turntable',
  category: 'Presentation',
  icon: 'rotate',
  setting: true,
  description: 'Slowly turn the camera around the view target',
  keywords: ['orbit', 'spin', 'rotate camera', 'auto orbit'],
  checked: (app) => getPresenter(app).turning,
  run: ({ app }) => getPresenter(app).setTurntable(!getPresenter(app).turning),
});

registerCommand({
  id: 'present.orbitSelection',
  label: 'Orbit around selection',
  category: 'Presentation',
  icon: 'follow',
  description: 'Fly to the selection (or the scene) and turn around it',
  keywords: ['turntable', 'spin'],
  run: ({ app }) => getPresenter(app).orbitSelection(),
});

for (const c of CAMERA_PRESETS) {
  registerCommand({
    id: `present.camera.${c.id}`,
    label: `Camera: ${c.label}`,
    category: 'Presentation',
    icon: 'camera',
    keywords: ['view', 'angle', 'preset'],
    run: ({ app }) => getPresenter(app).cameraPreset(c.id),
  });
}

for (const l of ENV_PRESETS) {
  registerCommand({
    id: `present.light.${l.id}`,
    label: `Lighting: ${l.label}`,
    category: 'Presentation',
    description: 'Set the scene environment (sky, sun, image-based light)',
    keywords: ['light', 'sky', 'environment', 'mood', 'sun'],
    checked: (app) => app.store.settings.environment.sky === l.id,
    run: ({ app }) => getPresenter(app).setEnvironment(l.id),
  });
}

for (const d of DOF_PRESETS) {
  registerCommand({
    id: `present.dof.${d.id}`,
    label: `Depth of field: ${d.label}`,
    category: 'Presentation',
    description: d.blurb,
    keywords: ['blur', 'focus', 'bokeh', 'aperture'],
    checked: (app) => matchDofPreset(app.prefs.value.graphics.dof) === d.id,
    run: ({ app }) => getPresenter(app).setDof(d.id),
  });
}

registerPanel(presentPanel);

registerMenuEntry({
  id: 'menu.view.present',
  menu: 'view',
  group: 'present',
  order: 600,
  command: 'present.toggle',
  icon: 'frame',
});
registerMenuEntry({
  id: 'menu.view.presentCapture',
  menu: 'view',
  group: 'present',
  order: 610,
  command: 'present.capture2x',
  icon: 'camera',
});

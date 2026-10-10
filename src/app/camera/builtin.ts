/** The built-in camera modes, held camera actions and camera commands (registered once, by `registerCameraBuiltins`). */
import { Vector3 } from 'three';
import type { CameraBookmark } from '../../model/types';
import type { App } from '../app';
import { uid } from '../../model/factory';
import { inputMap } from '../input/inputMap';
import { registerCommand } from '../registry/commands';
import { registerMenuEntry } from '../registry/menus';
import { registerCameraMode } from './modes';
import type { ViewPreset } from './rig';

let done = false;

export function registerCameraBuiltins(): void {
  if (done) return;
  done = true;

  // ---- held actions (rebindable in Settings › Keyboard) --------------------------------------
  const flyKeys: [string, string, string[]][] = [
    ['forward', 'Fly forward', ['W']],
    ['back', 'Fly back', ['S']],
    ['left', 'Fly left', ['A']],
    ['right', 'Fly right', ['D']],
    ['up', 'Fly up', ['E']],
    ['down', 'Fly down', ['Q']],
    ['boost', 'Fly faster (hold)', ['ShiftLeft', 'ShiftRight']],
  ];
  for (const [id, label, shortcuts] of flyKeys)
    inputMap.registerAction({ id: `camera.fly.${id}`, label, category: 'Camera', shortcuts, scope: 'fly' });
  inputMap.registerAction({
    id: 'camera.chase.lookBehind',
    label: 'Chase camera: look behind (hold)',
    category: 'Camera',
    shortcuts: ['B'],
    scope: 'chase',
  });

  // ---- modes ----------------------------------------------------------------------------------
  registerCameraMode({
    id: 'orbit',
    label: 'Orbit',
    icon: 'camera',
    order: 10,
    driven: false,
    blurb: 'Orbit, pan and zoom around what you are looking at (right-drag, middle-drag, wheel).',
  });
  registerCameraMode({
    id: 'point',
    label: 'Orbit point',
    icon: 'frame',
    order: 20,
    driven: false,
    blurb: 'Orbit a fixed point in space: double-click anywhere to pick a new centre, zoom keeps it.',
    enter(rig) {
      rig.pivot.copy(rig.app.viewport.controls.target);
      rig.app.viewport.controls.enablePan = false;
      rig.app.viewport.controls.zoomToCursor = false;
      rig.app.setHint('<b>Orbit point</b> — double-click to move the centre · right-drag orbits · wheel zooms');
    },
    exit(rig) {
      rig.app.viewport.controls.zoomToCursor = true;
      rig.app.updateToolHint();
    },
  });
  registerCameraMode({
    id: 'top',
    label: 'Top-down',
    icon: 'map',
    order: 30,
    driven: false,
    blurb:
      'Straight down onto the scene: drag to pan, wheel to zoom. Follows the selection when “Camera follows selection” is on.',
    enter(rig) {
      const vp = rig.app.viewport;
      const c = vp.controls;
      const target = c.target.clone();
      const h = Math.max(14, rig.app.camera.position.distanceTo(target));
      c.enableRotate = false;
      c.minPolarAngle = 0;
      c.maxPolarAngle = 0;
      // Left-drag stays selection; right-drag pans in this mode (rotating is locked).
      rig.glide(target.clone().add(new Vector3(0, h, 0.0001)), target);
    },
  });
  registerCameraMode({
    id: 'fly',
    label: 'Fly',
    icon: 'follow',
    order: 40,
    driven: true,
    blurb: 'Free flight: W A S D move, Q / E down / up, Shift to go faster, right-drag to look, wheel sets the speed.',
    shortcut: undefined,
    enter(rig) {
      const cam = rig.app.camera;
      const f = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      rig.fly.position.copy(cam.position);
      rig.fly.velocity.set(0, 0, 0);
      rig.fly.yaw = Math.atan2(f.x, f.z);
      rig.fly.pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
    },
    pose: (rig, dt, out) => rig.stepFly(dt, out),
  });
  registerCameraMode({
    id: 'fp',
    label: 'First person',
    icon: 'eye',
    order: 50,
    driven: true,
    needsSubject: true,
    blurb: 'Look through the selected body (a car, a character, a sensor). Right-drag looks around.',
    pose: (rig, _dt, out) => rig.stepFirstPerson(out),
  });
  registerCameraMode({
    id: 'tp',
    label: 'Third person',
    icon: 'sphere',
    order: 60,
    driven: true,
    needsSubject: true,
    blurb:
      'A spring-arm camera behind the selected body that shortens when something is in the way. Right-drag swings it, wheel zooms.',
    pose: (rig, dt, out) => rig.stepThirdPerson(dt, out),
  });
  registerCameraMode({
    id: 'chase',
    label: 'Chase',
    icon: 'car',
    order: 70,
    driven: true,
    needsSubject: true,
    blurb: 'Behind the direction of travel, wider lens at speed; hold B to look behind. Made for vehicles.',
    pose: (rig, dt, out) => rig.stepChase(dt, out),
  });

  // ---- commands -------------------------------------------------------------------------------
  registerCommand({
    id: 'camera.cycle',
    label: 'Camera: next mode',
    category: 'Camera',
    icon: 'camera',
    shortcut: 'V',
    keywords: ['switch', 'view', 'fly', 'chase'],
    run: ({ app }) => app.cameraRig.cycleMode(1),
  });
  registerCommand({
    id: 'camera.cyclePrev',
    label: 'Camera: previous mode',
    category: 'Camera',
    shortcut: 'Shift+V',
    help: false,
    run: ({ app }) => app.cameraRig.cycleMode(-1),
  });
  registerCommand({
    id: 'camera.projection',
    label: 'Camera: perspective / orthographic',
    category: 'Camera',
    icon: 'layers',
    shortcut: 'Numpad5',
    description: 'Switch between perspective and orthographic projection',
    keywords: ['ortho', 'parallel', 'cad'],
    checked: (app) => app.cameraRig.ortho,
    run: ({ app }) => app.cameraRig.setOrtho(!app.cameraRig.ortho),
  });
  const presets: [ViewPreset, string, string][] = [
    ['front', 'Front', 'Numpad1'],
    ['back', 'Back', 'Mod+Numpad1'],
    ['right', 'Right', 'Numpad3'],
    ['left', 'Left', 'Mod+Numpad3'],
    ['top', 'Top', 'Numpad7'],
    ['bottom', 'Bottom', 'Mod+Numpad7'],
    ['iso', 'Isometric', 'Numpad9'],
  ];
  for (const [id, label, shortcut] of presets)
    registerCommand({
      id: `camera.view.${id}`,
      label: `Orthographic view: ${label}`,
      category: 'Camera',
      icon: 'layers',
      shortcut,
      keywords: ['ortho', 'cad', 'elevation', 'plan', label.toLowerCase()],
      checked: (app) => app.cameraRig.ortho && app.cameraRig.preset === id,
      run: ({ app }) => app.cameraRig.viewPreset(id),
    });
  registerCommand({
    id: 'camera.pin',
    label: 'Camera: pin the selected body as the subject',
    category: 'Camera',
    icon: 'lock',
    description:
      'First-person, third-person and chase cameras keep following this body even when the selection changes',
    checked: (app) => !!app.cameraRig.pinned,
    run: ({ app }) => {
      const rig = app.cameraRig;
      if (rig.pinned) rig.pin(null);
      else {
        const id = app.store.selection.find((s) => app.store.body(s));
        if (id) rig.pin(id);
        else app.toast('Select a body to pin as the camera subject', 'warn');
      }
    },
  });

  // Bookmarks: Ctrl+Shift+1…9 saves the current view into slot N, Shift+1…9 recalls it (plain 1…9 add shapes).
  for (let n = 1; n <= 9; n++) {
    registerCommand({
      id: `camera.bookmark.save.${n}`,
      label: `Save view to bookmark ${n}`,
      category: 'Camera',
      shortcut: `Mod+Shift+Digit${n}`,
      help: n === 1,
      palette: n <= 3,
      run: ({ app }) => void saveBookmarkSlot(app, n - 1),
    });
    registerCommand({
      id: `camera.bookmark.recall.${n}`,
      label: `Go to bookmark ${n}`,
      category: 'Camera',
      shortcut: `Shift+Digit${n}`,
      help: n === 1,
      palette: n <= 3,
      enabled: (app) => !!app.store.cameras.bookmarks[n - 1],
      run: ({ app }) => {
        const b = app.store.cameras.bookmarks[n - 1];
        if (b) app.cameraRig.recall(b);
      },
    });
  }
  registerCommand({
    id: 'camera.minimap',
    label: 'Camera: minimap',
    category: 'Camera',
    icon: 'map',
    shortcut: 'Shift+N',
    description: 'A live top-down map in the corner of the viewport: click it to move the camera',
    keywords: ['map', 'overview', 'radar'],
    checked: (app) => app.store.cameras.minimap.enabled,
    run: ({ app }) => {
      const c = app.store.cameras;
      app.store.setCameras({ ...c, minimap: { ...c.minimap, enabled: !c.minimap.enabled } }, 'Toggle minimap');
    },
  });
  registerMenuEntry({ id: 'menu.view.cameraMode', menu: 'view', group: 'camera', order: 400, command: 'camera.cycle' });
  registerMenuEntry({
    id: 'menu.view.cameraProjection',
    menu: 'view',
    group: 'camera',
    order: 410,
    command: 'camera.projection',
  });
}

/** Save the current view into bookmark slot `index` (replacing it, or appending when it is the next free slot). */
export async function saveBookmarkSlot(app: App, index: number): Promise<void> {
  const list = app.store.cameras.bookmarks;
  const view = app.cameraRig.currentView();
  const thumb = await app.viewport.captureThumbnail(160, 100);
  const prev = list[index];
  const mk: CameraBookmark = {
    id: prev?.id ?? uid('cb'),
    name: prev?.name ?? `View ${index + 1}`,
    ...view,
    ...(thumb ? { thumb } : {}),
  };
  const next = list.slice();
  if (index >= next.length) next.push(mk);
  else next[index] = mk;
  app.store.setCameras({ ...app.store.cameras, bookmarks: next.slice(0, 64) }, 'Save camera bookmark');
  app.toast(`View saved as bookmark ${Math.min(index, list.length) + 1}`, 'success');
}

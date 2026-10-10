/**
 * The camera-mode registry. A mode is either *orbit based* (the orbit controls stay in charge, the mode only
 * constrains them: orbit, orbit-around-a-point, top-down) or *driven* (the rig sets the camera pose every frame from
 * a `pose()` function: fly, first person, third person, chase). Registering a mode also registers the command
 * `camera.mode.<id>`, so the palette, the menus and a shortcut come for free.
 */
import { Registry } from '../../core/registry';
import { registerCommand } from '../registry/commands';
import type { CameraRig } from './rig';
import type { Pose } from './poses';

export interface CameraModeDef {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  order: number;
  /** The rig computes the pose every frame (`pose`), the orbit controls are off. */
  driven: boolean;
  /** Needs a body to look through / follow (the selected one unless one is pinned). */
  needsSubject?: boolean;
  shortcut?: string | readonly string[];
  /** Mouse wheel changes the fly speed / follow distance instead of zooming. */
  hint?: string;
  enter?(rig: CameraRig, from: string): void;
  exit?(rig: CameraRig, to: string): void;
  /** Driven modes: fill `out`; return false when the mode cannot run (no subject). */
  pose?(rig: CameraRig, dt: number, out: Pose): boolean;
}

export const cameraModes = new Registry<CameraModeDef>({
  kind: 'camera mode',
  order: (m) => m.order,
  validate(m) {
    if (m.driven && !m.pose) throw new Error(`camera mode "${m.id}" is driven and needs a pose() function`);
  },
});

/** Register a mode and its command; returns the function that removes both. */
export function registerCameraMode(def: CameraModeDef): () => void {
  const off = cameraModes.register(def);
  let offCmd: () => void;
  try {
    offCmd = registerCommand({
      id: `camera.mode.${def.id}`,
      label: `Camera: ${def.label}`,
      category: 'Camera',
      icon: def.icon,
      description: def.blurb,
      keywords: ['view', 'camera', 'mode', def.label.toLowerCase()],
      shortcut: def.shortcut,
      checked: (app) => app.cameraRig.mode === def.id,
      run: ({ app }) => void app.cameraRig.setMode(def.id),
    });
  } catch (e) {
    off();
    throw e;
  }
  return () => {
    offCmd();
    off();
  };
}

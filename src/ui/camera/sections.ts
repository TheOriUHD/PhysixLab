/** Sections of the Camera panel: each file registers its own, so packages extend the panel without editing it. */
import { Registry } from '../../core/registry';
import type { App } from '../../app/app';

export interface CameraSectionDef {
  id: string;
  order: number;
  /** Build the section's element; `refresh` is called when the camera state, the selection or the document changed. */
  build: (app: App) => { el: HTMLElement; refresh?: () => void };
}

export const cameraSections = new Registry<CameraSectionDef>({ kind: 'camera section', order: (s) => s.order });
export const registerCameraSection = (def: CameraSectionDef): (() => void) => cameraSections.register(def);

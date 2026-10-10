/** Types shared by `App` and its collaborators (kept apart so the collaborators never import `app.ts` for values). */
import type { Vector3 } from 'three';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

// -- UI-B: where a loaded scene came from --
export type SceneSource = { kind: 'template' | 'map' | 'library'; id: string } | { kind: 'file' | 'paste' };
export interface SceneLoaded {
  source?: SceneSource;
  name: string;
  bodies: number;
}

export interface AppEvents extends Record<string, unknown> {
  toast: { text: string; kind: ToastKind };
  hint: string | null;
  frame: { dt: number };
  view: undefined;
  scene: undefined;
  jointEnd: 'A' | 'B';
  /** The path control point being edited changed (FB-6). */
  pathPoint: undefined;
  // -- UI-B: a whole scene was opened (recent scenes, thumbnails) --
  sceneLoaded: SceneLoaded;
}

export interface Shell {
  viewportHost: HTMLElement;
  stage: HTMLElement;
}

/** An in-progress or finished measurement between two world points. */
export interface Measurement {
  a: Vector3;
  b: Vector3 | null;
}

/** The first end of a joint being drawn with the joint tool (a body, or null for the world). */
export interface JointDraft {
  body: string | null;
  point: Vector3;
}

/** A control point of a path that the transform gizmo is editing. */
export interface PathPointRef {
  id: string;
  index: number;
}

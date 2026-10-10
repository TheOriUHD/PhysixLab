/** Types shared by `App` and its collaborators (kept apart so the collaborators never import `app.ts` for values). */
import type { Vector3 } from 'three';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface AppEvents extends Record<string, unknown> {
  toast: { text: string; kind: ToastKind };
  hint: string | null;
  frame: { dt: number };
  view: undefined;
  scene: undefined;
  jointEnd: 'A' | 'B';
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

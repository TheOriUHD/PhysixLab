/** Touch support entry point: gestures on the canvas + the on-screen controls (CM-12). */
import type { App } from '../../app/app';
import type { InputController } from '../../app/input';
import { TouchGestures } from '../../app/touch/touchController';
import { mountTouchOverlay, isTouchDevice } from './overlay';

export function mountTouch(app: App, input: InputController): void {
  new TouchGestures(app, input);
  mountTouchOverlay(app);
  // Bigger gizmo handles under a finger.
  if (isTouchDevice()) app.gizmo.controls.size = 1.2;
}

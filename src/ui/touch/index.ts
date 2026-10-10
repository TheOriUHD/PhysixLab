/** Touch support entry point: gestures on the canvas, the on-screen controls (CM-12) and the mobile layout (CM-13). */
import type { App } from '../../app/app';
import type { InputController } from '../../app/input';
import { TouchGestures } from '../../app/touch/touchController';
import { mountMobileLayout } from '../mobile/layout';
import { mountTouchOverlay, isTouchDevice } from './overlay';

export function mountTouch(app: App, input: InputController): void {
  new TouchGestures(app, input);
  mountTouchOverlay(app);
  // The responsive layout (drawers, bottom navigation) is part of the same touch package.
  mountMobileLayout(app, document.getElementById('app') ?? document.body);
  // Bigger gizmo handles under a finger.
  if (isTouchDevice()) app.gizmo.controls.size = 1.2;
}

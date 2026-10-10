/**
 * One camera object that is either perspective or orthographic. Everything in the app (renderer passes, picking,
 * the orbit controls, the view helper, labels) holds a reference to `viewport.camera`; switching projection by
 * swapping objects would invalidate all of them, so the projection itself is what changes. Three.js and
 * OrbitControls tell the two apart through `isPerspectiveCamera` / `isOrthographicCamera`, which follow `ortho`.
 */
import { PerspectiveCamera } from 'three';

export class DualCamera extends PerspectiveCamera {
  ortho = false;
  /** Visible height in metres at `zoom` 1 (orthographic only; the orbit controls change `zoom`). */
  orthoSize = 12;
  // Used by OrbitControls when panning an orthographic view.
  left = -1;
  right = 1;
  top = 1;
  bottom = -1;

  updateProjectionMatrix(): void {
    if (!this.ortho) {
      super.updateProjectionMatrix();
      return;
    }
    // left / right / top / bottom are the *unzoomed* extents: OrbitControls divides them by `zoom` when it pans.
    const halfH = this.orthoSize / 2;
    const halfW = halfH * this.aspect;
    this.left = -halfW;
    this.right = halfW;
    this.top = halfH;
    this.bottom = -halfH;
    const z = Math.max(1e-6, this.zoom);
    this.projectionMatrix.makeOrthographic(-halfW / z, halfW / z, halfH / z, -halfH / z, this.near, this.far);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}

// The base constructor assigns `isPerspectiveCamera = true`; an accessor with a no-op setter lets that pass and
// answers from the current projection afterwards.
Object.defineProperty(DualCamera.prototype, 'isPerspectiveCamera', {
  get(this: DualCamera) {
    return !this.ortho;
  },
  set() {
    /* derived from `ortho` */
  },
  configurable: true,
});
Object.defineProperty(DualCamera.prototype, 'isOrthographicCamera', {
  get(this: DualCamera) {
    return this.ortho;
  },
  set() {
    /* derived from `ortho` */
  },
  configurable: true,
});

/**
 * Renders the scene from another camera into a 2D canvas, for split-screen panes and picture-in-picture windows.
 * The scene is drawn into an off-screen target with the viewport's renderer (so it shares every GPU resource with the
 * main view), tone-mapped to display colours with the same output pass the main view ends with, and read back into
 * the canvas. The canvas is upside down after the read-back: the element is flipped with CSS.
 */
import { HalfFloatType, UnsignedByteType, WebGLRenderTarget, type Camera } from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Viewport } from './viewport';

export class PaneRenderer {
  private scene: WebGLRenderTarget | null = null;
  private out: WebGLRenderTarget | null = null;
  private image: ImageData | null = null;
  private pass = new OutputPass();
  private w = 0;
  private h = 0;

  constructor(private viewport: Viewport) {}

  private ensure(w: number, h: number): void {
    if (this.scene && this.w === w && this.h === h) return;
    this.dispose();
    this.w = w;
    this.h = h;
    this.scene = new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 0 });
    this.out = new WebGLRenderTarget(w, h, { type: UnsignedByteType, depthBuffer: false });
    this.image = new ImageData(w, h);
  }

  /** Draw `camera`'s view into `canvas` (whose pixel size is `w` × `h`). */
  render(camera: Camera, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number): void {
    this.ensure(w, h);
    if (!this.scene || !this.out || !this.image) return;
    const renderer = this.viewport.renderer;
    this.viewport.renderView(camera, this.scene);
    this.pass.render(renderer, this.out, this.scene, 0, false);
    renderer.setRenderTarget(null);
    renderer.readRenderTargetPixels(this.out, 0, 0, w, h, this.image.data);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.putImageData(this.image, 0, 0);
  }

  dispose(): void {
    this.scene?.dispose();
    this.out?.dispose();
    this.scene = this.out = null;
    this.image = null;
    this.w = this.h = 0;
  }
}

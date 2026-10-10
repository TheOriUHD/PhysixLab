/**
 * Still images of the viewport: the PNG export (any size up to 4K, optional transparent background) and
 * `renderThumbnail(app, size)` for share previews and restore-point thumbnails.
 *
 * The scene is rendered with the viewport's own WebGL renderer, camera position and lights, but straight to the
 * canvas without the editor post-processing (selection outline, ambient occlusion) and without overlays / helpers,
 * so the picture shows the scene and not the editor. The canvas is resized for the capture and restored in the same
 * task, before the browser paints, so the user sees nothing happen. Output is copied to a 2D canvas for encoding.
 *
 * Transparency: the renderer's canvas has no alpha channel, so the scene (without sky and ground slab) is rendered
 * twice, over black and over white, and the alpha is recovered per pixel from the difference ("difference
 * matting"). That is exact for opaque and for translucent surfaces; the ground's soft shadow is kept.
 * The main renderer is not anti-aliased, so images up to 2560 px are rendered at twice the size and averaged down.
 */
import { Color, type PerspectiveCamera, type Object3D } from 'three';
import type { App } from '../app';

export const MAX_IMAGE_EDGE = 3840;
export const MIN_IMAGE_EDGE = 16;

export interface ImageOptions {
  width: number;
  height: number;
  /** Render without sky and ground slab and with an alpha channel (PNG only). */
  transparent?: boolean;
  /** `image/png` (default) or `image/jpeg`. JPEG cannot be transparent. */
  mime?: 'image/png' | 'image/jpeg';
  /** JPEG quality 0..1. */
  quality?: number;
  /** Keep the editor helpers (light gizmos, labels, trails …) in the picture. Default false. */
  helpers?: boolean;
}

export class ImageExportError extends Error {}

/** Width and height that fit `edge` pixels on the longer side and keep the aspect ratio `w:h`. */
export function fitEdge(aspect: number, edge: number): { width: number; height: number } {
  const e = Math.round(Math.min(MAX_IMAGE_EDGE, Math.max(MIN_IMAGE_EDGE, edge)));
  return aspect >= 1
    ? { width: e, height: Math.max(1, Math.round(e / aspect)) }
    : { width: Math.max(1, Math.round(e * aspect)), height: e };
}

function make2d(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ImageExportError('This browser cannot create a 2D canvas for the image.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

const toBlob = (canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new ImageExportError('The browser could not encode the image.'))),
      mime,
      quality,
    ),
  );

/**
 * Render the live scene into a canvas of exactly `width` x `height` (ready for `toBlob` / `toDataURL`).
 * Only call from the main thread while no other capture is running.
 */
export function renderToCanvas(app: App, o: ImageOptions): HTMLCanvasElement {
  const vp = app.viewport;
  const r = vp.renderer;
  const width = Math.round(o.width);
  const height = Math.round(o.height);
  if (!(width >= 1 && height >= 1) || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw new ImageExportError(`Image size must be between 1 and ${MAX_IMAGE_EDGE} px per side.`);
  }
  const maxTex = r.capabilities.maxTextureSize;
  let ss = Math.max(width, height) <= 2560 ? 2 : 1;
  while (ss > 1 && Math.max(width, height) * ss > Math.min(maxTex, 8192)) ss--;
  if (Math.max(width, height) > maxTex) {
    throw new ImageExportError(`This graphics card supports images up to ${maxTex} px per side.`);
  }

  const parts = vp.captureParts();
  const hide: Object3D[] = [parts.grid];
  if (!o.helpers) hide.push(vp.overlays, vp.helpers);
  if (o.transparent) hide.push(parts.sky, parts.slab);
  const saved = hide.map((obj) => obj.visible);
  const prevFog = vp.scene.fog;
  const prevRatio = r.getPixelRatio();
  const prevClear = r.getClearColor(new Color());
  const prevAlpha = r.getClearAlpha();
  const cssW = Math.max(1, vp.container.clientWidth);
  const cssH = Math.max(1, vp.container.clientHeight);

  const cam: PerspectiveCamera = vp.camera.clone();
  cam.aspect = width / height;
  cam.updateProjectionMatrix();

  const out = make2d(width, height);
  try {
    hide.forEach((obj) => (obj.visible = false));
    if (o.transparent) vp.scene.fog = null;
    r.setPixelRatio(1);
    r.setSize(width * ss, height * ss, false);

    const pass = (clear: number): void => {
      r.setClearColor(clear, 1);
      r.render(vp.scene, cam);
    };
    if (!o.transparent) {
      pass(0x000000);
      out.ctx.drawImage(r.domElement, 0, 0, width, height);
    } else {
      const grab = (clear: number): ImageData => {
        pass(clear);
        out.ctx.clearRect(0, 0, width, height);
        out.ctx.drawImage(r.domElement, 0, 0, width, height);
        return out.ctx.getImageData(0, 0, width, height);
      };
      const dark = grab(0x000000);
      const light = grab(0xffffff);
      const d = dark.data;
      const l = light.data;
      for (let i = 0; i < d.length; i += 4) {
        const diff = (l[i] - d[i] + (l[i + 1] - d[i + 1]) + (l[i + 2] - d[i + 2])) / 3;
        const a = Math.min(1, Math.max(0, 1 - diff / 255));
        if (a <= 0.002) {
          d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
        } else {
          d[i] = Math.min(255, d[i] / a);
          d[i + 1] = Math.min(255, d[i + 1] / a);
          d[i + 2] = Math.min(255, d[i + 2] / a);
          d[i + 3] = Math.round(a * 255);
        }
      }
      out.ctx.putImageData(dark, 0, 0);
    }
  } finally {
    hide.forEach((obj, i) => (obj.visible = saved[i]));
    vp.scene.fog = prevFog;
    r.setClearColor(prevClear, prevAlpha);
    r.setPixelRatio(prevRatio);
    r.setSize(cssW, cssH, false);
    vp.needsRender = true;
  }
  return out.canvas;
}

/** Encode a viewport picture. */
export async function renderImage(app: App, o: ImageOptions): Promise<Blob> {
  const mime = o.mime ?? 'image/png';
  const canvas = renderToCanvas(app, { ...o, transparent: mime === 'image/png' && o.transparent });
  return toBlob(canvas, mime, o.quality);
}

export interface ThumbnailOptions {
  /** `image/png` (default) or the smaller `image/jpeg`. */
  mime?: 'image/png' | 'image/jpeg';
  quality?: number;
  transparent?: boolean;
}

/**
 * A small picture of the scene for share previews and restore points: `size` pixels on the longer side, the shape of
 * the viewport, editor overlays left out. Does not disturb what the user sees.
 */
export function renderThumbnail(app: App, size: number, o: ThumbnailOptions = {}): Promise<Blob> {
  const vp = app.viewport;
  const aspect = Math.max(1, vp.container.clientWidth) / Math.max(1, vp.container.clientHeight);
  const { width, height } = fitEdge(aspect, size);
  return renderImage(app, { width, height, mime: o.mime, quality: o.quality, transparent: o.transparent });
}

/** Same picture as a `data:` URL (for storing in a document or an `<img>`). */
export function renderThumbnailDataUrl(app: App, size: number, o: ThumbnailOptions = {}): string {
  const vp = app.viewport;
  const aspect = Math.max(1, vp.container.clientWidth) / Math.max(1, vp.container.clientHeight);
  const { width, height } = fitEdge(aspect, size);
  const mime = o.mime ?? 'image/png';
  return renderToCanvas(app, { width, height, transparent: mime === 'image/png' && o.transparent }).toDataURL(
    mime,
    o.quality,
  );
}

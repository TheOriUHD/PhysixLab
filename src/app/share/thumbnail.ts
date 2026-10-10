/**
 * Viewport thumbnail and "copy image + link" (DT-21).
 *
 * The WebGL canvas is created without `preserveDrawingBuffer`, so its pixels are only readable until the frame is
 * presented. `requestAnimationFrame` callbacks run in registration order and the viewport's loop re-registers at
 * the start of every frame, so a callback registered from outside runs right after that frame was rendered and
 * before the browser clears the buffer: drawing the canvas into a 2D canvas there reads what the user sees.
 */
import type { App } from '../app';

export interface Thumbnail {
  blob: Blob;
  width: number;
  height: number;
}

/** PNG of the current viewport, scaled so its longer side is at most `maxSide` px. Null when nothing could be captured. */
export function captureThumbnail(app: App, maxSide = 640): Promise<Thumbnail | null> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const src = app.viewport.dom;
      if (!src.width || !src.height) return resolve(null);
      const k = Math.min(1, maxSide / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * k));
      const h = Math.max(1, Math.round(src.height * k));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, w, h);
      canvas.toBlob((blob) => resolve(blob ? { blob, width: w, height: h } : null), 'image/png');
    });
  });
}

/** What `copyImageAndLink` managed to put on the clipboard. */
export type CopyResult = 'image+link' | 'link' | 'none';

interface ClipboardLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ClipboardItem[] in the DOM lib; the constructor is injected, so the items are opaque here
  write?: (items: any[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}
type ClipboardItemCtor = new (items: Record<string, Blob>) => unknown;

/**
 * Puts the PNG and the link on the clipboard as one item (`image/png` + `text/plain`), which chat apps and editors
 * paste as a picture with its link. Browsers without `ClipboardItem` (or that refuse image writes) get the link
 * alone: the result says which, so the UI never claims more than happened.
 */
export async function copyImageAndLink(
  image: Blob | null,
  url: string,
  clipboard: ClipboardLike | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard,
  Item: ClipboardItemCtor | undefined = (globalThis as { ClipboardItem?: ClipboardItemCtor }).ClipboardItem,
): Promise<CopyResult> {
  if (image && clipboard?.write && Item) {
    try {
      await clipboard.write([new Item({ 'image/png': image, 'text/plain': new Blob([url], { type: 'text/plain' }) })]);
      return 'image+link';
    } catch {
      /* some browsers accept image/png only, or refuse without a gesture: fall through to the link */
    }
    try {
      await clipboard.write([new Item({ 'text/plain': new Blob([url], { type: 'text/plain' }) })]);
      return 'link';
    } catch {
      /* fall through */
    }
  }
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(url);
      return 'link';
    } catch {
      /* fall through */
    }
  }
  return 'none';
}

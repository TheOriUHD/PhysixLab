import type { Viewport } from '../../render/viewport';

/**
 * A small PNG data URL of the next rendered frame (longest side `maxSide` px). Resolves undefined when the canvas
 * cannot be read or nothing renders within a second (hidden tab).
 */
export function captureThumbnail(viewport: Viewport, maxSide = 240): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      viewport.afterRender = null;
      resolve(undefined);
    }, 1000);
    viewport.afterRender = () => {
      clearTimeout(timeout);
      try {
        const src = viewport.dom;
        const k = Math.min(1, maxSide / Math.max(src.width, src.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(src.width * k));
        c.height = Math.max(1, Math.round(src.height * k));
        c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch {
        resolve(undefined);
      }
    };
  });
}

import type { Viewport } from '../../render/viewport';

/**
 * A small PNG data URL of the next rendered frame (longest side `maxSide` px). Uses the viewport's `afterRender` hook
 * (the canvas has no preserved drawing buffer, so pixels can only be read right after a frame is drawn) and puts the
 * previous hook back. Resolves undefined when the canvas cannot be read or nothing renders within a second.
 */
export function captureThumbnail(viewport: Viewport, maxSide = 240): Promise<string | undefined> {
  return new Promise((resolve) => {
    const prev = viewport.afterRender;
    const done = (v: string | undefined) => {
      clearTimeout(timeout);
      if (viewport.afterRender === hook) viewport.afterRender = prev;
      resolve(v);
    };
    const hook = (src: HTMLCanvasElement) => {
      prev?.(src);
      try {
        const k = Math.min(1, maxSide / Math.max(src.width, src.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(src.width * k));
        c.height = Math.max(1, Math.round(src.height * k));
        c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
        done(c.toDataURL('image/png'));
      } catch {
        done(undefined);
      }
    };
    const timeout = setTimeout(() => done(undefined), 1000);
    viewport.afterRender = hook;
  });
}

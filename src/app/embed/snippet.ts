/** The iframe snippet the Embed dialog generates (DT-22). Pure, so it is unit tested and the dialog just displays it. */

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface SnippetOptions {
  url: string;
  width: number;
  height: number;
  title?: string;
}

/** Clamp a pixel size to something an iframe can show. */
export const clampPx = (n: number, fallback: number): number =>
  Number.isFinite(n) ? Math.max(120, Math.min(4000, Math.round(n))) : fallback;

export function buildIframeSnippet(o: SnippetOptions): string {
  const w = clampPx(o.width, 640);
  const h = clampPx(o.height, 400);
  return (
    `<iframe src="${escapeAttr(o.url)}" width="${w}" height="${h}" style="border:0;max-width:100%" ` +
    `title="${escapeAttr(o.title ?? 'PhysixLab simulation')}" loading="lazy" allow="fullscreen" allowfullscreen></iframe>`
  );
}

/**
 * Open Graph / Twitter card metadata template for hosts that can render link previews (DT-21). A static page cannot
 * serve per-scene previews by itself (the scene lives in the URL fragment, which servers never see), so this builds
 * the `<meta>` tags a host would put in its own landing page for a scene; docs/EMBED.md explains the setup.
 */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface OpenGraphInput {
  title: string;
  description?: string;
  /** The page the preview links to (the share link or the viewer URL). */
  url: string;
  /** Absolute URL of the preview image (the thumbnail PNG, uploaded by the host). */
  imageUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  siteName?: string;
}

export function buildOpenGraphTags(i: OpenGraphInput): string {
  const lines = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(i.siteName ?? 'PhysixLab')}">`,
    `<meta property="og:title" content="${esc(i.title)}">`,
    `<meta property="og:description" content="${esc(i.description ?? 'An interactive physics scene - open the link to play with it.')}">`,
    `<meta property="og:url" content="${esc(i.url)}">`,
    `<meta property="og:image" content="${esc(i.imageUrl)}">`,
    `<meta property="og:image:type" content="image/png">`,
  ];
  if (i.imageWidth && i.imageHeight)
    lines.push(
      `<meta property="og:image:width" content="${Math.round(i.imageWidth)}">`,
      `<meta property="og:image:height" content="${Math.round(i.imageHeight)}">`,
    );
  lines.push(
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(i.title)}">`,
    `<meta name="twitter:image" content="${esc(i.imageUrl)}">`,
  );
  return lines.join('\n');
}

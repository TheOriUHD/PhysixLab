/**
 * Embed / viewer mode options (DT-22). Pure: parsed from the page URL (`?embed=1&scene=car&autoplay=1#s=…`) and also
 * used by the Embed dialog to build the URL it advertises, so the two can never disagree.
 */
export interface EmbedOptions {
  /** Template id from `?scene=` (a `#s=` / `#scene=` payload in the hash wins over it). */
  scene: string | null;
  autoplay: boolean;
  /** Show the slim play / pause / reset / camera bar. */
  controls: boolean;
  /** `orbit`: the viewer may orbit / pan / zoom. `fixed`: the camera is locked. */
  camera: 'orbit' | 'fixed';
  /** Allow grabbing and throwing bodies while the simulation runs (still no editing). */
  interact: boolean;
  /** Opening camera `[px, py, pz, tx, ty, tz]` (`?view=…`, comma separated); null = the scene's own framing. */
  view: [number, number, number, number, number, number] | null;
  /** Origins allowed to talk to the viewer through postMessage; empty = any parent. */
  origins: string[];
}

const truthy = (v: string | null): boolean => v === '1' || v === 'true' || v === 'yes';

/** Normalise an origin string (`https://a.example/path` → `https://a.example`); null when it is not an http(s) origin. */
export function normalizeOrigin(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function parseView(raw: string | null): EmbedOptions['view'] {
  if (!raw) return null;
  const n = raw.split(',').map(Number);
  if (n.length !== 6 || n.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e5)) return null;
  return n as NonNullable<EmbedOptions['view']>;
}

/** The embed options of a page URL's query, or null when the page is not in embed mode (`embed=1` is absent). */
export function readEmbedOptions(search: string): EmbedOptions | null {
  const q = new URLSearchParams(search);
  if (!truthy(q.get('embed'))) return null;
  const originParam = q.get('origin');
  let origins = (originParam ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter((o): o is string => o !== null);
  // `origin=` was given but nothing in it is a valid http(s) origin: lock everybody out instead of silently allowing all.
  if (originParam !== null && originParam !== '' && !origins.length) origins = ['about:deny-all'];
  return {
    scene: q.get('scene'),
    autoplay: truthy(q.get('autoplay')),
    controls: q.get('controls') !== '0',
    camera: q.get('camera') === 'fixed' ? 'fixed' : 'orbit',
    interact: truthy(q.get('interact')),
    view: parseView(q.get('view')),
    origins,
  };
}

/** The viewer URL for options: `base` is the app's own URL. `payload` is a hash value like `s=abc` (wins over `scene`). */
export function buildEmbedUrl(base: string, opts: Partial<EmbedOptions> & { payload?: string | null }): string {
  const u = new URL(base);
  u.search = '';
  u.hash = '';
  u.searchParams.set('embed', '1');
  if (!opts.payload && opts.scene) u.searchParams.set('scene', opts.scene);
  if (opts.autoplay) u.searchParams.set('autoplay', '1');
  if (opts.controls === false) u.searchParams.set('controls', '0');
  if (opts.camera === 'fixed') u.searchParams.set('camera', 'fixed');
  if (opts.interact) u.searchParams.set('interact', '1');
  if (opts.view) u.searchParams.set('view', opts.view.map((v) => Math.round(v * 100) / 100).join(','));
  if (opts.origins?.length) u.searchParams.set('origin', opts.origins.join(','));
  const url = u.toString();
  return opts.payload ? `${url}#${opts.payload}` : url;
}

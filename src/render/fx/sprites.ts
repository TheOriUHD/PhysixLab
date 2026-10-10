/**
 * The procedural sprite atlas: every particle shape the effects use, generated from maths — no image assets.
 *
 * The atlas is `ATLAS_COLS × ATLAS_COLS` cells of `CELL` pixels (RGBA, 8 bit). The alpha channel is the coverage of
 * the shape and the colour channels carry a grey "lighting" term (smoke is brighter on the upper left, chips have a
 * bevel), which the particle colour multiplies. Every cell fades to transparent before its border, so neighbouring
 * cells never bleed into each other when the texture is filtered. A short mip chain is built here as well (down to
 * 8 px cells) instead of letting the GPU go all the way to 1 px, where cells would mix.
 *
 * Pixel row 0 is the bottom of the image (the convention of `DataTexture`), and `v` in the generators points up.
 */

export const ATLAS_COLS = 4;
export const CELL = 64;
export const ATLAS_SIZE = ATLAS_COLS * CELL;
/** Mip levels generated: 256, 128, 64, 32 px (cells of 64, 32, 16, 8 px). */
export const ATLAS_LEVELS = 4;

export const SPRITE_NAMES = [
  'soft',
  'glow',
  'spark',
  'smoke1',
  'smoke2',
  'smoke3',
  'chip',
  'shard',
  'shard2',
  'ring',
  'ringSoft',
  'flame',
  'star',
  'crumb',
  'dust',
  'streak',
] as const;
export type SpriteName = (typeof SPRITE_NAMES)[number];

/** The cell number of a sprite (row-major, row 0 first). */
export function spriteFrame(name: SpriteName): number {
  return SPRITE_NAMES.indexOf(name);
}

// -- small maths -------------------------------------------------------------------------------------------------

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number, seed: number): number {
  return (
    valueNoise(x, y, seed) * 0.55 +
    valueNoise(x * 2.07, y * 2.07, seed + 17) * 0.3 +
    valueNoise(x * 4.1, y * 4.1, seed + 31) * 0.15
  );
}

/** Signed distance to a rounded box of half extents (hx, hy) and corner radius r. */
function sdBox(u: number, v: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(u) - hx + r;
  const qy = Math.abs(v) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a triangle (a, b, c); negative inside. */
function sdTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const seg = (x0: number, y0: number, x1: number, y1: number): number => {
    const ex = x1 - x0;
    const ey = y1 - y0;
    const wx = px - x0;
    const wy = py - y0;
    const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey));
    return Math.hypot(wx - ex * t, wy - ey * t);
  };
  const d = Math.min(seg(ax, ay, bx, by), seg(bx, by, cx, cy), seg(cx, cy, ax, ay));
  const side = (x0: number, y0: number, x1: number, y1: number): boolean =>
    (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0) >= 0;
  const s1 = side(ax, ay, bx, by);
  const inside = s1 === side(bx, by, cx, cy) && s1 === side(cx, cy, ax, ay);
  return inside ? -d : d;
}

// -- the shapes: (u, v) in −1 … 1 → [grey, alpha] ----------------------------------------------------------------------

type Shape = (u: number, v: number, out: [number, number]) => void;

/** Fade to zero before the cell border so filtered cells never bleed. */
const edge = (u: number, v: number): number => smooth(0.97, 0.85, Math.max(Math.abs(u), Math.abs(v)));

const SHAPES: Record<SpriteName, Shape> = {
  soft(u, v, o) {
    const r = Math.hypot(u, v);
    const a = clamp01(1 - r);
    o[0] = 1;
    o[1] = a * a * (3 - 2 * a) * edge(u, v);
  },
  glow(u, v, o) {
    const r = Math.hypot(u, v);
    o[0] = 1;
    o[1] = clamp01(Math.exp(-r * r * 7) * 0.9 + Math.exp(-r * 2.4) * 0.22) * smooth(1, 0.8, r) * edge(u, v);
  },
  spark(u, v, o) {
    const r = Math.hypot(u, v);
    o[0] = 1;
    o[1] = clamp01(Math.exp(-r * r * 16) + 0.22 * Math.exp(-r * r * 3.2)) * smooth(1, 0.75, r) * edge(u, v);
  },
  smoke1: (u, v, o) => smoke(u, v, o, 3),
  smoke2: (u, v, o) => smoke(u, v, o, 11),
  smoke3: (u, v, o) => smoke(u, v, o, 29),
  chip(u, v, o) {
    const d = sdBox(u, v, 0.62, 0.5, 0.14);
    const a = smooth(0.05, -0.05, d);
    // A bevel: the upper left edge catches light, the lower right is in shade.
    o[0] = clamp01(0.72 + 0.28 * (v - u) * 0.9 + (d > -0.14 ? 0.08 : 0));
    o[1] = a * edge(u, v);
  },
  shard(u, v, o) {
    const d = sdTriangle(u, v, -0.7, -0.62, 0.78, -0.3, -0.08, 0.8);
    const a = smooth(0.04, -0.04, d);
    o[0] = clamp01(0.62 + 0.55 * Math.max(0, 0.9 + d * 4) * 0.6 + 0.2 * (v - u * 0.5));
    o[1] = a * edge(u, v);
  },
  shard2(u, v, o) {
    // A long thin sliver, tilted.
    const c = Math.cos(0.5);
    const s = Math.sin(0.5);
    const x = u * c + v * s;
    const y = -u * s + v * c;
    const d = sdBox(x, y, 0.8, 0.2, 0.05);
    o[0] = clamp01(0.7 + 0.45 * smooth(-0.02, -0.12, d) + 0.15 * y);
    o[1] = smooth(0.05, -0.05, d) * edge(u, v);
  },
  ring(u, v, o) {
    const r = Math.hypot(u, v);
    o[0] = 1;
    o[1] = clamp01(smooth(0.055, 0.0, Math.abs(r - 0.86)) + 0.035 * smooth(0.86, 0.0, r)) * smooth(0.97, 0.9, r);
  },
  ringSoft(u, v, o) {
    const r = Math.hypot(u, v);
    const k = (r - 0.74) / 0.1;
    o[0] = 1;
    o[1] = Math.exp(-k * k) * smooth(0.97, 0.88, r);
  },
  flame(u, v, o) {
    // A teardrop: wide at the bottom, pointed at the top, with a noisy rim.
    const n = fbm(u * 2.6 + 3.1, v * 2.6 - 1.4, 7);
    const w = 0.62 * Math.pow(clamp01((0.95 - v) / 1.55), 0.8);
    const q = Math.abs(u) / Math.max(w, 0.02);
    const d = q + (1 - clamp01((v + 0.7) / 0.5)) * 0.35 - 0.1 + (n - 0.5) * 0.55;
    o[0] = 1;
    o[1] = smooth(1.0, 0.25, d) * smooth(-1, -0.6, v) * edge(u, v);
  },
  star(u, v, o) {
    const au = Math.abs(u);
    const av = Math.abs(v);
    const a = Math.exp(-au * 26 - av * 2.4) + Math.exp(-av * 26 - au * 2.4) + 0.8 * Math.exp(-(u * u + v * v) * 22);
    o[0] = 1;
    o[1] = clamp01(a) * smooth(1, 0.8, Math.hypot(u, v)) * edge(u, v);
  },
  crumb(u, v, o) {
    const ang = Math.atan2(v, u);
    const wob = 1 + 0.3 * Math.sin(ang * 3 + 1.3) + 0.16 * Math.sin(ang * 5 + 0.4);
    const r = Math.hypot(u, v) / (0.72 * wob);
    o[0] = clamp01(0.82 + 0.18 * (v - u));
    o[1] = smooth(1.0, 0.82, r) * edge(u, v);
  },
  dust(u, v, o) {
    const r = Math.hypot(u, v);
    const n = fbm(u * 2.1 + 9, v * 2.1 + 5, 41);
    o[0] = clamp01(0.82 + 0.25 * (v * 0.5 - u * 0.3));
    o[1] = Math.pow(clamp01(1 - r), 1.4) * (0.55 + 0.9 * n) * edge(u, v);
  },
  streak(u, v, o) {
    o[0] = 1;
    o[1] = Math.exp(-v * v * 70) * smooth(1, 0.55, Math.abs(u)) * edge(u, v);
  },
};

function smoke(u: number, v: number, o: [number, number], seed: number): void {
  const r = Math.hypot(u, v);
  const n = fbm(u * 2.3 + seed, v * 2.3 - seed * 0.7, seed);
  const mask = smooth(1.0, 0.25, r);
  const a = smooth(0.2, 0.85, n * 0.95 + mask * 0.8 - 0.34) * mask;
  o[0] = clamp01(0.6 + 0.4 * (v * 0.6 - u * 0.35 + (n - 0.5) * 0.8));
  o[1] = a * edge(u, v);
}

// -- atlas ---------------------------------------------------------------------------------------------------------

/** Render one level-0 atlas: `ATLAS_SIZE²` RGBA8 pixels. Deterministic. */
export function generateAtlas(): Uint8Array {
  const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  const out: [number, number] = [1, 0];
  SPRITE_NAMES.forEach((name, i) => {
    const cx = (i % ATLAS_COLS) * CELL;
    const cy = Math.floor(i / ATLAS_COLS) * CELL;
    const shape = SHAPES[name];
    for (let py = 0; py < CELL; py++) {
      for (let px = 0; px < CELL; px++) {
        const u = ((px + 0.5) / CELL) * 2 - 1;
        const v = ((py + 0.5) / CELL) * 2 - 1;
        shape(u, v, out);
        const o = ((cy + py) * ATLAS_SIZE + cx + px) * 4;
        const g = Math.round(clamp01(out[0]) * 255);
        data[o] = g;
        data[o + 1] = g;
        data[o + 2] = g;
        data[o + 3] = Math.round(clamp01(out[1]) * 255);
      }
    }
  });
  return data;
}

/** Box-filter a square RGBA8 image to half size (colour weighted by alpha so transparent texels do not darken it). */
export function downsample(src: Uint8Array, size: number): Uint8Array {
  const half = size >> 1;
  const dst = new Uint8Array(half * half * 4);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      let grey = 0;
      let alpha = 0;
      let weight = 0;
      for (let k = 0; k < 4; k++) {
        const o = ((y * 2 + (k >> 1)) * size + x * 2 + (k & 1)) * 4;
        const w = src[o + 3] + 1;
        grey += src[o] * w;
        weight += w;
        alpha += src[o + 3];
      }
      const g = Math.round(grey / weight);
      const d = (y * half + x) * 4;
      dst[d] = g;
      dst[d + 1] = g;
      dst[d + 2] = g;
      dst[d + 3] = Math.round(alpha / 4);
    }
  }
  return dst;
}

export interface AtlasLevel {
  data: Uint8Array;
  width: number;
  height: number;
}

/** The atlas with its short mip chain, level 0 first. */
export function generateAtlasLevels(): AtlasLevel[] {
  const levels: AtlasLevel[] = [];
  let data = generateAtlas();
  let size = ATLAS_SIZE;
  for (let i = 0; i < ATLAS_LEVELS; i++) {
    levels.push({ data, width: size, height: size });
    if (i < ATLAS_LEVELS - 1) {
      data = downsample(data, size);
      size >>= 1;
    }
  }
  return levels;
}

/**
 * Procedural surface patterns (VZ-2): each pattern is a pure function of a tileable (u, v) in [0,1)² returning a
 * mix factor between the material colour and the pattern's second colour plus a height used for bump/normal maps.
 * `renderPattern` rasterises one pattern into colour + height buffers; `heightToNormal` turns a height buffer into
 * tangent-space normals. Both are pure (no DOM) so they can be unit tested; `textures.ts` wraps them in canvases.
 */
import type { ProceduralPattern } from '../model/types';

export interface PatternSample {
  /** 0 = first colour, 1 = second colour. */
  t: number;
  /** Surface height 0–1 (for the bump map). */
  h: number;
}

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable value noise with `period` lattice cells across the unit square. */
export function valueNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = (i: number) => ((i % period) + period) % period;
  const a = hash(w(x0), w(y0), seed);
  const b = hash(w(x0 + 1), w(y0), seed);
  const c = hash(w(x0), w(y0 + 1), seed);
  const d = hash(w(x0 + 1), w(y0 + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function fbm(u: number, v: number, period: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let p = period;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(u, v, p, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

const frac = (x: number) => x - Math.floor(x);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type Fn = (u: number, v: number, out: PatternSample) => void;

const PATTERNS: Record<ProceduralPattern, Fn> = {
  checker: (u, v, o) => {
    o.t = (Math.floor(u * 8) + Math.floor(v * 8)) & 1;
    o.h = o.t;
  },
  stripes: (u, _v, o) => {
    o.t = Math.floor(u * 8) & 1;
    o.h = o.t;
  },
  hazard: (u, v, o) => {
    o.t = Math.floor(frac(u + v) * 8) & 1;
    o.h = o.t * 0.5;
  },
  wood: (u, v, o) => {
    const warp = fbm(u, v, 3, 5, 4) * 2 - 1;
    const rings = 0.5 + 0.5 * Math.sin((v * 7 + warp * 1.6 + fbm(u, v, 12, 9, 2) * 0.4) * Math.PI * 2);
    const fibre = valueNoise(u, v, 48, 3) * 0.15;
    o.t = Math.min(1, Math.pow(rings, 1.6) * 0.9 + fibre);
    o.h = 0.55 + (valueNoise(u, v, 64, 4) - 0.5) * 0.4;
  },
  brick: (u, v, o) => {
    const rows = 8;
    const row = Math.floor(v * rows);
    const x = frac(u * 4 + (row & 1 ? 0.5 : 0));
    const y = frac(v * rows);
    const mortar = x < 0.045 || y < 0.09 || x > 0.985 ? 1 : 0;
    const shade = valueNoise(u, v, 32, 11) * 0.25;
    o.t = mortar ? 1 : shade;
    o.h = mortar ? 0 : 0.85 + shade * 0.3;
  },
  concrete: (u, v, o) => {
    const n = fbm(u, v, 6, 21, 5);
    const speck = hash(Math.floor(u * 128), Math.floor(v * 128), 7) > 0.97 ? 0.5 : 0;
    o.t = Math.min(1, n * 0.7 + speck);
    o.h = n;
  },
  marble: (u, v, o) => {
    const warp = fbm(u, v, 4, 31, 5);
    const vein = Math.abs(Math.sin((u + v) * Math.PI * 2 + warp * 9));
    o.t = Math.pow(1 - vein, 9) * 0.9 + fbm(u, v, 8, 33, 3) * 0.12;
    o.h = 0.5 + o.t * 0.05;
  },
  noise: (u, v, o) => {
    const n = fbm(u, v, 8, 41, 5);
    o.t = n;
    o.h = n;
  },
  grid: (u, v, o) => {
    const line = frac(u * 8) < 0.06 || frac(v * 8) < 0.06 ? 1 : 0;
    o.t = line;
    o.h = 1 - line;
  },
  dots: (u, v, o) => {
    const x = frac(u * 8) - 0.5;
    const y = frac(v * 8) - 0.5;
    const d = Math.hypot(x, y);
    o.t = d < 0.34 ? 1 : 0;
    o.h = 1 - smooth(0.12, 0.42, d);
  },
  carbon: (u, v, o) => {
    // 2×2 twill: cells alternate between horizontal and vertical tows, each lit like a rounded cylinder
    const cx = Math.floor(u * 8);
    const cy = Math.floor(v * 8);
    const horizontal = (cx + cy) & 1;
    const a = frac(horizontal ? v * 8 : u * 8);
    const light = Math.sin(a * Math.PI);
    o.t = horizontal ? 0.25 + light * 0.75 : 0.75 - light * 0.5;
    o.h = light * 0.6 + (horizontal ? 0.4 : 0);
  },
};

export interface PatternBuffers {
  size: number;
  /** RGBA, 0–255. */
  color: Uint8ClampedArray;
  /** One float per texel, 0–1. */
  height: Float32Array;
}

const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})/i.exec(c);
  let s = m ? m[1] : 'ffffff';
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The pattern at `size`×`size` texels, coloured between `c1` and `c2`. Tileable in both directions. */
export function renderPattern(pattern: ProceduralPattern, c1: string, c2: string, size: number): PatternBuffers {
  const fn = PATTERNS[pattern];
  const a = hex(c1);
  const b = hex(c2);
  const color = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const s: PatternSample = { t: 0, h: 0 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn((x + 0.5) / size, (y + 0.5) / size, s);
      const i = y * size + x;
      const o = i * 4;
      color[o] = a[0] + (b[0] - a[0]) * s.t;
      color[o + 1] = a[1] + (b[1] - a[1]) * s.t;
      color[o + 2] = a[2] + (b[2] - a[2]) * s.t;
      color[o + 3] = 255;
      height[i] = s.h;
    }
  }
  return { size, color, height };
}

/** Tangent-space normal map (RGBA bytes) from a tileable height buffer; `strength` scales the slope. */
export function heightToNormal(height: Float32Array, size: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength * 0.5;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength * 0.5;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      out[o] = (-dx * inv * 0.5 + 0.5) * 255;
      out[o + 1] = (dy * inv * 0.5 + 0.5) * 255; // canvas y points down, texture v points up
      out[o + 2] = (inv * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

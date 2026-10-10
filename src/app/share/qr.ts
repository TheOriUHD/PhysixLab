/**
 * A small, pure QR Code (Model 2) encoder (DT-21): byte mode, error correction L or M, versions 1-40, all eight
 * masks scored with the standard penalty rules. No dependencies; renders to an SVG string or a canvas.
 *
 * Layout of a symbol follows ISO/IEC 18004: finder + separator, timing, alignment patterns, format information
 * (BCH(15,5), masked with 0x5412), version information from version 7 (BCH(18,6)), data and error-correction
 * codewords interleaved over blocks (Reed-Solomon over GF(256), polynomial 0x11D) and placed in the zig-zag order.
 */

export type QrEcl = 'L' | 'M';

export class QrTooLongError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`This text is ${bytes} bytes, but a QR code holds at most ${maxBytes} bytes at this error correction level.`);
    this.name = 'QrTooLongError';
  }
}

// Index 0 is unused: versions start at 1. Values per ISO/IEC 18004 table 9.
const ECC_PER_BLOCK: Record<QrEcl, number[]> = {
  L: [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
};
const NUM_BLOCKS: Record<QrEcl, number[]> = {
  L: [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19,
    19, 20, 21, 22, 24, 25,
  ],
  M: [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
    33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
};
/** Two-bit error-correction indicator in the format information. */
const ECL_BITS: Record<QrEcl, number> = { L: 1, M: 0 };

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

/** Data + error-correction modules of a version (everything that is not a function pattern). */
function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

/** Data codewords (before error correction) of a version at a level. */
export function dataCodewords(ver: number, ecl: QrEcl): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
}

/** Block structure of a version at a level (exported for tests). */
export function blockInfo(ver: number, ecl: QrEcl): { blocks: number; eccPerBlock: number; rawCodewords: number } {
  return { blocks: NUM_BLOCKS[ecl][ver], eccPerBlock: ECC_PER_BLOCK[ecl][ver], rawCodewords: Math.floor(rawDataModules(ver) / 8) };
}

const countBits = (ver: number): number => (ver < 10 ? 8 : 16);

/** Largest payload in bytes (byte mode) that fits a version at a level. */
export function capacityBytes(ver: number, ecl: QrEcl): number {
  return Math.floor((dataCodewords(ver, ecl) * 8 - 4 - countBits(ver)) / 8);
}

/** The largest payload any version can carry at a level (2953 bytes at L, 2331 at M). */
export const maxBytes = (ecl: QrEcl): number => capacityBytes(MAX_VERSION, ecl);

// ---- Reed-Solomon over GF(256) ------------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly; // highest degree first, leading coefficient 1
}

/** Error-correction codewords for one block (exported for tests). */
export function reedSolomon(data: number[], eccLen: number): number[] {
  return rsRemainder(data, rsGenerator(eccLen));
}

function rsRemainder(data: number[], gen: number[]): number[] {
  const degree = gen.length - 1;
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ---- the symbol ---------------------------------------------------------------------------------------------

export interface QrCode {
  readonly version: number;
  readonly ecl: QrEcl;
  readonly mask: number;
  /** Modules per side: `17 + 4 * version`. */
  readonly size: number;
  /** Dark module at column `x`, row `y` (false outside the symbol). */
  get(x: number, y: number): boolean;
}

function bchRemainder(value: number, poly: number, polyBits: number): number {
  const degree = polyBits - 1;
  let rem = value;
  // Long division over GF(2): clear every set bit above the generator's degree.
  for (let bit = 31; bit >= degree; bit--) if ((rem >>> bit) & 1) rem ^= poly << (bit - degree);
  return rem;
}

/** The 15 format-information bits (already XOR-masked with 0x5412) of an error-correction level and mask. */
export function formatBits(ecl: QrEcl, mask: number): number {
  const data = (ECL_BITS[ecl] << 3) | mask;
  const rem = bchRemainder(data << 10, 0x537, 11);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version-information bits of a version (7 and up). */
export function versionBits(ver: number): number {
  const rem = bchRemainder(ver << 12, 0x1f25, 13);
  return (ver << 12) | rem;
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

class Grid {
  readonly modules: Uint8Array;
  readonly isFunction: Uint8Array;
  constructor(readonly size: number) {
    this.modules = new Uint8Array(size * size);
    this.isFunction = new Uint8Array(size * size);
  }
  set(x: number, y: number, dark: boolean): void {
    this.modules[y * this.size + x] = dark ? 1 : 0;
    this.isFunction[y * this.size + x] = 1;
  }
  get(x: number, y: number): boolean {
    return this.modules[y * this.size + x] === 1;
  }
}

function drawFunctionPatterns(g: Grid, ver: number, ecl: QrEcl, mask: number): void {
  const size = g.size;
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  // Finder patterns with their separators.
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx,
          y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, dist !== 2 && dist !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // Alignment patterns (not over the finders).
  const pos = alignmentPositions(ver);
  for (let i = 0; i < pos.length; i++)
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) g.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  drawFormat(g, ecl, mask);
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, dark);
      g.set(b, a, dark);
    }
  }
}

function drawFormat(g: Grid, ecl: QrEcl, mask: number): void {
  const size = g.size;
  const bits = formatBits(ecl, mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  // First copy, around the top-left finder.
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  // Second copy, split between the other two finders.
  for (let i = 0; i < 8; i++) g.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, size - 15 + i, bit(i));
  g.set(8, size - 8, true); // the always-dark module
}

function buildCodewords(data: Uint8Array, ver: number, ecl: QrEcl): number[] {
  // Bit stream: mode 0100, character count, bytes, terminator, padding.
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(data.length, countBits(ver));
  for (const b of data) push(b, 8);
  const capBits = dataCodewords(ver, ecl) * 8;
  push(0, Math.min(4, capBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
    words.push(w);
  }
  for (let pad = 0xec; words.length < capBits / 8; pad ^= 0xec ^ 0x11) words.push(pad);

  // Split into blocks, append error correction, interleave.
  const blocks = NUM_BLOCKS[ecl][ver];
  const eccLen = ECC_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = blocks - (rawCodewords % blocks);
  const shortLen = Math.floor(rawCodewords / blocks);
  const gen = rsGenerator(eccLen);
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const d = words.slice(k, k + len);
    k += len;
    dataBlocks.push(d);
    eccBlocks.push(rsRemainder(d, gen));
  }
  const out: number[] = [];
  for (let i = 0; i < shortLen - eccLen + 1; i++)
    for (const d of dataBlocks) if (i < d.length) out.push(d[i]);
  for (let i = 0; i < eccLen; i++) for (const e of eccBlocks) out.push(e[i]);
  return out;
}

function placeCodewords(g: Grid, codewords: number[]): void {
  const size = g.size;
  let i = 0; // bit index
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (g.isFunction[y * size + x]) continue;
        if (i < codewords.length * 8) g.modules[y * size + x] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
        i++;
      }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  const size = g.size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (!g.isFunction[y * size + x] && maskBit(mask, x, y)) g.modules[y * size + x] ^= 1;
}

/** Penalty score of the four standard rules (lower is better). */
function penalty(g: Grid): number {
  const size = g.size;
  let score = 0;
  const runs = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      const hist: number[] = [];
      for (let b = 1; b <= size; b++) {
        if (b < size && get(a, b) === get(a, b - 1)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          hist.push(run);
          run = 1;
        }
      }
      // Finder-like 1:1:3:1:1 patterns with 4 light modules on either side.
      for (let k = 0; k + 4 < hist.length; k++) {
        const [r0, r1, r2, r3, r4] = [hist[k], hist[k + 1], hist[k + 2], hist[k + 3], hist[k + 4]];
        if (r0 === 1 && r1 === 1 && r2 === 3 && r3 === 1 && r4 === 1) {
          // Which side is dark? Recompute the start position of the pattern.
          let start = 0;
          for (let q = 0; q < k; q++) start += hist[q];
          const dark = get(a, start);
          if (dark) {
            const before = k === 0 ? 4 : hist[k - 1];
            const after = k + 5 >= hist.length ? 4 : hist[k + 5];
            if (before >= 4) score += 40;
            if (after >= 4) score += 40;
          }
        }
      }
    }
  };
  runs((a, b) => g.get(b, a));
  runs((a, b) => g.get(a, b));
  // 2x2 blocks.
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = g.get(x, y);
      if (c === g.get(x + 1, y) && c === g.get(x, y + 1) && c === g.get(x + 1, y + 1)) score += 3;
    }
  // Dark / light balance.
  let dark = 0;
  for (let i = 0; i < size * size; i++) dark += g.modules[i];
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

export interface QrOptions {
  ecl?: QrEcl;
  minVersion?: number;
  maxVersion?: number;
  /** Force a mask (0-7); by default the one with the lowest penalty is used. */
  mask?: number;
}

const toBytes = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

/** Encodes `data` in byte mode using the smallest version that fits. Throws `QrTooLongError` when none does. */
export function encodeQr(data: string | Uint8Array, opts: QrOptions = {}): QrCode {
  const bytes = toBytes(data);
  const ecl = opts.ecl ?? 'M';
  const lo = Math.max(MIN_VERSION, opts.minVersion ?? MIN_VERSION);
  const hi = Math.min(MAX_VERSION, opts.maxVersion ?? MAX_VERSION);
  let ver = lo;
  while (ver <= hi && capacityBytes(ver, ecl) < bytes.length) ver++;
  if (ver > hi) throw new QrTooLongError(bytes.length, capacityBytes(hi, ecl));

  const codewords = buildCodewords(bytes, ver, ecl);
  const size = 17 + 4 * ver;
  const build = (mask: number): Grid => {
    const g = new Grid(size);
    drawFunctionPatterns(g, ver, ecl, mask);
    placeCodewords(g, codewords);
    applyMask(g, mask);
    return g;
  };
  let best = -1;
  let grid: Grid | null = null;
  if (opts.mask !== undefined) {
    best = opts.mask;
    grid = build(best);
  } else {
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      const g = build(m);
      const s = penalty(g);
      if (s < bestScore) {
        bestScore = s;
        best = m;
        grid = g;
      }
    }
  }
  const final = grid as Grid;
  return {
    version: ver,
    ecl,
    mask: best,
    size,
    get: (x, y) => x >= 0 && y >= 0 && x < size && y < size && final.get(x, y),
  };
}

/** Tries error-correction M first (more robust to a poor screen or print), falls back to L; throws when neither fits. */
export function encodeQrBest(data: string | Uint8Array): QrCode {
  const bytes = toBytes(data);
  if (bytes.length <= maxBytes('M')) return encodeQr(bytes, { ecl: 'M' });
  return encodeQr(bytes, { ecl: 'L' });
}

/** Does `data` fit a QR code at all (at error correction L, version 40)? */
export const fitsInQr = (data: string | Uint8Array): boolean => toBytes(data).length <= maxBytes('L');

/** The symbol as a standalone SVG string with a quiet zone of `border` modules (4 per the standard). */
export function qrToSvg(qr: QrCode, border = 4, dark = '#000000', light = '#ffffff'): string {
  const dim = qr.size + border * 2;
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.get(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && qr.get(x, y)) x++;
      parts.push(`M${start + border},${y + border}h${x - start}v1h${-(x - start)}z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/><path d="${parts.join('')}" fill="${dark}"/></svg>`
  );
}

/** Draws the symbol on a canvas, `scale` pixels per module. */
export function drawQr(canvas: HTMLCanvasElement, qr: QrCode, scale = 6, border = 4, dark = '#000', light = '#fff'): void {
  const dim = (qr.size + border * 2) * scale;
  canvas.width = canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = dark;
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
}

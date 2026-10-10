// -- DT-2: animated GIF encoder (own implementation: median-cut quantiser + variable-width LZW) --
/**
 * Pure, dependency-free GIF89a encoder, loaded lazily by the capture commands. Every frame carries its own
 * palette (a local colour table, median-cut from a 5-5-5 colour histogram), so a turntable that swings from a
 * bright sky to a dark floor keeps its colours; the cost is a few hundred bytes of table per frame.
 *
 * `GifEncoder.addFrame` is synchronous; callers that encode many frames yield to the UI between calls
 * (see session.ts), which keeps the page responsive without a worker round trip.
 */

/** Largest side the GIF format can express (16-bit dimensions). */
export const GIF_MAX_DIMENSION = 65535;

export interface QuantizeResult {
  /** RGB triples, `colors * 3` bytes. */
  palette: Uint8Array;
  /** Palette entries actually used (≤ maxColors). */
  colors: number;
  /** One palette index per pixel. */
  indices: Uint8Array;
}

interface Box {
  /** Slice of the colour-key array this box covers: [lo, hi). */
  lo: number;
  hi: number;
  pop: number;
  /** Channel (0 r, 1 g, 2 b) with the largest weighted range, and that range. */
  axis: number;
  range: number;
}

/**
 * Median-cut quantiser. Colours are binned to 5 bits per channel; boxes are split along their longest axis at the
 * population median until `maxColors` boxes exist (or every box holds one colour). Images with at most `maxColors`
 * distinct 5-bit colours are reproduced exactly (to the bin's mean), which the tests rely on.
 */
export function quantize(rgba: ArrayLike<number>, maxColors = 256): QuantizeResult {
  const n = Math.floor(rgba.length / 4);
  const limit = Math.max(2, Math.min(256, Math.floor(maxColors)));
  const counts = new Uint32Array(32768);
  const sumR = new Uint32Array(32768);
  const sumG = new Uint32Array(32768);
  const sumB = new Uint32Array(32768);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4],
      g = rgba[i * 4 + 1],
      b = rgba[i * 4 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    counts[key]++;
    sumR[key] += r;
    sumG[key] += g;
    sumB[key] += b;
  }
  const keys: number[] = [];
  for (let k = 0; k < 32768; k++) if (counts[k]) keys.push(k);
  const rOf = (k: number) => k >> 10;
  const gOf = (k: number) => (k >> 5) & 31;
  const bOf = (k: number) => k & 31;

  const measure = (lo: number, hi: number): Box => {
    let rmin = 31,
      rmax = 0,
      gmin = 31,
      gmax = 0,
      bmin = 31,
      bmax = 0,
      pop = 0;
    for (let i = lo; i < hi; i++) {
      const k = keys[i];
      const r = rOf(k),
        g = gOf(k),
        b = bOf(k);
      if (r < rmin) rmin = r;
      if (r > rmax) rmax = r;
      if (g < gmin) gmin = g;
      if (g > gmax) gmax = g;
      if (b < bmin) bmin = b;
      if (b > bmax) bmax = b;
      pop += counts[k];
    }
    // Green is weighted a little higher: the eye is most sensitive to it.
    const wr = (rmax - rmin) * 0.9,
      wg = (gmax - gmin) * 1.1,
      wb = (bmax - bmin) * 0.7;
    const axis = wg >= wr && wg >= wb ? 1 : wr >= wb ? 0 : 2;
    return { lo, hi, pop, axis, range: Math.max(wr, wg, wb) };
  };

  const boxes: Box[] = [];
  if (keys.length) boxes.push(measure(0, keys.length));
  while (boxes.length < limit) {
    // Split the box with the most pixels (times range, so flat colour fields are not split for nothing).
    let best = -1,
      bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.hi - b.lo < 2) continue;
      const score = b.pop * (b.range + 1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    const b = boxes[best];
    const comp = b.axis === 0 ? rOf : b.axis === 1 ? gOf : bOf;
    const slice = keys.slice(b.lo, b.hi).sort((p, q) => comp(p) - comp(q) || p - q);
    for (let i = 0; i < slice.length; i++) keys[b.lo + i] = slice[i];
    let acc = 0,
      cut = b.lo + 1;
    for (let i = b.lo; i < b.hi - 1; i++) {
      acc += counts[keys[i]];
      cut = i + 1;
      if (acc * 2 >= b.pop) break;
    }
    boxes.splice(best, 1, measure(b.lo, cut), measure(cut, b.hi));
  }

  const palette = new Uint8Array(Math.max(1, boxes.length) * 3);
  const cellToIndex = new Int16Array(32768);
  boxes.forEach((b, bi) => {
    let r = 0,
      g = 0,
      bl = 0,
      pop = 0;
    for (let i = b.lo; i < b.hi; i++) {
      const k = keys[i];
      r += sumR[k];
      g += sumG[k];
      bl += sumB[k];
      pop += counts[k];
      cellToIndex[k] = bi;
    }
    palette[bi * 3] = Math.round(r / pop);
    palette[bi * 3 + 1] = Math.round(g / pop);
    palette[bi * 3 + 2] = Math.round(bl / pop);
  });
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const key = ((rgba[i * 4] >> 3) << 10) | ((rgba[i * 4 + 1] >> 3) << 5) | (rgba[i * 4 + 2] >> 3);
    indices[i] = cellToIndex[key];
  }
  return { palette, colors: Math.max(1, boxes.length), indices };
}

/** Smallest colour-table exponent k (table size 2^k, k in 1…8) that holds `colors` entries. */
function tableBits(colors: number): number {
  let k = 1;
  while (1 << k < colors) k++;
  return k;
}

/**
 * GIF variable-width LZW. Returns the code stream bytes (not yet split into sub-blocks), starting with a clear
 * code and ending with the end-of-information code. `minCodeSize` is the value written before the data (2…8).
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let cur = 0,
    curBits = 0;
  const emit = (code: number, width: number) => {
    cur |= code << curBits;
    curBits += width;
    while (curBits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      curBits -= 8;
    }
  };
  // Open-addressing dictionary: (prefix code, next byte) → code. Cleared by refilling the small key table.
  const SIZE = 8192;
  const hkeys = new Int32Array(SIZE).fill(-1);
  const hvals = new Int16Array(SIZE);

  let width = minCodeSize + 1;
  let next = eoi + 1;
  emit(clear, width);
  if (indices.length > 0) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const c = indices[i];
      const key = (prefix << 8) | c;
      let slot = ((prefix << 4) ^ (c << 7) ^ prefix) & (SIZE - 1);
      let found = -1;
      while (hkeys[slot] !== -1) {
        if (hkeys[slot] === key) {
          found = hvals[slot];
          break;
        }
        slot = (slot + 1) & (SIZE - 1);
      }
      if (found >= 0) {
        prefix = found;
        continue;
      }
      emit(prefix, width);
      if (next < 4096) {
        hkeys[slot] = key;
        hvals[slot] = next;
        // The code width grows once the entry numbered 2^width has been added.
        if (next === 1 << width && width < 12) width++;
        next++;
      } else {
        emit(clear, width);
        hkeys.fill(-1);
        width = minCodeSize + 1;
        next = eoi + 1;
      }
      prefix = c;
    }
    emit(prefix, width);
    if (next < 4096 && next === 1 << width && width < 12) width++;
  }
  emit(eoi, width);
  if (curBits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}

export interface GifOptions {
  /** Repeat count; 0 loops forever (default), a negative value omits the loop extension (plays once). */
  loop?: number;
  /** Palette size per frame, 2…256 (default 256). */
  maxColors?: number;
}

/** Streaming GIF writer. Call `addFrame` per frame, then `finish()` for the bytes. */
export class GifEncoder {
  private parts: Uint8Array[] = [];
  private frames = 0;
  private done = false;

  constructor(
    readonly width: number,
    readonly height: number,
    private opts: GifOptions = {},
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      throw new Error(`GIF size must be positive whole numbers (got ${width}×${height})`);
    if (width > GIF_MAX_DIMENSION || height > GIF_MAX_DIMENSION)
      throw new Error(`GIF sides cannot exceed ${GIF_MAX_DIMENSION} px (got ${width}×${height})`);
    const head: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
    head.push(width & 255, width >> 8, height & 255, height >> 8);
    head.push(0x70, 0, 0); // no global table, 8-bit colour resolution, background 0, square pixels
    const loop = opts.loop ?? 0;
    if (loop >= 0) {
      head.push(0x21, 0xff, 0x0b, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)), 3, 1, loop & 255, loop >> 8, 0);
    }
    this.parts.push(Uint8Array.from(head));
  }

  get frameCount(): number {
    return this.frames;
  }

  /** Add one RGBA frame (`width * height * 4` bytes). `delayCs` is the display time in hundredths of a second. */
  addFrame(rgba: ArrayLike<number>, delayCs: number): void {
    if (this.done) throw new Error('GifEncoder.addFrame after finish()');
    if (rgba.length !== this.width * this.height * 4)
      throw new Error(`frame has ${rgba.length} bytes, expected ${this.width * this.height * 4}`);
    const q = quantize(rgba, this.opts.maxColors ?? 256);
    const k = tableBits(q.colors);
    const minCode = Math.max(2, k);
    const delay = Math.max(0, Math.min(65535, Math.round(delayCs)));
    const gce = [0x21, 0xf9, 4, 0x04, delay & 255, delay >> 8, 0, 0];
    const desc = [
      0x2c,
      0,
      0,
      0,
      0,
      this.width & 255,
      this.width >> 8,
      this.height & 255,
      this.height >> 8,
      0x80 | (k - 1),
    ];
    const table = new Uint8Array((1 << k) * 3);
    table.set(q.palette.subarray(0, q.colors * 3));
    const lzw = lzwEncode(q.indices, minCode);
    const blocks = new Uint8Array(lzw.length + Math.ceil(lzw.length / 255) + 1);
    let o = 0;
    for (let p = 0; p < lzw.length; p += 255) {
      const len = Math.min(255, lzw.length - p);
      blocks[o++] = len;
      blocks.set(lzw.subarray(p, p + len), o);
      o += len;
    }
    blocks[o] = 0;
    this.parts.push(Uint8Array.from(gce), Uint8Array.from(desc), table, Uint8Array.of(minCode), blocks);
    this.frames++;
  }

  /** Write the trailer and return the file as chunks (feed them straight to `new Blob`). */
  finishParts(): Uint8Array[] {
    if (!this.done) {
      this.parts.push(Uint8Array.of(0x3b));
      this.done = true;
    }
    return this.parts;
  }

  /** Write the trailer and return the whole file as one buffer. */
  finish(): Uint8Array {
    const parts = this.finishParts();
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

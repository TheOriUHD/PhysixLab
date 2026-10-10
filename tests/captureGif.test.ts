// -- DT-2 -- GIF encoder: LZW round trip through a tiny reference decoder, container fields, quantiser.
import { describe, expect, it } from 'vitest';
import { GifEncoder, lzwEncode, quantize } from '../src/app/capture/gif';

/** Reference LZW decoder (GIF flavour): the textbook algorithm, written independently of the encoder. */
function lzwDecode(data: Uint8Array, minCodeSize: number, expected: number): Uint8Array {
  const clear = 1 << minCodeSize,
    eoi = clear + 1;
  let width = minCodeSize + 1;
  let table: number[][] = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < clear; i++) table.push([i]);
    table.push([], []); // clear, eoi placeholders
    width = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let bitPos = 0;
  let prev: number[] | null = null;
  const read = (): number => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) return eoi;
      v |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return v;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < table.length) entry = table[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error('bad first code');
    out.push(...entry);
    if (prev) table.push([...prev, entry[0]]);
    prev = entry;
    if (table.length === 1 << width && width < 12) width++;
  }
  expect(out.length).toBe(expected);
  return Uint8Array.from(out);
}

interface DecodedFrame {
  delay: number;
  palette: Uint8Array;
  indices: Uint8Array;
}

/** Parse a GIF89a produced by GifEncoder (local colour tables, no global one). */
function parseGif(b: Uint8Array) {
  const head = String.fromCharCode(...b.subarray(0, 6));
  const width = b[6] | (b[7] << 8),
    height = b[8] | (b[9] << 8);
  const packed = b[10];
  let p = 13;
  expect(packed & 0x80).toBe(0); // no global colour table
  let loop: number | null = null;
  const frames: DecodedFrame[] = [];
  let delay = 0;
  for (;;) {
    const marker = b[p++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = b[p++];
      const blocks: number[][] = [];
      for (;;) {
        const len = b[p++];
        if (!len) break;
        blocks.push(Array.from(b.subarray(p, p + len)));
        p += len;
      }
      if (label === 0xf9) delay = blocks[0][1] | (blocks[0][2] << 8);
      if (label === 0xff && String.fromCharCode(...blocks[0]) === 'NETSCAPE2.0')
        loop = blocks[1][1] | (blocks[1][2] << 8);
    } else if (marker === 0x2c) {
      const w = b[p + 4] | (b[p + 5] << 8),
        h = b[p + 6] | (b[p + 7] << 8);
      const flags = b[p + 8];
      p += 9;
      expect(flags & 0x80).toBe(0x80);
      const size = 2 << (flags & 7);
      const palette = b.slice(p, p + size * 3);
      p += size * 3;
      const minCode = b[p++];
      const bytes: number[] = [];
      for (;;) {
        const len = b[p++];
        if (!len) break;
        for (let i = 0; i < len; i++) bytes.push(b[p + i]);
        p += len;
      }
      frames.push({ delay, palette, indices: lzwDecode(Uint8Array.from(bytes), minCode, w * h) });
    } else throw new Error(`unexpected block 0x${marker.toString(16)} at ${p - 1}`);
  }
  return { head, width, height, loop, frames, end: p };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('lzwEncode', () => {
  it.each([2, 3, 5, 8])('round-trips random data with min code size %i (forces table resets)', (mcs) => {
    const r = rng(mcs);
    const n = 40000;
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = Math.floor(r() * (1 << mcs));
    expect(Array.from(lzwDecode(lzwEncode(data, mcs), mcs, n))).toEqual(Array.from(data));
  });

  it('round-trips highly repetitive data (long dictionary strings, width growth to 12 bits)', () => {
    const data = new Uint8Array(100000);
    for (let i = 0; i < data.length; i++) data[i] = (i >> 6) & 3;
    expect(Array.from(lzwDecode(lzwEncode(data, 2), 2, data.length))).toEqual(Array.from(data));
  });

  it('handles the 1-pixel and empty cases', () => {
    expect(Array.from(lzwDecode(lzwEncode(Uint8Array.of(1), 2), 2, 1))).toEqual([1]);
    expect(Array.from(lzwDecode(lzwEncode(new Uint8Array(0), 2), 2, 0))).toEqual([]);
  });

  it('compresses a flat image far below its raw size', () => {
    expect(lzwEncode(new Uint8Array(64 * 64), 2).length).toBeLessThan(200);
  });
});

describe('quantize', () => {
  it('reproduces an image with few colours exactly (to 5-bit bins)', () => {
    const colors = [
      [8, 16, 24],
      [200, 40, 0],
      [0, 248, 120],
      [248, 248, 248],
    ];
    const px = new Uint8Array(16 * 4);
    for (let i = 0; i < 16; i++) px.set([...colors[i % 4], 255], i * 4);
    const q = quantize(px, 256);
    expect(q.colors).toBe(4);
    for (let i = 0; i < 16; i++) {
      const o = q.indices[i] * 3;
      expect([q.palette[o], q.palette[o + 1], q.palette[o + 2]]).toEqual(colors[i % 4]);
    }
  });

  it('keeps the error of a smooth gradient small with 256 colours', () => {
    const w = 128,
      h = 64;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([x * 2, y * 4, 255 - x, 255], (y * w + x) * 4);
    const q = quantize(px, 256);
    expect(q.colors).toBeLessThanOrEqual(256);
    let worst = 0;
    for (let i = 0; i < w * h; i++)
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(q.palette[q.indices[i] * 3 + c] - px[i * 4 + c]));
    expect(worst).toBeLessThan(40);
  });

  it('honours a smaller palette limit', () => {
    const r = rng(7);
    const px = new Uint8Array(500 * 4);
    for (let i = 0; i < 500; i++) px.set([r() * 256, r() * 256, r() * 256, 255], i * 4);
    expect(quantize(px, 16).colors).toBeLessThanOrEqual(16);
  });
});

describe('GifEncoder', () => {
  function frameOf(w: number, h: number, f: (x: number, y: number) => [number, number, number]) {
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([...f(x, y), 255], (y * w + x) * 4);
    return px;
  }

  it('writes GIF89a header, dimensions, loop extension, per-frame delays and the trailer', () => {
    const enc = new GifEncoder(37, 21);
    const a = frameOf(37, 21, (x) => (x < 10 ? [248, 0, 0] : [0, 0, 248]));
    const b = frameOf(37, 21, (_x, y) => (y < 10 ? [0, 248, 0] : [248, 248, 0]));
    enc.addFrame(a, 4);
    enc.addFrame(b, 7);
    expect(enc.frameCount).toBe(2);
    const bytes = enc.finish();
    const g = parseGif(bytes);
    expect(g.head).toBe('GIF89a');
    expect([g.width, g.height]).toEqual([37, 21]);
    expect(g.loop).toBe(0);
    expect(g.frames.map((f) => f.delay)).toEqual([4, 7]);
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    expect(g.end).toBe(bytes.length);
    // Decoded pixels match the input colours.
    [a, b].forEach((src, fi) => {
      const f = g.frames[fi];
      for (let i = 0; i < 37 * 21; i++) {
        const o = f.indices[i] * 3;
        expect([f.palette[o], f.palette[o + 1], f.palette[o + 2]]).toEqual([
          src[i * 4],
          src[i * 4 + 1],
          src[i * 4 + 2],
        ]);
      }
    });
  });

  it('encodes a noisy 320x180 frame losslessly in palette space (round trip through the reference decoder)', () => {
    const r = rng(42);
    const px = frameOf(320, 180, (x, y) => [x % 256, (y * 3) % 256, Math.floor(r() * 256)]);
    const q = quantize(px, 256);
    const enc = new GifEncoder(320, 180);
    enc.addFrame(px, 2);
    const g = parseGif(enc.finish());
    expect(Array.from(g.frames[0].indices)).toEqual(Array.from(q.indices));
  });

  it('can omit the loop extension and rejects bad sizes and frames', () => {
    const e = new GifEncoder(2, 2, { loop: -1 });
    e.addFrame(new Uint8Array(16), 1);
    expect(parseGif(e.finish()).loop).toBeNull();
    expect(() => new GifEncoder(0, 5)).toThrow(/positive/);
    expect(() => new GifEncoder(70000, 5)).toThrow(/65535/);
    expect(() => new GifEncoder(2, 2).addFrame(new Uint8Array(15), 1)).toThrow(/expected 16/);
    const done = new GifEncoder(1, 1);
    done.finish();
    expect(() => done.addFrame(new Uint8Array(4), 1)).toThrow(/after finish/);
  });

  it('is deterministic: the same frames give the same bytes', () => {
    const mk = () => {
      const e = new GifEncoder(16, 16);
      e.addFrame(
        frameOf(16, 16, (x, y) => [x * 15, y * 15, 100]),
        5,
      );
      return Array.from(e.finish());
    };
    expect(mk()).toEqual(mk());
  });
});

/**
 * DT-21 QR encoder. The evidence is an independent reader: the test below reads a finished symbol back the way a
 * scanner does (format information, unmasking, zig-zag codeword read, de-interleaving, Reed-Solomon syndromes,
 * byte-mode parsing) using its own function-pattern map and its own GF(256) arithmetic, and must recover the input.
 */
import { describe, expect, it } from 'vitest';
import {
  alignmentPositions,
  blockInfo,
  capacityBytes,
  encodeQr,
  encodeQrBest,
  formatBits,
  maxBytes,
  QrTooLongError,
  qrToSvg,
  reedSolomon,
  versionBits,
  type QrCode,
  type QrEcl,
} from '../src/app/share/qr';

// ---- reference pieces written for the test (not shared with the encoder) --------------------------------------

/** Carry-less multiply modulo x^8+x^4+x^3+x^2+1. */
function gmul(a: number, b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if ((b >> i) & 1) r ^= a << i;
  }
  for (let i = 14; i >= 8; i--) if ((r >> i) & 1) r ^= 0x11d << (i - 8);
  return r;
}
const gpow = (n: number): number => {
  let r = 1;
  for (let i = 0; i < n; i++) r = gmul(r, 2);
  return r;
};

/** BCH check by brute force: the codeword of `data` (k bits) among all 2^k, found by minimum-weight division. */
function bchEncode(data: number, k: number, gen: number, genDeg: number): number {
  let v = data << genDeg;
  for (let bit = k + genDeg - 1; bit >= genDeg; bit--) if ((v >> bit) & 1) v ^= gen << (bit - genDeg);
  return (data << genDeg) | v;
}

function functionMap(ver: number): boolean[][] {
  const n = 17 + 4 * ver;
  const f = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < n && y < n) f[y][x] = true;
  };
  rect(0, 0, 8, 8); // top-left finder + separator + format
  rect(n - 8, 0, n - 1, 8); // top-right
  rect(0, n - 8, 8, n - 1); // bottom-left (includes the dark module)
  rect(0, 6, n - 1, 6);
  rect(6, 0, 6, n - 1);
  if (ver >= 7) {
    rect(n - 11, 0, n - 9, 5);
    rect(0, n - 11, 5, n - 9);
  }
  const pos = alignmentPositions(ver);
  for (const cy of pos)
    for (const cx of pos) {
      const onFinder = (cx < 9 && cy < 9) || (cx > n - 10 && cy < 9) || (cx < 9 && cy > n - 10);
      if (!onFinder) rect(cx - 2, cy - 2, cx + 2, cy + 2);
    }
  return f;
}

const maskFns: ((x: number, y: number) => boolean)[] = [
  (x, y) => (y + x) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (y + x) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (x, y) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (x, y) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

interface Decoded {
  ecl: QrEcl;
  mask: number;
  version: number;
  data: Uint8Array;
  syndromesZero: boolean;
}

function decode(qr: QrCode): Decoded {
  const n = qr.size;
  const ver = (n - 17) / 4;
  expect(Number.isInteger(ver)).toBe(true);
  const bit = (x: number, y: number) => (qr.get(x, y) ? 1 : 0);

  // Finder patterns: 7x7 rings plus the light separator.
  for (const [ox, oy] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ]) {
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        expect(bit(ox + x, oy + y)).toBe(ring === 2 ? 0 : 1);
      }
  }
  // Timing patterns alternate starting dark.
  for (let i = 8; i < n - 8; i++) {
    expect(bit(i, 6)).toBe(i % 2 === 0 ? 1 : 0);
    expect(bit(6, i)).toBe(i % 2 === 0 ? 1 : 0);
  }
  expect(bit(8, n - 8)).toBe(1); // dark module

  // Format information, both copies.
  const copy1: number[] = [];
  for (let i = 0; i <= 5; i++) copy1.push(bit(8, i));
  copy1.push(bit(8, 7), bit(8, 8), bit(7, 8));
  for (let i = 9; i < 15; i++) copy1.push(bit(14 - i, 8));
  const copy2: number[] = [];
  for (let i = 0; i < 8; i++) copy2.push(bit(n - 1 - i, 8));
  for (let i = 8; i < 15; i++) copy2.push(bit(8, n - 15 + i));
  const word = (bits: number[]) => bits.reduce((acc, b, i) => acc | (b << i), 0);
  expect(word(copy1)).toBe(word(copy2));
  let found: { ecl: QrEcl; mask: number } | null = null;
  for (const [ecl, ind] of [
    ['L', 1],
    ['M', 0],
  ] as const)
    for (let mask = 0; mask < 8; mask++)
      if ((bchEncode((ind << 3) | mask, 5, 0x537, 10) ^ 0x5412) === word(copy1)) found = { ecl, mask };
  if (!found) throw new Error('format information is not a valid codeword');

  // Version information (v7+): both copies equal the BCH(18,6) codeword.
  if (ver >= 7) {
    const expected = bchEncode(ver, 6, 0x1f25, 12);
    let a = 0,
      b = 0;
    for (let i = 0; i < 18; i++) {
      a |= bit(n - 11 + (i % 3), Math.floor(i / 3)) << i;
      b |= bit(Math.floor(i / 3), n - 11 + (i % 3)) << i;
    }
    expect(a).toBe(expected);
    expect(b).toBe(expected);
  }

  // Read the codewords in the zig-zag order, undoing the mask.
  const fmap = functionMap(ver);
  const bits: number[] = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) {
      const y = upward ? n - 1 - k : k;
      for (const x of [right, right - 1]) {
        if (fmap[y][x]) continue;
        bits.push(bit(x, y) ^ (maskFns[found.mask](x, y) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const { blocks, eccPerBlock, rawCodewords } = blockInfo(ver, found.ecl);
  expect(Math.floor(bits.length / 8)).toBe(rawCodewords);
  const words: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // De-interleave into blocks.
  const shortBlocks = blocks - (rawCodewords % blocks);
  const shortLen = Math.floor(rawCodewords / blocks);
  const blockData: number[][] = Array.from({ length: blocks }, () => []);
  let p = 0;
  for (let i = 0; i < shortLen - eccPerBlock + 1; i++)
    for (let b = 0; b < blocks; b++) if (i < shortLen - eccPerBlock || b >= shortBlocks) blockData[b].push(words[p++]);
  const blockEcc: number[][] = Array.from({ length: blocks }, () => []);
  for (let i = 0; i < eccPerBlock; i++) for (let b = 0; b < blocks; b++) blockEcc[b].push(words[p++]);

  // Every block is a codeword of the Reed-Solomon code: the syndromes S_i = c(alpha^i) vanish for i = 0..ecc-1.
  let syndromesZero = true;
  for (let b = 0; b < blocks; b++) {
    const cw = [...blockData[b], ...blockEcc[b]];
    for (let i = 0; i < eccPerBlock; i++) {
      const x = gpow(i);
      let s = 0;
      for (const c of cw) s = gmul(s, x) ^ c;
      if (s !== 0) syndromesZero = false;
    }
  }

  // Parse the byte-mode stream.
  const stream = blockData.flat();
  const sbits = stream.flatMap((w) => Array.from({ length: 8 }, (_, i) => (w >> (7 - i)) & 1));
  const take = (len: number) => {
    let v = 0;
    for (let i = 0; i < len; i++) v = (v << 1) | sbits.shift()!;
    return v;
  };
  expect(take(4)).toBe(0b0100);
  const count = take(ver < 10 ? 8 : 16);
  const data = new Uint8Array(count);
  for (let i = 0; i < count; i++) data[i] = take(8);
  return { ecl: found.ecl, mask: found.mask, version: ver, data, syndromesZero };
}

function sample(len: number, seed = 1): Uint8Array {
  const out = new Uint8Array(len);
  let s = seed;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s >> 16) & 0xff;
  }
  return out;
}

describe('QR encoder (DT-21)', () => {
  it('matches the spec: format and version information words, capacities, Reed-Solomon vector', () => {
    // ISO/IEC 18004 format information table (already masked): L / mask 0 and M / mask 0.
    expect(formatBits('L', 0)).toBe(0b111011111000100);
    expect(formatBits('M', 0)).toBe(0b101010000010010);
    // Version information table: version 7 and version 40.
    expect(versionBits(7)).toBe(0b000111110010010100);
    expect(versionBits(40)).toBe(0b101000110001101001);
    // Byte-mode capacities from the spec's data capacity table.
    const L = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271];
    const M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    for (let v = 1; v <= 10; v++) {
      expect(capacityBytes(v, 'L')).toBe(L[v - 1]);
      expect(capacityBytes(v, 'M')).toBe(M[v - 1]);
    }
    expect(maxBytes('L')).toBe(2953);
    expect(maxBytes('M')).toBe(2331);
    // Alignment pattern coordinates (spec Annex E).
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(14)).toEqual([6, 26, 46, 66]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
    // The widely published worked example: "HELLO WORLD" at 1-M has these 16 data codewords and 10 ECC codewords.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('round-trips through an independent reader for many sizes, levels and masks', () => {
    const cases: [number, QrEcl, number | undefined][] = [
      [0, 'M', undefined],
      [5, 'L', undefined],
      [14, 'M', 0],
      [17, 'L', 3],
      [26, 'M', 7],
      [60, 'M', undefined],
      [100, 'L', 5],
      [150, 'M', 2],
      [230, 'L', undefined], // version 9/10 boundary: 16-bit count
      [271, 'L', undefined],
      [500, 'M', 1],
      [900, 'L', 6],
      [1500, 'M', undefined],
      [2331, 'M', undefined], // version 40-M exactly full
      [2953, 'L', 4], // version 40-L exactly full
    ];
    for (const [len, ecl, mask] of cases) {
      const input = sample(len, len + 7);
      const qr = encodeQr(input, { ecl, mask });
      const d = decode(qr);
      expect(d.ecl, `ecl for ${len}`).toBe(ecl);
      if (mask !== undefined) expect(d.mask).toBe(mask);
      expect(d.syndromesZero, `RS syndromes for ${len} bytes at ${ecl}`).toBe(true);
      expect(Array.from(d.data), `payload for ${len} bytes at ${ecl}`).toEqual(Array.from(input));
      // smallest version that fits
      if (qr.version > 1) expect(capacityBytes(qr.version - 1, ecl)).toBeLessThan(len);
    }
  });

  it('every version 1..40 produces a decodable symbol (both levels, filling the capacity)', () => {
    for (let v = 1; v <= 40; v++)
      for (const ecl of ['L', 'M'] as const) {
        const len = capacityBytes(v, ecl);
        const input = sample(len, v * 3 + (ecl === 'L' ? 0 : 1));
        const qr = encodeQr(input, { ecl, minVersion: v, maxVersion: v });
        expect(qr.version).toBe(v);
        const d = decode(qr);
        expect(d.syndromesZero, `v${v}-${ecl}`).toBe(true);
        expect(Array.from(d.data), `v${v}-${ecl}`).toEqual(Array.from(input));
      }
  });

  it('encodes text as UTF-8 and picks M when it fits, L otherwise', () => {
    const text = 'https://example.com/#s=' + 'aB3_-'.repeat(30) + ' ✓';
    const qr = encodeQrBest(text);
    expect(qr.ecl).toBe('M');
    expect(new TextDecoder().decode(decode(qr).data)).toBe(text);
    const big = encodeQrBest(sample(2500));
    expect(big.ecl).toBe('L');
    expect(big.version).toBeGreaterThan(30);
  });

  it('rejects payloads that do not fit and says how much fits', () => {
    expect(() => encodeQr(sample(2954), { ecl: 'L' })).toThrow(QrTooLongError);
    expect(() => encodeQr(sample(2332), { ecl: 'M' })).toThrow(/2331/);
    expect(() => encodeQr(sample(30), { ecl: 'M', maxVersion: 2 })).toThrow(QrTooLongError);
  });

  it('renders an SVG whose dark path covers exactly the dark modules', () => {
    const qr = encodeQr('PhysixLab', { ecl: 'M' });
    const svg = qrToSvg(qr, 4);
    expect(svg).toContain(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`);
    // Rebuild the module set from the path ("M x,y h w v1 h -w z" runs) and compare with the matrix.
    const dark = new Set<string>();
    const path = /d="([^"]*)"/.exec(svg)![1];
    for (const m of path.matchAll(/M(\d+),(\d+)h(\d+)v1h-\d+z/g))
      for (let i = 0; i < Number(m[3]); i++) dark.add(`${Number(m[1]) - 4 + i},${Number(m[2]) - 4}`);
    let expected = 0;
    for (let y = 0; y < qr.size; y++)
      for (let x = 0; x < qr.size; x++) {
        if (qr.get(x, y)) expected++;
        expect(dark.has(`${x},${y}`)).toBe(qr.get(x, y));
      }
    expect(dark.size).toBe(expected);
  });
});

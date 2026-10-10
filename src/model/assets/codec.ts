/**
 * Binary payloads inside JSON: typed arrays as base64 strings (little-endian, which every browser and Node
 * target uses), plus a content hash for de-duplicating identical assets. Works in the main thread, workers
 * and Node (`btoa` / `atob` are available in all three).
 */

const CHUNK = 0x8000;

export function encodeBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Is `s` well-formed base64 (the alphabet, correct padding, a length that is a multiple of 4)? */
export function isBase64(s: string): boolean {
  return s.length % 4 === 0 && B64.test(s);
}

/** Decoded size of a base64 string without decoding it; -1 when it is not valid base64. */
export function base64ByteLength(s: string): number {
  if (!isBase64(s)) return -1;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

export function decodeBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

export const encodeF32 = (a: Float32Array): string => encodeBytes(bytesOf(a));
export const encodeU32 = (a: Uint32Array): string => encodeBytes(bytesOf(a));

/** Decode into a freshly allocated, aligned typed array; throws if the byte length is not a whole number of elements. */
export function decodeF32(s: string): Float32Array {
  const b = decodeBytes(s);
  if (b.length % 4) throw new Error('payload is not a whole number of 32-bit floats');
  return new Float32Array(b.buffer, 0, b.length / 4);
}

export function decodeU32(s: string): Uint32Array {
  const b = decodeBytes(s);
  if (b.length % 4) throw new Error('payload is not a whole number of 32-bit integers');
  return new Uint32Array(b.buffer, 0, b.length / 4);
}

/**
 * 128-bit content hash (cyrb128, public domain) as 32 hex characters. Not cryptographic: it identifies
 * identical payloads for de-duplication, where a chance collision is astronomically unlikely.
 */
export function contentHash(parts: readonly string[]): string {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const k = part.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    // a separator that cannot occur inside a part keeps ["ab","c"] and ["a","bc"] apart
    h1 = h2 ^ Math.imul(h1 ^ 0x1f, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ 0x1f, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ 0x1f, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ 0x1f, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

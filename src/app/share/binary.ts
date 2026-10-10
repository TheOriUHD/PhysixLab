/**
 * Compact binary serialisation of JSON-like values (DT-20). Not a general-purpose format: it is the layer under the
 * share-link codec and trades exactness of floats (6 significant digits) for size.
 *
 *   header   varint stringCount, then per string: varint byteLength + UTF-8 bytes   (keys and string values share it)
 *   value    tag byte + payload
 *     0 null · 1 false · 2 true · 3 int(zigzag varint) · 4 decimal(zigzag mantissa, zigzag exponent)
 *     5 float64 · 6 string(varint table index) · 7 array(varint n, values) · 8 object(varint n, (varint key, value)*)
 *     9 bytes(varint n, raw)  — a canonical base64 string is stored as the bytes it encodes, ~25 % smaller
 *     10 ref(varint n)        — the string `REF_PREFIX + n` (entity-id references, see compact.ts)
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const T = { NULL: 0, FALSE: 1, TRUE: 2, INT: 3, DEC: 4, F64: 5, STR: 6, ARR: 7, OBJ: 8, BYTES: 9, REF: 10 } as const;
/** Strings `REF_PREFIX + <digits>` are stored as a one-tag reference; compact.ts uses them for entity ids. */
export const REF_PREFIX = '\u0002';
// eslint-disable-next-line no-control-regex -- the reference marker is a control character on purpose
const REF_RE = /^\u0002(\d{1,9})$/;
const DIGITS = 6;
const MIN_BYTES_STRING = 48;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** What the encoder will reproduce for a number: integers stay exact, other numbers keep 6 significant digits. */
export function quantizeNumber(v: number): number {
  if (Number.isInteger(v)) return v === 0 ? 0 : v;
  return Number(v.toPrecision(DIGITS));
}

/** Deep copy of `v` with every number passed through `quantizeNumber`. */
export function quantize(v: Json): Json {
  if (typeof v === 'number') return quantizeNumber(v);
  if (Array.isArray(v)) return v.map(quantize);
  if (v && typeof v === 'object') {
    const o: { [k: string]: Json } = {};
    for (const k of Object.keys(v)) o[k] = quantize(v[k]);
    return o;
  }
  return v;
}

class Writer {
  buf = new Uint8Array(1024);
  n = 0;
  private ensure(extra: number): void {
    if (this.n + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + extra) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
  }
  byte(b: number): void {
    this.ensure(1);
    this.buf[this.n++] = b;
  }
  varint(v: number): void {
    // v is a non-negative safe integer; avoid 32-bit bit operations
    while (v >= 128) {
      this.byte((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    this.byte(v);
  }
  zigzag(v: number): void {
    this.varint(v < 0 ? -2 * v - 1 : 2 * v);
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  f64(v: number): void {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.n, v, true);
    this.n += 8;
  }
  result(): Uint8Array {
    return this.buf.subarray(0, this.n);
  }
}

class Reader {
  n = 0;
  constructor(readonly buf: Uint8Array) {}
  byte(): number {
    if (this.n >= this.buf.length) throw new Error('unexpected end of data');
    return this.buf[this.n++];
  }
  varint(): number {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = this.byte();
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
      if (mul > 2 ** 56) throw new Error('varint too long');
    }
  }
  zigzag(): number {
    const u = this.varint();
    return u % 2 === 1 ? -(u + 1) / 2 : u / 2;
  }
  bytes(len: number): Uint8Array {
    if (this.n + len > this.buf.length) throw new Error('unexpected end of data');
    const out = this.buf.subarray(this.n, this.n + len);
    this.n += len;
    return out;
  }
  f64(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.n, 8).getFloat64(0, true);
    this.n += 8;
    return v;
  }
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The bytes behind `s` when it is canonical base64 (so it round-trips exactly), else null. */
function canonicalBase64(s: string): Uint8Array | null {
  if (s.length < MIN_BYTES_STRING || s.length % 4 !== 0 || !B64.test(s)) return null;
  try {
    const b = b64ToBytes(s);
    return bytesToB64(b) === s ? b : null;
  } catch {
    return null;
  }
}

export function encodeBinary(value: Json): Uint8Array {
  const table = new Map<string, number>();
  const strings: string[] = [];
  const intern = (s: string): number => {
    let i = table.get(s);
    if (i === undefined) {
      i = strings.length;
      table.set(s, i);
      strings.push(s);
    }
    return i;
  };
  const body = new Writer();
  const enc = new TextEncoder();
  const put = (v: Json): void => {
    if (v === null) body.byte(T.NULL);
    else if (v === true) body.byte(T.TRUE);
    else if (v === false) body.byte(T.FALSE);
    else if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER / 2) {
        body.byte(T.INT);
        body.zigzag(v);
        return;
      }
      const q = quantizeNumber(v);
      const [m, e] = q.toExponential(DIGITS - 1).split('e');
      let mant = Math.round(Number(m.replace('.', '')));
      let exp = Number(e) - (DIGITS - 1);
      while (mant !== 0 && mant % 10 === 0) {
        mant /= 10;
        exp++;
      }
      if (Number.isFinite(q) && Number(`${mant}e${exp}`) === q) {
        body.byte(T.DEC);
        body.zigzag(mant);
        body.zigzag(exp);
      } else {
        body.byte(T.F64);
        body.f64(v);
      }
    } else if (typeof v === 'string') {
      const ref = REF_RE.exec(v);
      const raw = ref ? null : canonicalBase64(v);
      if (ref) {
        body.byte(T.REF);
        body.varint(Number(ref[1]));
      } else if (raw) {
        body.byte(T.BYTES);
        body.varint(raw.length);
        body.bytes(raw);
      } else {
        body.byte(T.STR);
        body.varint(intern(v));
      }
    } else if (Array.isArray(v)) {
      body.byte(T.ARR);
      body.varint(v.length);
      for (const x of v) put(x);
    } else {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      body.byte(T.OBJ);
      body.varint(keys.length);
      for (const k of keys) {
        body.varint(intern(k));
        put(v[k]);
      }
    }
  };
  put(value);
  const head = new Writer();
  head.varint(strings.length);
  for (const s of strings) {
    const b = enc.encode(s);
    head.varint(b.length);
    head.bytes(b);
  }
  const out = new Uint8Array(head.n + body.n);
  out.set(head.result(), 0);
  out.set(body.result(), head.n);
  return out;
}

export function decodeBinary(data: Uint8Array): Json {
  const r = new Reader(data);
  const dec = new TextDecoder('utf-8', { fatal: true });
  const strings: string[] = [];
  const count = r.varint();
  if (count > data.length) throw new Error('corrupt string table');
  for (let i = 0; i < count; i++) strings.push(dec.decode(r.bytes(r.varint())));
  const str = (i: number): string => {
    if (i >= strings.length) throw new Error('bad string index');
    return strings[i];
  };
  let depth = 0;
  const get = (): Json => {
    const tag = r.byte();
    switch (tag) {
      case T.NULL:
        return null;
      case T.FALSE:
        return false;
      case T.TRUE:
        return true;
      case T.INT:
        return r.zigzag();
      case T.DEC: {
        const m = r.zigzag();
        const e = r.zigzag();
        return Number(`${m}e${e}`);
      }
      case T.F64:
        return r.f64();
      case T.STR:
        return str(r.varint());
      case T.REF:
        return REF_PREFIX + String(r.varint());
      case T.BYTES:
        return bytesToB64(r.bytes(r.varint()));
      case T.ARR: {
        if (++depth > 64) throw new Error('nesting too deep');
        const n = r.varint();
        if (n > data.length) throw new Error('corrupt array length');
        const a: Json[] = [];
        for (let i = 0; i < n; i++) a.push(get());
        depth--;
        return a;
      }
      case T.OBJ: {
        if (++depth > 64) throw new Error('nesting too deep');
        const n = r.varint();
        if (n > data.length) throw new Error('corrupt object size');
        const o: { [k: string]: Json } = {};
        for (let i = 0; i < n; i++) {
          const k = str(r.varint());
          if (k === '__proto__') throw new Error('forbidden key');
          o[k] = get();
        }
        depth--;
        return o;
      }
      default:
        throw new Error(`unknown tag ${tag}`);
    }
  };
  const v = get();
  if (r.n !== data.length) throw new Error('trailing data');
  return v;
}

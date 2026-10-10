/**
 * Share-link codec v2 (DT-20): scene document → quantised, entity-delta-coded binary → deflate-raw → base64url.
 *
 * Why it is shorter than the v1 link (JSON + deflate): numbers keep 7 significant digits (not 17), every key and
 * string is stored once in a string table, base64 asset payloads are stored as raw bytes, and each entity is stored
 * as the difference to the previous entity of the same kind, so a wall of identical bricks costs only their ids,
 * names and positions. The codec knows nothing about individual fields, so new document fields are carried for free;
 * the decoder's output goes through `sanitizeDocument` like every other document.
 */
import type { SceneDocument } from '../../model/types';
import { decodeBinary, encodeBinary, quantize, REF_PREFIX, type Json } from './binary';
import { DEFAULT_COMPONENTS, DEFAULT_ENTITIES, DEFAULT_SETTINGS } from './defaults';

/** First byte of a v2 payload (before the deflated stream). */
export const COMPACT_VERSION = 2;
const DELETED = '\u0001del';
const DOC_FORMAT = 'physicslab-scene';

type Obj = { [k: string]: Json };
const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
const isObj = (v: Json | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// The frozen defaults (defaults.ts), quantised exactly like a document so equal values compare equal.
const DEFAULT_SETTINGS_Q = quantize(DEFAULT_SETTINGS);
const defaultsByKind = new Map<string, Json[]>();
for (const e of DEFAULT_ENTITIES) {
  const q = quantize(e) as Obj;
  const kind = str(q.kind);
  defaultsByKind.set(kind, [...(defaultsByKind.get(kind) ?? []), q]);
}

function equal(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && equal(a[k], b[k]));
  }
  return false;
}

/** The smallest value that turns `base` into `val`; `undefined` when they are equal. */
function diff(base: Json | undefined, val: Json): Json | undefined {
  if (equal(base, val)) return undefined;
  if (!isObj(base) || !isObj(val)) return val;
  const out: Obj = {};
  for (const k of Object.keys(val)) {
    const d = diff(base[k], val[k]);
    if (d !== undefined) out[k] = d;
  }
  const gone = Object.keys(base).filter((k) => !(k in val));
  if (gone.length) out[DELETED] = gone;
  return out;
}

function patch(base: Json | undefined, d: Json): Json {
  if (!isObj(base) || !isObj(d)) return d;
  const out: Obj = { ...base };
  for (const k of Object.keys(d)) {
    if (k === DELETED) continue;
    out[k] = k in base ? patch(base[k], d[k]) : d[k];
  }
  const gone = d[DELETED];
  if (Array.isArray(gone)) for (const k of gone) if (typeof k === 'string') delete out[k];
  return out;
}

/** How many previous entities of the same kind an entity may be stored relative to. */
const RECENT = 6;

/** Base list for an entity: its last `RECENT` same-kind predecessors (newest first, padded with {}), then the frozen defaults. */
function baseCandidates(recent: Json[], kind: string): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < RECENT; i++) out.push(recent[i] ?? {});
  return out.concat(defaultsByKind.get(kind) ?? []);
}

const DEFAULT_COMPONENTS_Q = new Map(Object.entries(DEFAULT_COMPONENTS).map(([t, c]) => [t, quantize(c)]));
function componentBases(last: Json | undefined, type: string): [Json, Json] {
  return [last ?? {}, DEFAULT_COMPONENTS_Q.get(type) ?? {}];
}

/** Document → packed bytes (header byte + deflate-raw stream). */
export async function encodeCompact(doc: SceneDocument): Promise<Uint8Array> {
  const q = quantize(doc as unknown as Json) as Obj;
  const entities = (q.entities as Obj[]) ?? [];
  const index = new Map<string, number>();
  entities.forEach((e, i) => index.set(str(e.id), i));
  // Components have ids too (c_…); they are numbered after the entities.
  let nextRef = entities.length;
  for (const e of entities)
    if (Array.isArray(e.components))
      for (const c of e.components) if (isObj(c) && typeof c.id === 'string') index.set(c.id, nextRef++);
  // Entity ids are random strings nobody sees: store positions instead and let the decoder name them e0, e1 …
  const refs = (v: Json): Json => {
    if (typeof v === 'string') {
      if (v.startsWith(REF_PREFIX)) throw new Error('reserved character in a string');
      const i = index.get(v);
      return i === undefined ? v : REF_PREFIX + String(i);
    }
    if (Array.isArray(v)) return v.map(refs);
    if (isObj(v)) {
      const o: Obj = {};
      for (const k of Object.keys(v)) o[k] = refs(v[k]);
      return o;
    }
    return v;
  };
  const recent = new Map<string, Obj[]>();
  const lastComp = new Map<string, Obj>();
  const packed: Json[] = entities.map((e) => {
    const kind = str(e.kind);
    const { id: _id, components, ...rest } = e;
    void _id;
    const mine = refs(rest) as Obj;
    // Components (behaviours with big parameter sets) are stored relative to the previous component of the same type.
    const comps: Json[] | null = Array.isArray(components)
      ? components.map((c) => {
          if (!isObj(c)) return [''] as Json;
          const { id: _cid, ...crest } = c;
          void _cid;
          const type = str(crest.type);
          const mineC = refs(crest) as Obj;
          // base 0: the previous component of this type; base 1: the frozen default of the type
          const bases = componentBases(lastComp.get(type), type);
          const d0 = diff(bases[0], mineC) ?? {};
          const d1 = diff(bases[1], mineC) ?? {};
          lastComp.set(type, mineC);
          return JSON.stringify(d1).length < JSON.stringify(d0).length ? [type, 1, d1] : [type, 0, d0];
        })
      : null;
    // Candidate bases: the previous entity of this kind, then the frozen defaults of this kind; keep the cheapest.
    const bases = baseCandidates(recent.get(kind) ?? [], kind);
    let best = 0;
    let bestDiff = diff(bases[0], mine) ?? {};
    let bestLen = JSON.stringify(bestDiff).length;
    for (let i = 1; i < bases.length; i++) {
      const d = diff(bases[i], mine) ?? {};
      const len = JSON.stringify(d).length;
      if (len < bestLen) {
        best = i;
        bestDiff = d;
        bestLen = len;
      }
    }
    recent.set(kind, [mine, ...(recent.get(kind) ?? [])].slice(0, RECENT));
    return comps ? [kind, best, bestDiff, comps] : [kind, best, bestDiff];
  });
  const { entities: _e, settings, ...top } = q;
  void _e;
  if (top.format === DOC_FORMAT) delete top.format;
  const head: Obj = { ...(refs(top) as Obj), s: diff(DEFAULT_SETTINGS_Q, settings) ?? {}, e: packed };
  const raw = encodeBinary(head);
  const z = await deflate(raw);
  const out = new Uint8Array(z.length + 1);
  out[0] = COMPACT_VERSION;
  out.set(z, 1);
  return out;
}

/** Inverse of `encodeCompact`; the result is an unsanitised document object (pass it to `sanitizeDocument`). */
export async function decodeCompact(data: Uint8Array): Promise<unknown> {
  if (data[0] !== COMPACT_VERSION) throw new Error('not a compact share payload');
  const v = decodeBinary(await inflate(data.subarray(1)));
  if (!isObj(v) || !Array.isArray(v.e) || !isObj(v.s)) throw new Error('not a scene');
  const entityCount = v.e.length;
  const refName = (n: number): string => (n < entityCount ? `e${n}` : `c${n - entityCount}`);
  const unref = (x: Json): Json => {
    if (typeof x === 'string') return x.startsWith(REF_PREFIX) ? refName(Number(x.slice(1))) : x;
    if (Array.isArray(x)) return x.map(unref);
    if (isObj(x)) {
      const o: Obj = {};
      for (const k of Object.keys(x)) o[k] = unref(x[k]);
      return o;
    }
    return x;
  };
  const recent = new Map<string, Json[]>();
  const lastComp = new Map<string, Json>();
  let nextRef = entityCount;
  const entities = v.e.map((p, i) => {
    if (!Array.isArray(p) || typeof p[0] !== 'string' || typeof p[1] !== 'number') throw new Error('bad entity record');
    const kind = p[0];
    const base = baseCandidates(recent.get(kind) ?? [], kind)[p[1]] ?? {};
    const e = patch(base, p[2]);
    recent.set(kind, [e, ...(recent.get(kind) ?? [])].slice(0, RECENT));
    const out: Obj = { ...(e as Obj), id: REF_PREFIX + String(i) };
    if (p[3] !== undefined) {
      if (!Array.isArray(p[3])) throw new Error('bad component list');
      out.components = p[3].map((c) => {
        if (!Array.isArray(c) || typeof c[0] !== 'string') throw new Error('bad component record');
        const full = patch(componentBases(lastComp.get(c[0]), c[0])[c[1] === 1 ? 1 : 0], c[2] ?? {});
        lastComp.set(c[0], full);
        return { ...(full as Obj), id: REF_PREFIX + String(nextRef++) };
      });
    }
    return unref(out);
  });
  const { e: _e, s, ...top } = v;
  void _e;
  return { format: DOC_FORMAT, ...(unref(top) as Obj), settings: patch(DEFAULT_SETTINGS_Q, s), entities };
}

/** Key-order-independent text of a value, for comparing documents. */
export function canonicalText(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
}

/** What `decodeCompact(encodeCompact(doc))` returns for a loss-free codec: numbers quantised, entity ids renamed e0, e1 … */
export function expectedAfterRoundTrip(doc: SceneDocument): unknown {
  const q = quantize(doc as unknown as Json) as Obj;
  const names = new Map<string, string>();
  const ents = q.entities as Obj[];
  ents.forEach((e, i) => names.set(str(e.id), `e${i}`));
  let k = 0;
  for (const e of ents)
    if (Array.isArray(e.components))
      for (const c of e.components) if (isObj(c) && typeof c.id === 'string') names.set(c.id, `c${k++}`);
  const rename = (v: Json): Json => {
    if (typeof v === 'string') return names.get(v) ?? v;
    if (Array.isArray(v)) return v.map(rename);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)]));
    return v;
  };
  return rename(q);
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
export const deflate = (d: Uint8Array): Promise<Uint8Array> => pipe(d, new CompressionStream('deflate-raw'));
export const inflate = (d: Uint8Array): Promise<Uint8Array> => pipe(d, new DecompressionStream('deflate-raw'));

export function toBase64Url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * DT-23 — the CRDT-lite operation log behind live collaboration. Pure TypeScript (runs in Node and the page).
 *
 * The replicated state is a set of **last-writer-wins registers**:
 *   - one existence register per entity (`add` / `del` stamps; the entity is visible when its newest `add`
 *     stamp is greater than its newest `del` stamp, so a delete beats a concurrent edit and a re-add after a
 *     delete wins),
 *   - one register per (entity, field) holding that field's value (or "absent"),
 *   - one register per scene-config key (scene settings fields and the scene name).
 * A **stamp** is `(lamport clock, site id)` compared lexicographically, so concurrent writes are ordered the
 * same way on every replica. Every operation carries a unique stamp; applying an operation only ever replaces a
 * register by a strictly greater stamp. That makes `apply` commutative, associative and idempotent: replicas that
 * have seen the same set of operations hold the same registers whatever the order or number of deliveries,
 * and a duplicate (or echoed) operation changes nothing (`apply` returns false), which is also what stops relay
 * loops. The log itself is never stored: only the registers are (memory is bounded by the document, not by history).
 *
 * Peers are untrusted: `parseOps` validates the shape of everything that arrives (sizes, key names, clocks).
 * The *meaning* of a materialised entity is checked afterwards by the document sanitiser (`docSync.ts`).
 */
import { LIMITS } from '../model/limits';

export interface Stamp {
  /** Lamport clock. */
  c: number;
  /** Site (replica) id. */
  s: string;
}

export type Op =
  | { k: 'add'; c: number; s: string; e: string }
  | { k: 'del'; c: number; s: string; e: string }
  /** Set entity field `f` to `v`; an absent `v` deletes the field. */
  | { k: 'set'; c: number; s: string; e: string; f: string; v?: unknown }
  /** Set a scene-level key (`@name`, or a `SceneSettings` field). */
  | { k: 'cfg'; c: number; s: string; f: string; v?: unknown };

/** Hard limits applied to everything that arrives from a peer. */
export const OP_LIMITS = {
  /** Operations in one message. */
  maxOpsPerMessage: 4000,
  /** JSON length of one field value. */
  maxValueChars: 262_144,
  /** Fields one entity may carry / scene-level keys. */
  maxFieldsPerEntity: 128,
  maxCfgKeys: 64,
  /** Entities the replica holds (alive or tombstoned). */
  maxEntities: LIMITS.maxEntities * 2,
  maxFieldChars: 48,
  maxClock: 2 ** 48,
} as const;

const SITE_RE = /^[A-Za-z0-9]{4,24}$/;
const FIELD_RE = /^[@A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export const stampCompare = (a: Stamp, b: Stamp): number =>
  a.c !== b.c ? a.c - b.c : a.s < b.s ? -1 : a.s > b.s ? 1 : 0;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= LIMITS.maxIdLength;
const isField = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= OP_LIMITS.maxFieldChars && FIELD_RE.test(v) && !FORBIDDEN.has(v);

/** Is this a well-formed site id? */
export const isSiteId = (v: unknown): v is string => typeof v === 'string' && SITE_RE.test(v);

/** Stable id of an operation (unique because a site never reuses a clock value). */
export const opId = (op: Pick<Op, 'c' | 's'>): string => `${op.s}:${op.c}`;

function sizeOk(v: unknown): boolean {
  try {
    const text = JSON.stringify(v);
    return text !== undefined && text.length <= OP_LIMITS.maxValueChars;
  } catch {
    return false;
  }
}

/** Validate one untrusted operation; null when it is malformed. Unknown properties are dropped. */
export function parseOp(raw: unknown): Op | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const c = r.c;
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > OP_LIMITS.maxClock) return null;
  if (!isSiteId(r.s)) return null;
  const s = r.s;
  switch (r.k) {
    case 'add':
    case 'del':
      return isId(r.e) ? { k: r.k, c, s, e: r.e } : null;
    case 'set': {
      if (!isId(r.e) || !isField(r.f)) return null;
      if (r.v === undefined) return { k: 'set', c, s, e: r.e, f: r.f };
      return sizeOk(r.v) ? { k: 'set', c, s, e: r.e, f: r.f, v: r.v } : null;
    }
    case 'cfg': {
      if (!isField(r.f)) return null;
      if (r.v === undefined) return { k: 'cfg', c, s, f: r.f };
      return sizeOk(r.v) ? { k: 'cfg', c, s, f: r.f, v: r.v } : null;
    }
    default:
      return null;
  }
}

/** Validate an untrusted array of operations. Over-long arrays are rejected whole. */
export function parseOps(raw: unknown): { ops: Op[]; rejected: number } {
  if (!Array.isArray(raw)) return { ops: [], rejected: 1 };
  if (raw.length > OP_LIMITS.maxOpsPerMessage) return { ops: [], rejected: raw.length };
  const ops: Op[] = [];
  let rejected = 0;
  for (const r of raw) {
    const op = parseOp(r);
    if (op) ops.push(op);
    else rejected++;
  }
  return { ops, rejected };
}

interface Reg {
  s: Stamp;
  has: boolean;
  v?: unknown;
}
interface EntRec {
  add: Stamp | null;
  del: Stamp | null;
  fields: Map<string, Reg>;
}

export interface Materialized {
  /** Visible entities, in a deterministic order (by creation stamp). */
  entities: Record<string, unknown>[];
  cfg: Record<string, unknown>;
}

export class Replica {
  private clock = 0;
  private readonly ents = new Map<string, EntRec>();
  private readonly cfg = new Map<string, Reg>();

  constructor(readonly site: string) {
    if (!SITE_RE.test(site)) throw new Error(`invalid site id "${site}"`);
  }

  get lamport(): number {
    return this.clock;
  }

  // ---- local operations (applied to this replica and returned for broadcasting) -----------------

  private next(): { c: number; s: string } {
    return { c: ++this.clock, s: this.site };
  }

  /** Create an entity with the given fields (one `add` plus one `set` per field). */
  localAdd(id: string, fields: Record<string, unknown>): Op[] {
    const out: Op[] = [{ k: 'add', ...this.next(), e: id }];
    this.apply(out[0]);
    for (const f of Object.keys(fields)) out.push(this.localSet(id, f, fields[f]));
    return out;
  }

  /** Set (or with `undefined`, delete) one field. */
  localSet(id: string, f: string, v: unknown): Op {
    const op: Op = v === undefined ? { k: 'set', ...this.next(), e: id, f } : { k: 'set', ...this.next(), e: id, f, v };
    this.apply(op);
    return op;
  }

  localDel(id: string): Op {
    const op: Op = { k: 'del', ...this.next(), e: id };
    this.apply(op);
    return op;
  }

  localCfg(f: string, v: unknown): Op {
    const op: Op = v === undefined ? { k: 'cfg', ...this.next(), f } : { k: 'cfg', ...this.next(), f, v };
    this.apply(op);
    return op;
  }

  // ---- applying operations -----------------------------------------------------------------------

  /** Apply one (already validated) operation. True when it changed a register — false for duplicates, echoes and losers. */
  apply(op: Op): boolean {
    if (op.c > this.clock) this.clock = op.c;
    const stamp: Stamp = { c: op.c, s: op.s };
    if (op.k === 'cfg') return this.write(this.cfg, op.f, stamp, op.v, OP_LIMITS.maxCfgKeys);
    let rec = this.ents.get(op.e);
    if (!rec) {
      if (this.ents.size >= OP_LIMITS.maxEntities) return false;
      rec = { add: null, del: null, fields: new Map() };
      this.ents.set(op.e, rec);
    }
    if (op.k === 'add') {
      if (rec.add && stampCompare(stamp, rec.add) <= 0) return false;
      rec.add = stamp;
      return true;
    }
    if (op.k === 'del') {
      if (rec.del && stampCompare(stamp, rec.del) <= 0) return false;
      rec.del = stamp;
      return true;
    }
    return this.write(rec.fields, op.f, stamp, op.v, OP_LIMITS.maxFieldsPerEntity);
  }

  private write(map: Map<string, Reg>, key: string, s: Stamp, v: unknown, cap: number): boolean {
    const cur = map.get(key);
    if (cur) {
      if (stampCompare(s, cur.s) <= 0) return false;
    } else if (map.size >= cap) return false;
    map.set(key, v === undefined ? { s, has: false } : { s, has: true, v });
    return true;
  }

  /** Apply many; returns how many changed a register. */
  applyAll(ops: readonly Op[]): number {
    let n = 0;
    for (const op of ops) if (this.apply(op)) n++;
    return n;
  }

  // ---- reading -----------------------------------------------------------------------------------

  isVisible(id: string): boolean {
    const r = this.ents.get(id);
    return !!r && !!r.add && (!r.del || stampCompare(r.add, r.del) > 0);
  }

  /** The current state as plain data, entities ordered by creation stamp (deterministic on every replica). */
  materialize(): Materialized {
    const live: [string, EntRec][] = [];
    for (const [id, r] of this.ents) if (this.isVisible(id)) live.push([id, r]);
    live.sort((a, b) => stampCompare(a[1].add as Stamp, b[1].add as Stamp));
    const entities = live.map(([id, r]) => {
      const o: Record<string, unknown> = {};
      for (const f of [...r.fields.keys()].sort()) {
        const reg = r.fields.get(f) as Reg;
        if (reg.has) o[f] = reg.v;
      }
      o.id = id;
      return o;
    });
    const cfg: Record<string, unknown> = {};
    for (const f of [...this.cfg.keys()].sort()) {
      const reg = this.cfg.get(f) as Reg;
      if (reg.has) cfg[f] = reg.v;
    }
    return { entities, cfg };
  }

  /** The whole state as operations (with their original stamps) — what a joining peer is sent. */
  snapshot(): Op[] {
    const out: Op[] = [];
    const reg = (r: Reg) => (r.has ? { v: r.v } : {});
    for (const [f, r] of this.cfg) out.push({ k: 'cfg', c: r.s.c, s: r.s.s, f, ...reg(r) });
    for (const [e, r] of this.ents) {
      if (r.add) out.push({ k: 'add', c: r.add.c, s: r.add.s, e });
      if (r.del) out.push({ k: 'del', c: r.del.c, s: r.del.s, e });
      for (const [f, fr] of r.fields) out.push({ k: 'set', c: fr.s.c, s: fr.s.s, e, f, ...reg(fr) });
    }
    return out;
  }
}

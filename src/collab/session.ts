/**
 * DT-23 — a collaboration session: one host, any number of guests, over one or more `Link`s (transport.ts).
 *
 * Topology: the host is the hub. Over BroadcastChannel everyone hears everyone (one bus link); over WebRTC the host
 * holds one link per guest and relays operations / presence between them. A guest joins by sending `hello`; the
 * host answers with `sync` chunks (its whole replica as operations) and from then on both sides exchange `ops`.
 *
 * What is shared:
 *   - the document (operations, see opLog.ts / docSync.ts) — everybody may edit, conflicts resolve last-writer-wins
 *     per field with a deterministic tie-break;
 *   - selection ("presence"): each peer's selected entity ids, shown to the others as coloured outlines;
 *   - the simulation: **host-authoritative**. The host broadcasts its mode (edit / paused / running; "edit" = reset);
 *     guests follow it and cannot start, pause or reset it themselves. Every peer runs the same deterministic engine
 *     on the same document, so guests are viewers of the host's run (no pose streaming, so they can drift slowly —
 *     docs/COLLAB.md).
 *
 * Peers are untrusted: every message is size-limited, JSON-parsed defensively and validated field by field before it
 * touches anything; operations additionally go through `parseOps` and the document sanitiser.
 */
import { Emitter } from '../core/events';
import type { SceneStore } from '../model/store';
import { DocSync } from './docSync';
import { Replica, isSiteId, parseOps, type Op } from './opLog';
import { MAX_MESSAGE_CHARS, type Link } from './transport';

export type SimMode = 'edit' | 'paused' | 'running';
export type Role = 'host' | 'guest';
export type SessionStatus = 'idle' | 'connecting' | 'live' | 'closed';

/** The part of the simulation controller a session needs (an adapter, so this file stays DOM-free). */
export interface SimBridge {
  mode(): SimMode;
  set(mode: SimMode): void;
  onMode(cb: (mode: SimMode) => void): () => void;
}

export interface PeerInfo {
  site: string;
  name: string;
  /** CSS colour derived from the site id (never taken from the wire). */
  color: string;
  role: Role;
  selection: string[];
}

interface SessionEvents extends Record<string, unknown> {
  peers: undefined;
  status: SessionStatus;
  notice: string;
}

const MAX_PEERS = 32;
const MAX_SELECTION = 64;
const SYNC_CHUNK = 1000;
/** Serialized-size budget of one `ops` / `sync` message body (well under MAX_MESSAGE_CHARS, leaves room for the envelope). */
const CHUNK_CHARS = 2_000_000;
/** An op may carry a clock at most this far ahead of the local Lamport clock (a forged huge clock would wedge the log). */
const MAX_CLOCK_AHEAD = 1_000_000;
/** The host's snapshot is allowed a bigger jump (a long-lived session legitimately has a large clock). */
const MAX_SYNC_CLOCK_AHEAD = 1_000_000_000;
/** Remote documents are materialised at most this often (ms). */
const APPLY_GAP_MS = 50;
const DEFAULT_RATE = { burst: 400, perSec: 200 };

/** Split operations into chunks of at most `maxOps` operations and about `maxChars` serialized characters. */
export function chunkOps(ops: readonly Op[], maxOps = SYNC_CHUNK, maxChars = CHUNK_CHARS): Op[][] {
  const out: Op[][] = [];
  let cur: Op[] = [];
  let size = 0;
  for (const op of ops) {
    const len = JSON.stringify(op).length + 1;
    if (cur.length && (cur.length >= maxOps || size + len > maxChars)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(op);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}
const MODES: readonly SimMode[] = ['edit', 'paused', 'running'];

export const randomSite = (): string => {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return 'p' + Array.from(buf, (b) => b.toString(36).padStart(2, '0')).join('');
};

export function colorOf(site: string): string {
  let h = 2166136261;
  for (let i = 0; i < site.length; i++) h = Math.imul(h ^ site.charCodeAt(i), 16777619);
  return `hsl(${(h >>> 0) % 360} 75% 55%)`;
}

/** A display name from untrusted text: control characters removed, at most 24 characters. */
export function cleanName(v: unknown, fallback = 'Guest'): string {
  if (typeof v !== 'string') return fallback;
  const s = Array.from(v)
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127 && ch !== '<' && ch !== '>')
    .join('')
    .trim()
    .slice(0, 24);
  return s || fallback;
}

function cleanSelection(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64).slice(0, MAX_SELECTION);
}

export interface SessionOptions {
  store: SceneStore;
  sim: SimBridge;
  name?: string;
  site?: string;
  /** Delay before local operations are batched and sent (ms). */
  flushMs?: number;
  /** Give up waiting for the host's answer after this many ms. */
  joinTimeoutMs?: number;
  /** Per-peer inbound token bucket: `burst` messages at once, refilled at `perSec` (a message with many ops costs more). */
  rate?: { burst: number; perSec: number };
  /** Clock for the rate limiter (ms); tests inject one. */
  now?: () => number;
}

export class Session extends Emitter<SessionEvents> {
  readonly site: string;
  name: string;
  role: Role | null = null;
  status: SessionStatus = 'idle';
  readonly replica: Replica;
  readonly sync: DocSync;

  private readonly links = new Set<Link>();
  private readonly linkSite = new Map<Link, string>();
  private readonly peerMap = new Map<string, PeerInfo>();
  private pending: Op[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hostSite: string | null = null;
  private hostMode: SimMode = 'edit';
  private applyingSim = false;
  private syncGot = 0;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private offs: (() => void)[] = [];
  private readonly buckets = new Map<string, { tokens: number; t: number }>();
  private lastRateNotice = -Infinity;
  /** Counters for diagnostics / tests. */
  stats = { rejectedMessages: 0, rejectedOps: 0, appliedOps: 0, duplicateOps: 0, rateLimited: 0 };

  constructor(private readonly o: SessionOptions) {
    super();
    this.site = o.site ?? randomSite();
    this.name = cleanName(o.name, 'Host');
    this.replica = new Replica(this.site);
    this.sync = new DocSync(o.store, this.replica, (ops) => {
      this.pending.push(...ops);
      this.scheduleFlush();
    });
  }

  get peers(): PeerInfo[] {
    return [...this.peerMap.values()];
  }

  private setStatus(s: SessionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  // ---- starting / joining / leaving ----------------------------------------------------------------

  /** Become the host: the current document is what guests will receive. Call `addLink` for each transport. */
  startHost(): void {
    this.begin('host');
    this.sync.attach();
    this.hostSite = this.site;
    this.hostMode = this.o.sim.mode();
    this.setStatus('live');
  }

  /** Join through `link`. The local document is replaced by the host's. */
  join(link: Link): void {
    this.begin('guest');
    this.name = cleanName(this.name, 'Guest');
    this.sync.clearSilently();
    this.sync.attach();
    this.setStatus('connecting');
    this.addLink(link);
    const hello = () => this.sendTo(link, { t: 'hello', from: this.site, name: this.name, role: 'guest' });
    if (link.state === 'open') hello();
    else link.on('open', hello);
    this.joinTimer = setTimeout(() => {
      if (this.status === 'connecting') {
        this.notice(
          'No host answered. Check the room code (or the connection code) and that the host is still online.',
        );
        this.leave();
      }
    }, this.o.joinTimeoutMs ?? 8000);
  }

  private begin(role: Role): void {
    if (this.role) throw new Error('already in a session');
    this.role = role;
    this.offs.push(
      this.o.store.on('selection', () => this.scheduleFlush()),
      this.o.sim.onMode((m) => this.onLocalMode(m)),
    );
  }

  /** Attach a transport. */
  addLink(link: Link): void {
    if (!this.role) throw new Error('start or join a session first');
    this.links.add(link);
    link.on('message', (text) => this.onMessage(link, text));
    link.on('close', () => this.onLinkClosed(link));
  }

  leave(): void {
    if (this.status === 'closed' || this.status === 'idle') return;
    this.flushNow();
    this.sync.commitRemote();
    this.broadcast({ t: 'bye', from: this.site });
    for (const off of this.offs) off();
    this.offs = [];
    this.sync.detach();
    if (this.timer) clearTimeout(this.timer);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.timer = this.joinTimer = null;
    for (const l of this.links) l.close();
    this.links.clear();
    this.peerMap.clear();
    this.setStatus('closed');
    this.emit('peers', undefined);
  }

  private notice(text: string): void {
    this.emit('notice', text);
  }

  // ---- sending -------------------------------------------------------------------------------------

  /** Send one message; false (after telling the user) when it is too large or the link failed. Never drops silently. */
  private sendTo(link: Link, msg: object): boolean {
    if (link.state !== 'open') return false;
    try {
      const text = JSON.stringify(msg);
      if (text.length > MAX_MESSAGE_CHARS) {
        this.notice('A change was too large to send to the other peers and was not delivered.');
        return false;
      }
      link.send(text);
      return true;
    } catch {
      return false; /* the link closed under us */
    }
  }

  private broadcast(msg: object, except?: Link): void {
    for (const l of this.links) if (l !== except) this.sendTo(l, msg);
  }

  private scheduleFlush(): void {
    if (this.timer || !this.role) return;
    this.timer = setTimeout(() => this.flushNow(), this.o.flushMs ?? 20);
  }

  /** Send everything buffered: operations first, then presence. */
  flushNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.role) return;
    this.sync.flush();
    const ops = this.pending;
    this.pending = [];
    for (const chunk of chunkOps(ops)) this.broadcast({ t: 'ops', from: this.site, ops: chunk });
    this.sendPresence(false);
  }

  private lastSel = '';
  private sendPresence(force = true): void {
    const key = this.o.store.selection.join(',');
    if (!force && key === this.lastSel) return;
    this.lastSel = key;
    this.broadcast({
      t: 'presence',
      from: this.site,
      name: this.name,
      role: this.role,
      sel: this.o.store.selection.slice(0, MAX_SELECTION),
    });
  }

  // ---- simulation (host-authoritative) -------------------------------------------------------------

  private onLocalMode(m: SimMode): void {
    if (this.applyingSim) return;
    if (this.role === 'host') {
      this.hostMode = m;
      this.flushNow();
      this.broadcast({ t: 'sim', from: this.site, mode: m });
    } else if (m !== this.hostMode) {
      this.notice("The host controls the simulation - guests follow the host's play, pause and reset.");
      this.followHost();
    }
  }

  private followHost(): void {
    if (this.o.sim.mode() === this.hostMode) return;
    this.applyingSim = true;
    try {
      this.o.sim.set(this.hostMode);
    } finally {
      this.applyingSim = false;
    }
  }

  // ---- receiving -----------------------------------------------------------------------------------

  private reject(): void {
    this.stats.rejectedMessages++;
  }

  private clock(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** Token bucket per sending peer. */
  private allow(key: string, cost: number): boolean {
    const { burst, perSec } = this.o.rate ?? DEFAULT_RATE;
    const now = this.clock();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= 256) this.buckets.clear();
      b = { tokens: burst, t: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(burst, b.tokens + ((now - b.t) / 1000) * perSec);
    b.t = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  private onMessage(link: Link, text: string): void {
    if (this.status === 'closed') return;
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return this.reject();
      msg = parsed as Record<string, unknown>;
    } catch {
      return this.reject();
    }
    const from = msg.from;
    if (from === this.site) return; // our own echo on a bus
    if (!isSiteId(from)) return this.reject();
    // A host talking to one guest per link: that link may only ever carry that guest's messages.
    if (this.role === 'host' && link.kind === 'webrtc') {
      const bound = this.linkSite.get(link);
      if (!bound) {
        if (msg.t !== 'hello') return this.reject();
        this.linkSite.set(link, from);
      } else if (bound !== from) return this.reject();
    }
    if (msg.t !== 'sync' && !this.allow(from, 1 + (Array.isArray(msg.ops) ? Math.floor(msg.ops.length / 100) : 0))) {
      this.stats.rateLimited++;
      const t = this.clock();
      if (t - this.lastRateNotice > 5000) {
        this.lastRateNotice = t;
        this.notice('A peer is sending too many messages; the excess is being ignored.');
      }
      return;
    }
    switch (msg.t) {
      case 'hello':
        return this.onHello(link, from, msg);
      case 'sync':
        return this.onSync(from, msg);
      case 'ops':
        return this.onOps(link, from, msg);
      case 'presence':
        return this.onPresence(link, from, msg);
      case 'sim':
        return this.onSim(from, msg);
      case 'bye':
        if (this.peerMap.delete(from)) this.emit('peers', undefined);
        if (this.role === 'host') this.broadcast(msg, link);
        else if (from === this.hostSite) {
          this.notice('The host left the session. You keep a local copy of the scene.');
          this.leave();
        }
        return;
      default:
        return this.reject();
    }
  }

  private upsertPeer(site: string, name: unknown, role: unknown): PeerInfo | null {
    let p = this.peerMap.get(site);
    if (!p) {
      if (this.peerMap.size >= MAX_PEERS) return null;
      p = {
        site,
        name: cleanName(name),
        color: colorOf(site),
        role: role === 'host' ? 'host' : 'guest',
        selection: [],
      };
      this.peerMap.set(site, p);
      this.emit('peers', undefined);
    } else if (typeof name === 'string') {
      const n = cleanName(name);
      if (n !== p.name) {
        p.name = n;
        this.emit('peers', undefined);
      }
    }
    return p;
  }

  private onHello(link: Link, from: string, msg: Record<string, unknown>): void {
    const p = this.upsertPeer(from, msg.name, msg.role);
    if (!p) return;
    if (this.role === 'host') {
      this.broadcast(msg, link); // let the other guests know
      if (msg.role === 'guest') this.sendSnapshot(link, from);
    }
    this.sendPresence();
  }

  private sendSnapshot(link: Link, to: string): void {
    this.flushNow();
    const ops = this.replica.snapshot();
    const chunks = chunkOps(ops);
    if (!chunks.length) chunks.push([]);
    const total = chunks.length;
    const peers = this.peers.filter((p) => p.site !== to).map((p) => ({ site: p.site, name: p.name }));
    for (let i = 0; i < total; i++) {
      const ok = this.sendTo(link, {
        t: 'sync',
        from: this.site,
        to,
        name: this.name,
        n: i,
        total,
        ops: chunks[i],
        sim: this.o.sim.mode(),
        peers: i === 0 ? peers : undefined,
      });
      if (!ok) {
        this.notice(
          `Could not send the scene to a joining peer (part ${i + 1} of ${total} failed). They will not get a complete copy.`,
        );
        return;
      }
    }
  }

  private onSync(from: string, msg: Record<string, unknown>): void {
    if (msg.to !== this.site) return; // meant for another guest on the same bus
    if (this.role !== 'guest' || this.status !== 'connecting') return this.reject();
    if (this.hostSite && from !== this.hostSite) return this.reject();
    if (!this.hostSite) {
      this.hostSite = from;
      this.upsertPeer(from, msg.name, 'host');
    }
    if (Array.isArray(msg.peers))
      for (const q of msg.peers.slice(0, MAX_PEERS)) {
        const o = q as { site?: unknown; name?: unknown } | null;
        if (o && isSiteId(o.site) && o.site !== this.site) this.upsertPeer(o.site, o.name, 'guest');
      }
    this.applyOps(msg.ops, from, true);
    this.syncGot++;
    const total = typeof msg.total === 'number' ? msg.total : 1;
    if (this.syncGot >= Math.min(total, 100000) && this.status === 'connecting') {
      if (this.joinTimer) clearTimeout(this.joinTimer);
      this.joinTimer = null;
      this.sync.commitRemote();
      this.hostMode = MODES.includes(msg.sim as SimMode) ? (msg.sim as SimMode) : 'edit';
      this.setStatus('live');
      this.followHost();
      this.sendPresence();
    }
  }

  /**
   * Validate and apply operations from a peer. Ops must be authored by the peer that sent them (`author`), except
   * in the host's snapshot, which replays everybody's stamps; clocks that jump absurdly far ahead are refused.
   */
  private applyOps(raw: unknown, author: string, snapshot = false): Op[] {
    const parsed = parseOps(raw);
    let rejected = parsed.rejected;
    const limit = this.replica.lamport + (snapshot ? MAX_SYNC_CLOCK_AHEAD : MAX_CLOCK_AHEAD);
    const ops = parsed.ops.filter((op) => {
      const ok = (snapshot || op.s === author) && op.c <= limit;
      if (!ok) rejected++;
      return ok;
    });
    this.stats.rejectedOps += rejected;
    const fresh = this.sync.applyRemoteThrottled(ops, APPLY_GAP_MS);
    this.stats.appliedOps += fresh.length;
    this.stats.duplicateOps += ops.length - fresh.length;
    return fresh;
  }

  private onOps(link: Link, from: string, msg: Record<string, unknown>): void {
    if (this.status !== 'live' && this.status !== 'connecting') return;
    const fresh = this.applyOps(msg.ops, from);
    if (this.role === 'host' && fresh.length) this.broadcast({ t: 'ops', from, ops: fresh }, link);
  }

  private onPresence(link: Link, from: string, msg: Record<string, unknown>): void {
    const p = this.upsertPeer(from, msg.name, msg.role);
    if (!p) return;
    p.selection = cleanSelection(msg.sel);
    this.emit('peers', undefined);
    if (this.role === 'host') this.broadcast(msg, link);
  }

  private onSim(from: string, msg: Record<string, unknown>): void {
    if (this.role !== 'guest' || from !== this.hostSite) return this.reject();
    if (!MODES.includes(msg.mode as SimMode)) return this.reject();
    this.hostMode = msg.mode as SimMode;
    this.followHost();
  }

  private onLinkClosed(link: Link): void {
    this.links.delete(link);
    const site = this.linkSite.get(link);
    this.linkSite.delete(link);
    if (site && this.peerMap.delete(site)) this.emit('peers', undefined);
    if (this.role === 'guest' && this.links.size === 0 && this.status !== 'closed') {
      this.notice('The connection to the host was lost. You keep a local copy of the scene.');
      this.leave();
    }
  }
}

/**
 * DT-23 — transports for a collaboration session. A `Link` is a message pipe carrying JSON *strings* between this
 * page and the other peer(s) it reaches:
 *
 *   BroadcastLink   a `BroadcastChannel` named after the room: every tab of the same browser profile and origin that
 *                   opened the same room hears everything (a bus; no signalling needed).
 *   WebRtcLink      one `RTCDataChannel` to one remote peer. There is no signalling server: the two users exchange
 *                   an offer blob and an answer blob by copy/paste (`createOffer` -> `acceptOffer` -> `acceptAnswer`).
 *                   ICE gathering finishes before the blob is produced (no trickle), and no STUN/TURN server is used,
 *                   so it connects only when a direct path exists (same LAN, or at least one side publicly reachable).
 *   LoopbackBus     in-memory bus for tests.
 *
 * Everything a link receives is untrusted text; links only enforce the message size cap, `session.ts` parses it.
 */
import { Emitter } from '../core/events';

/** Largest message (characters) a link accepts or sends. */
export const MAX_MESSAGE_CHARS = 4_000_000;

export type LinkState = 'connecting' | 'open' | 'closed';

export interface LinkEvents extends Record<string, unknown> {
  message: string;
  open: undefined;
  close: string | undefined;
}

export abstract class Link extends Emitter<LinkEvents> {
  abstract readonly kind: 'broadcast' | 'webrtc' | 'loopback';
  state: LinkState = 'connecting';
  /** Send a message to the peer(s) on the other end. Throws if the link is not open or the message is too long. */
  abstract send(data: string): void;
  abstract close(): void;

  protected opened(): void {
    if (this.state !== 'connecting') return;
    this.state = 'open';
    this.emit('open', undefined);
  }
  protected closed(reason?: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.emit('close', reason);
  }
  protected deliver(data: unknown): void {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_CHARS) return;
    this.emit('message', data);
  }
  protected check(data: string): void {
    if (this.state !== 'open') throw new Error('link is not open');
    if (data.length > MAX_MESSAGE_CHARS) throw new Error('message too large');
  }
}

// ---- BroadcastChannel ---------------------------------------------------------------------------

/** A room code: letters and digits only, so it can be typed and shared. */
export const isRoomCode = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9]{4,32}$/.test(s);

export function newRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join('');
}

export class BroadcastLink extends Link {
  readonly kind = 'broadcast' as const;
  private readonly ch: BroadcastChannel;

  constructor(readonly room: string) {
    super();
    if (!isRoomCode(room)) throw new Error('A room code is 4-32 letters or digits.');
    this.ch = new BroadcastChannel(`physixlab-collab-${room}`);
    this.ch.onmessage = (ev: MessageEvent) => this.deliver(ev.data);
    queueMicrotask(() => this.opened());
  }

  send(data: string): void {
    this.check(data);
    this.ch.postMessage(data);
  }

  close(): void {
    this.ch.close();
    this.closed();
  }
}

// ---- in-memory bus (tests) ----------------------------------------------------------------------

/** Members of a bus hear every message the *other* members send, asynchronously and in order. */
export class LoopbackBus {
  private readonly members = new Set<LoopbackLink>();

  link(): Link {
    const l = new LoopbackLink(this);
    this.members.add(l);
    return l;
  }

  /** @internal */
  route(from: LoopbackLink, data: string): void {
    for (const m of this.members) if (m !== from && m.state === 'open') queueMicrotask(() => m.receive(data));
  }
  /** @internal */
  drop(l: LoopbackLink): void {
    this.members.delete(l);
  }
}

class LoopbackLink extends Link {
  readonly kind = 'loopback' as const;
  constructor(private readonly bus: LoopbackBus) {
    super();
    queueMicrotask(() => this.opened());
  }
  send(data: string): void {
    this.check(data);
    this.bus.route(this, data);
  }
  receive(data: string): void {
    this.deliver(data);
  }
  close(): void {
    this.bus.drop(this);
    this.closed();
  }
}

/** Two linked ends. */
export function createLoopbackPair(): [Link, Link] {
  const bus = new LoopbackBus();
  return [bus.link(), bus.link()];
}

// ---- WebRTC with copy/paste signalling ----------------------------------------------------------

export type SignalKind = 'offer' | 'answer';
const SIGNAL_PREFIX = 'PLRTC1.';
const MAX_SIGNAL_CHARS = 40_000;

/** Encode a session description as a single pasteable line. */
export function encodeSignal(kind: SignalKind, sdp: string): string {
  return SIGNAL_PREFIX + toBase64(new TextEncoder().encode(JSON.stringify({ t: kind, sdp })));
}

/** Decode and validate a pasted blob; throws an Error whose message tells the user what is wrong. */
export function decodeSignal(blob: string, expect: SignalKind): string {
  const text = blob.replace(/\s+/g, '');
  if (!text.startsWith(SIGNAL_PREFIX))
    throw new Error('That is not a PhysixLab connection code (it should start with PLRTC1.).');
  if (text.length > MAX_SIGNAL_CHARS) throw new Error('That connection code is too long.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64(text.slice(SIGNAL_PREFIX.length))));
  } catch {
    throw new Error('That connection code is damaged - copy it again, completely.');
  }
  const o = parsed as { t?: unknown; sdp?: unknown } | null;
  if (!o || typeof o.sdp !== 'string' || o.sdp.length > 30_000 || !o.sdp.startsWith('v=0'))
    throw new Error('That connection code does not contain a valid session description.');
  if (o.t !== expect)
    throw new Error(
      expect === 'offer'
        ? "Paste the host's offer here, not an answer."
        : "Paste the guest's answer here, not an offer.",
    );
  return o.sdp;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64(text: string): Uint8Array {
  const b = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export interface WebRtcOptions {
  /** STUN/TURN servers; empty by default (no third party is contacted). */
  iceServers?: RTCIceServer[];
  /** Give up waiting for candidates after this many ms. */
  gatherTimeoutMs?: number;
}

export class WebRtcLink extends Link {
  readonly kind = 'webrtc' as const;
  private channel: RTCDataChannel | null = null;

  private constructor(private readonly pc: RTCPeerConnection) {
    super();
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected')
        this.closed(`connection ${pc.connectionState}`);
    });
  }

  private bind(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.onopen = () => this.opened();
    ch.onclose = () => this.closed('data channel closed');
    ch.onmessage = (ev: MessageEvent) => this.deliver(ev.data);
    if (ch.readyState === 'open') this.opened();
  }

  /** Host side, step 1: create a connection and the offer blob to hand to the guest. */
  static async createOffer(opts: WebRtcOptions = {}): Promise<{ link: WebRtcLink; offer: string }> {
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? [] });
    const link = new WebRtcLink(pc);
    link.bind(pc.createDataChannel('physixlab', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, opts.gatherTimeoutMs ?? 5000);
    return { link, offer: encodeSignal('offer', pc.localDescription?.sdp ?? '') };
  }

  /** Guest side: take the host's offer blob, return the answer blob to send back. */
  static async acceptOffer(offer: string, opts: WebRtcOptions = {}): Promise<{ link: WebRtcLink; answer: string }> {
    const sdp = decodeSignal(offer, 'offer');
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? [] });
    const link = new WebRtcLink(pc);
    pc.addEventListener('datachannel', (ev) => link.bind(ev.channel));
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc, opts.gatherTimeoutMs ?? 5000);
    return { link, answer: encodeSignal('answer', pc.localDescription?.sdp ?? '') };
  }

  /** Host side, step 2: apply the guest's answer blob. The link opens when the data channel does. */
  async acceptAnswer(answer: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: decodeSignal(answer, 'answer') });
  }

  send(data: string): void {
    this.check(data);
    this.channel?.send(data);
  }

  close(): void {
    this.channel?.close();
    this.pc.close();
    this.closed();
  }
}

function gathered(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/**
 * The contact-event feed: one place that switches the worker's contact events on and off and hands them to whoever
 * asked for them.
 *
 * Contact events cost the physics worker a little for every new contact, so they are off until a consumer needs them
 * (protocol v2). Several packages want them — the particle effects now, the impact sounds and the camera shake next —
 * so they `acquire` the feed instead of each sending `{ op: 'events' }` themselves: the feed merges the requirements
 * (the most sensitive `minImpulse`, the shortest `pairInterval`, the largest `maxPerFrame`), sends the configuration
 * to every newly built world, and turns the events off again when the last consumer lets go. A consumer that asked
 * for less than the merged configuration delivers (a higher `minImpulse`, a longer `pairInterval`) is only handed
 * what it asked for, so what one consumer sees never depends on who else is listening.
 *
 *     const release = app.contacts.acquire('fx', { minImpulse: 0.1 }, (ev) => queue.push(ev));
 *     …
 *     release();
 */
import type { ContactEvent, EventConfig } from '../physics/protocol';
import type { SimController } from './simController';

export interface ContactNeeds {
  minImpulse?: number;
  pairInterval?: number;
  maxPerFrame?: number;
}

interface Consumer {
  needs: ContactNeeds;
  handler: (ev: ContactEvent) => void;
  // ── FX: per-consumer gate ──
  /** Simulation time of the last event this consumer was given, per pair (only used when the worker is more eager). */
  last: Map<string, number>;
  // ── /FX ──
}

// ── FX: per-consumer gate ──
/** Pairs remembered per consumer before the memory starts over (a pit of 300 balls makes tens of thousands of pairs). */
const MAX_REMEMBERED_PAIRS = 4096;
// ── /FX ──

/** What the worker is configured to when somebody consumes contacts and nobody states a preference. */
const BASE: Pick<EventConfig, 'minImpulse' | 'pairInterval' | 'maxPerFrame'> = {
  minImpulse: 0.1,
  pairInterval: 0.1,
  maxPerFrame: 64,
};

export class ContactFeed {
  private readonly consumers = new Map<string, Consumer>();

  constructor(private readonly sim: SimController) {
    // A new world starts with contact events off: tell it again whenever the layout changes (build, spawn, reset).
    sim.on('layout', () => {
      this.push();
      // ── FX: per-consumer gate ──
      // A new world (build, reset) starts its clock again: the gate must not remember pairs from the old one, or the
      // same scene would deliver different events the second time round.
      for (const c of this.consumers.values()) c.last.clear();
      // ── /FX ──
    });
    sim.client.on('event', (ev) => {
      if (ev.kind !== 'contact') return;
      // ── FX: per-consumer gate ──
      for (const c of this.consumers.values()) if (this.wants(c, ev)) c.handler(ev);
      // ── /FX ──
    });
  }

  /** The configuration the worker should have for the current consumers (contacts off when there are none). */
  config(): Partial<EventConfig> {
    if (!this.consumers.size) return { contacts: false };
    let minImpulse = Infinity;
    let pairInterval = Infinity;
    let maxPerFrame = 0;
    for (const { needs } of this.consumers.values()) {
      minImpulse = Math.min(minImpulse, needs.minImpulse ?? BASE.minImpulse);
      pairInterval = Math.min(pairInterval, needs.pairInterval ?? BASE.pairInterval);
      maxPerFrame = Math.max(maxPerFrame, needs.maxPerFrame ?? BASE.maxPerFrame);
    }
    return { contacts: true, minImpulse, pairInterval, maxPerFrame };
  }

  // ── FX: per-consumer gate ──
  /** The pair interval the worker was last told to use (the shortest that anybody asked for). */
  private gap = Infinity;

  /**
   * The worker serves the most demanding consumer, so a consumer that asked for less (a higher threshold, a longer
   * interval between events of one pair) would otherwise receive more than it asked for, and its behaviour would
   * change with whoever else is listening — the sound engine switching on must not make the particle effects
   * burst more often. Each consumer is therefore handed only what its own needs allow.
   */
  private wants(c: Consumer, ev: ContactEvent): boolean {
    if (ev.impulse < (c.needs.minImpulse ?? BASE.minImpulse)) return false;
    const gap = c.needs.pairInterval ?? BASE.pairInterval;
    if (gap <= this.gap) return true; // this consumer is the one that set the worker's interval
    const key = `${ev.a}|${ev.b}`;
    const prev = c.last.get(key);
    // A time that went backwards is a reset: start again.
    if (prev !== undefined && ev.t >= prev && ev.t - prev < gap - 1e-9) return false;
    if (c.last.size >= MAX_REMEMBERED_PAIRS) c.last.clear();
    c.last.set(key, ev.t);
    return true;
  }
  // ── /FX ──

  /** Number of consumers. */
  get size(): number {
    return this.consumers.size;
  }

  /** Start receiving contact events. `owner` names the consumer (acquiring twice under one name replaces it). */
  acquire(owner: string, needs: ContactNeeds, handler: (ev: ContactEvent) => void): () => void {
    const entry: Consumer = { needs, handler, last: new Map() }; // FX: per-consumer gate
    this.consumers.set(owner, entry);
    this.push();
    return () => {
      if (this.consumers.get(owner) !== entry) return;
      this.consumers.delete(owner);
      this.push();
    };
  }

  /** Whether the last configuration sent switched contact events on (so that letting go switches them off again). */
  private sentOn = false;

  private push(): void {
    // ── FX: per-consumer gate ──
    this.gap = Infinity;
    for (const { needs } of this.consumers.values())
      this.gap = Math.min(this.gap, needs.pairInterval ?? BASE.pairInterval);
    // ── /FX ──
    if (!this.sim.client.active) return;
    // With no consumer there is nothing to tell a world that never heard of contact events (they default to off).
    if (!this.consumers.size && !this.sentOn) return;
    this.sim.client.configureEvents(this.config());
    this.sentOn = this.consumers.size > 0;
  }
}

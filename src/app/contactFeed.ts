/**
 * The contact-event feed: one place that switches the worker's contact events on and off and hands them to whoever
 * asked for them.
 *
 * Contact events cost the physics worker a little for every new contact, so they are off until a consumer needs them
 * (protocol v2). Several packages want them — the particle effects now, the impact sounds and the camera shake next —
 * so they `acquire` the feed instead of each sending `{ op: 'events' }` themselves: the feed merges the requirements
 * (the most sensitive `minImpulse`, the shortest `pairInterval`, the largest `maxPerFrame`), sends the configuration
 * to every newly built world, and turns the events off again when the last consumer lets go.
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
}

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
    sim.on('layout', () => this.push());
    sim.client.on('event', (ev) => {
      if (ev.kind !== 'contact') return;
      for (const c of this.consumers.values()) c.handler(ev);
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

  /** Number of consumers. */
  get size(): number {
    return this.consumers.size;
  }

  /** Start receiving contact events. `owner` names the consumer (acquiring twice under one name replaces it). */
  acquire(owner: string, needs: ContactNeeds, handler: (ev: ContactEvent) => void): () => void {
    const entry: Consumer = { needs, handler };
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
    if (!this.sim.client.active) return;
    // With no consumer there is nothing to tell a world that never heard of contact events (they default to off).
    if (!this.consumers.size && !this.sentOn) return;
    this.sim.client.configureEvents(this.config());
    this.sentOn = this.consumers.size > 0;
  }
}

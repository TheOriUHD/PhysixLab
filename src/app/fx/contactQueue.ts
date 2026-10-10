/**
 * The frame's contact events, waiting to be turned into effects.
 *
 * The worker already merges and rate-limits contacts per body pair (`pairInterval`, `maxPerFrame`); this is the page's
 * own limit: events pile up between rendered frames, and each frame only the strongest `budget` are handled — the quality
 * tier's burst budget — so a hundred balls landing at once cost the same as twelve. The strength is the impact energy
 * `½·J·v`, so the effects that are dropped are the ones nobody would notice.
 */
import type { ContactEvent } from '../../physics/protocol';

export class ContactQueue {
  private readonly events: ContactEvent[] = [];

  constructor(
    /** Most events kept between two frames (the weakest are dropped first when more arrive). */
    private readonly capacity = 256,
  ) {}

  get size(): number {
    return this.events.length;
  }

  push(ev: ContactEvent): void {
    if (this.events.length < this.capacity) {
      this.events.push(ev);
      return;
    }
    // Full: replace the weakest event if this one is stronger.
    let weakest = 0;
    for (let i = 1; i < this.events.length; i++)
      if (strength(this.events[i]) < strength(this.events[weakest])) weakest = i;
    if (strength(ev) > strength(this.events[weakest])) this.events[weakest] = ev;
  }

  /**
   * Hand the strongest events to `handle` until `budget` of them reported success (returned true), strongest first;
   * then forget the rest. Returns how many succeeded.
   */
  drain(budget: number, handle: (ev: ContactEvent) => boolean): number {
    const q = this.events;
    if (!q.length) return 0;
    q.sort((a, b) => strength(b) - strength(a));
    let used = 0;
    for (let i = 0; i < q.length && used < budget; i++) if (handle(q[i])) used++;
    q.length = 0;
    return used;
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** ½·J·v — see `impactEnergy` in `render/fx/surfaces.ts`. */
const strength = (ev: ContactEvent): number => ev.impulse * ev.speed;

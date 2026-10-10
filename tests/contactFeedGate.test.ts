/**
 * The contact feed hands every consumer only what it asked for, however eager the others are (package FX: the sound
 * engine wants every small knock, the particle effects must not start bursting at each of them).
 */
import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/events';
import { ContactFeed } from '../src/app/contactFeed';
import type { SimController } from '../src/app/simController';
import { GROUND_ID, type ContactEvent, type EventConfig } from '../src/physics/protocol';

class FakeClient extends Emitter<{ event: ContactEvent }> {
  active = true;
  configureEvents(_cfg: Partial<EventConfig>): void {
    /* the worker is not under test */
  }
}
class FakeSim extends Emitter<{ layout: undefined }> {
  client = new FakeClient();
}
const setup = () => {
  const sim = new FakeSim();
  return { sim, client: sim.client, feed: new ContactFeed(sim as unknown as SimController) };
};
const contact = (over: Partial<ContactEvent> = {}): ContactEvent => ({
  kind: 'contact',
  t: 0,
  a: 'a',
  b: GROUND_ID,
  point: [0, 0, 0],
  normal: [0, 1, 0],
  impulse: 10,
  speed: 5,
  matA: 'steel',
  matB: 'ground',
  count: 1,
  ...over,
});

describe('ContactFeed per-consumer gate', () => {
  it('a consumer with a higher threshold never sees the knocks only the other one asked for', () => {
    const { client, feed } = setup();
    const fx: number[] = [];
    const audio: number[] = [];
    feed.acquire('fx', { minImpulse: 0.1 }, (e) => fx.push(e.impulse));
    feed.acquire('audio', { minImpulse: 0.02 }, (e) => audio.push(e.impulse));
    for (const impulse of [0.01, 0.05, 0.5]) client.emit('event', contact({ impulse }));
    expect(audio).toEqual([0.05, 0.5]);
    expect(fx).toEqual([0.5]);
  });

  it('a consumer with a longer pair interval is given one event per pair per interval, others every event', () => {
    const { client, feed } = setup();
    const fx: number[] = [];
    const audio: number[] = [];
    feed.acquire('fx', { pairInterval: 0.08 }, (e) => fx.push(e.t));
    feed.acquire('audio', { pairInterval: 0.05 }, (e) => audio.push(e.t));
    for (let i = 0; i < 12; i++) client.emit('event', contact({ t: i * 0.05 }));
    expect(audio).toHaveLength(12);
    // 0, then the first at least 0.08 later (0.10), and so on.
    expect(fx).toHaveLength(6);
    [0, 0.1, 0.2, 0.3, 0.4, 0.5].forEach((t, i) => expect(fx[i]).toBeCloseTo(t, 9));
  });

  it('the interval is kept per pair, and a simulation time that goes backwards (a reset) starts again', () => {
    const { client, feed } = setup();
    const seen: string[] = [];
    feed.acquire('fx', { pairInterval: 0.2 }, (e) => seen.push(`${e.a}@${e.t}`));
    feed.acquire('audio', { pairInterval: 0.05 }, () => undefined);
    client.emit('event', contact({ a: 'x', t: 1 }));
    client.emit('event', contact({ a: 'y', t: 1.05 })); // another pair: delivered
    client.emit('event', contact({ a: 'x', t: 1.1 })); // the same pair too soon
    client.emit('event', contact({ a: 'x', t: 0.1 })); // reset
    expect(seen).toEqual(['x@1', 'y@1.05', 'x@0.1']);
  });

  it('a new world (build, reset) forgets the pairs of the old one, so a scene delivers the same events every run', () => {
    const { sim, client, feed } = setup();
    const got: number[] = [];
    feed.acquire('fx', { pairInterval: 0.08 }, (e) => got.push(e.t));
    feed.acquire('audio', { pairInterval: 0.05 }, () => undefined);
    client.emit('event', contact({ t: 0.3 }));
    client.emit('event', contact({ t: 0.32 })); // too soon for the same world
    sim.emit('layout', undefined);
    // The new world's clock starts again and its first event for this pair comes just after the old one's last.
    client.emit('event', contact({ t: 0.35 }));
    expect(got).toEqual([0.3, 0.35]);
  });

  it('a lone consumer, or the one that set the interval, is never held back, and letting go restores the others', () => {
    const { client, feed } = setup();
    const fx: number[] = [];
    const releaseAudio = feed.acquire('audio', { pairInterval: 0.05 }, () => undefined);
    feed.acquire('fx', { pairInterval: 0.08 }, (e) => fx.push(e.t));
    client.emit('event', contact({ t: 0 }));
    client.emit('event', contact({ t: 0.05 }));
    expect(fx).toEqual([0]);
    releaseAudio(); // the worker now spaces events 0.08 apart for fx alone: nothing is held back
    client.emit('event', contact({ t: 0.08 }));
    client.emit('event', contact({ t: 0.09 }));
    expect(fx).toEqual([0, 0.08, 0.09]);
  });

  it('remembers a bounded number of pairs', () => {
    const { client, feed } = setup();
    let n = 0;
    feed.acquire('fx', { pairInterval: 0.2 }, () => n++);
    feed.acquire('audio', { pairInterval: 0.05 }, () => undefined);
    for (let i = 0; i < 10000; i++) client.emit('event', contact({ a: `b${i}`, t: 1 }));
    expect(n).toBe(10000);
    const last = (feed as unknown as { consumers: Map<string, { last: Map<string, number> }> }).consumers.get(
      'fx',
    )!.last;
    expect(last.size).toBeLessThanOrEqual(4096);
  });
});

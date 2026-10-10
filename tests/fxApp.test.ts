/**
 * The application side of the effects (FX-2, FX-3, FX-6): the contact feed shared by consumers, the effects clock, the
 * per-body facts (wheel detection, track width), the frame's contact budget, physical debris against the real engine,
 * and the stored preferences. All of it runs in Node: the pieces that need an `App` are thin glue over these.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/events';
import { ContactFeed } from '../src/app/contactFeed';
import { bodyFxInfo, FRAGMENT_TAG, hingedBodies, isWheelLike, PROJECTILE_TAG, trackWidth } from '../src/app/fx/bodyFx';
import { ContactQueue } from '../src/app/fx/contactQueue';
import { FxClock, MAX_FX_STEP } from '../src/app/fx/fxClock';
import { PhysicalDebris } from '../src/app/fx/physicalDebris';
import type { SimController } from '../src/app/simController';
import { GROUND_ID, type ContactEvent, type EventConfig, type SimOp } from '../src/physics/protocol';
import type { BodyEntity } from '../src/model/types';
import { surfaceFor, type ImpactBurst } from '../src/render/fx/surfaces';
import { registerFxPanelSection, fxPanelSections } from '../src/ui/fxPanel';
import { createBody, createJoint, run, worldOf } from './helpers';

// -- the contact feed --------------------------------------------------------------------------------------------

class FakeClient extends Emitter<{ event: ContactEvent | { kind: string } }> {
  active = false;
  sent: Partial<EventConfig>[] = [];
  configureEvents(cfg: Partial<EventConfig>): void {
    if (this.active) this.sent.push(cfg);
  }
}
class FakeSim extends Emitter<{ layout: undefined }> {
  client = new FakeClient();
}
const feedOf = () => {
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

describe('ContactFeed', () => {
  it('asks the worker for contact events only while somebody consumes them, and stops when the last one lets go', () => {
    const { client, feed } = feedOf();
    client.active = true;
    expect(feed.config()).toEqual({ contacts: false });
    const release = feed.acquire('fx', {}, () => undefined);
    expect(client.sent.at(-1)).toMatchObject({ contacts: true });
    release();
    expect(client.sent.at(-1)).toEqual({ contacts: false });
    // Nobody is listening and nothing was switched on: layout changes send nothing.
    const n = client.sent.length;
    client.active = true;
    (feed as unknown as { sim: FakeSim }).sim.emit('layout', undefined);
    expect(client.sent.length).toBe(n);
  });

  it('merges what consumers need: the most sensitive threshold, the shortest interval, the largest cap', () => {
    const { feed } = feedOf();
    feed.acquire('fx', { minImpulse: 0.1, pairInterval: 0.08, maxPerFrame: 48 }, () => undefined);
    feed.acquire('audio', { minImpulse: 0.02, pairInterval: 0.05 }, () => undefined);
    expect(feed.config()).toEqual({ contacts: true, minImpulse: 0.02, pairInterval: 0.05, maxPerFrame: 64 });
    expect(feed.size).toBe(2);
  });

  it('tells every newly built world again (the layout event), and a world that is not running nothing', () => {
    const { sim, client, feed } = feedOf();
    feed.acquire('fx', {}, () => undefined);
    expect(client.sent).toEqual([]); // no world yet
    client.active = true;
    sim.emit('layout', undefined);
    expect(client.sent).toHaveLength(1);
    sim.emit('layout', undefined); // a projectile was spawned: harmless repeat
    expect(client.sent).toHaveLength(2);
    expect(client.sent[1]).toMatchObject({ contacts: true });
  });

  it('delivers contact events to every consumer and ignores the other kinds', () => {
    const { client, feed } = feedOf();
    const a: ContactEvent[] = [];
    const b: ContactEvent[] = [];
    feed.acquire('fx', {}, (e) => a.push(e));
    const releaseB = feed.acquire('audio', {}, (e) => b.push(e));
    client.emit('event', contact());
    client.emit('event', { kind: 'sensor' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    releaseB();
    client.emit('event', contact());
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
  });

  it('acquiring twice under one name replaces the consumer; the old release does not remove the new one', () => {
    const { client, feed } = feedOf();
    const calls: string[] = [];
    const first = feed.acquire('fx', {}, () => calls.push('first'));
    feed.acquire('fx', {}, () => calls.push('second'));
    first();
    client.emit('event', contact());
    expect(calls).toEqual(['second']);
    expect(feed.size).toBe(1);
  });
});

// -- the effects clock -------------------------------------------------------------------------------------------

describe('FxClock', () => {
  const base = { active: true, running: true, timeScale: 1 };

  it('runs in real time when there is no simulation, so a preview finishes', () => {
    expect(new FxClock().step(0.016, { ...base, active: false, running: false })).toBeCloseTo(0.016, 9);
  });

  it('follows the simulation speed: the time scale, and a simulation that cannot keep up', () => {
    const c = new FxClock();
    expect(c.step(0.02, { ...base, timeScale: 0.25 })).toBeCloseTo(0.005, 9);
    expect(c.step(0.02, { ...base, timeScale: 4 })).toBeCloseTo(0.08, 9);
    expect(c.step(0.02, { ...base, timeScale: 1, realtimeFactor: 0.5 })).toBeCloseTo(0.01, 9);
    expect(c.step(0.02, { ...base, realtimeFactor: 7 })).toBeCloseTo(0.02, 9); // never faster than real time
  });

  it('freezes while paused, advances by the simulated time of a single step, ignores a clock that went back', () => {
    const c = new FxClock();
    const paused = { active: true, running: false, timeScale: 1 };
    expect(c.step(0.016, { ...paused, simTime: 2 })).toBe(0); // first sight: nothing to compare with
    expect(c.step(0.016, { ...paused, simTime: 2 })).toBe(0);
    expect(c.step(0.016, { ...paused, simTime: 2 + 1 / 120 })).toBeCloseTo(1 / 120, 9);
    expect(c.step(0.016, { ...paused, simTime: 1 })).toBe(0); // a restore / rebuild moved time back
  });

  it('never reports more than MAX_FX_STEP, however long the stall', () => {
    expect(new FxClock().step(30, { ...base, active: false, running: false })).toBe(MAX_FX_STEP);
    expect(new FxClock().step(-1, base)).toBe(0);
  });
});

// -- per-body facts -------------------------------------------------------------------------------------------------

const joint = (type: 'hinge' | 'fixed', a: string | null, b: string | null) =>
  createJoint({ type, bodyA: a, bodyB: b, anchorA: [0, 0, 0], anchorB: [0, 0, 0], axis: [0, 0, 1] });

const bodyOf = (shape: BodyEntity['shape']['type'], name: string, over: Record<string, unknown> = {}) =>
  createBody({ name, shape: { type: shape, size: shape === 'cylinder' ? [0.7, 0.3, 0.7] : [1, 1, 1] }, ...over });

describe('body facts for the effects', () => {
  it('a cylinder on a hinge is a wheel; so is anything tagged or named like one; a box or a free cylinder is not', () => {
    const hub = bodyOf('box', 'Hub');
    const wheel = bodyOf('cylinder', 'Disc');
    const drum = bodyOf('cylinder', 'Drum');
    const hinged = hingedBodies([joint('hinge', hub.id, wheel.id)]);
    expect(isWheelLike(wheel, hinged)).toBe(true);
    expect(isWheelLike(drum, hinged)).toBe(false);
    expect(isWheelLike(bodyOf('cylinder', 'Front left wheel'), new Set())).toBe(true);
    expect(isWheelLike(bodyOf('sphere', 'Rear Tyre'), new Set())).toBe(true);
    expect(isWheelLike(bodyOf('sphere', 'Ball', { tags: ['wheel'] }), new Set())).toBe(true);
    expect(isWheelLike(bodyOf('sphere', 'Ball'), new Set([bodyOf('sphere', 'x').id]))).toBe(false);
    expect(isWheelLike(bodyOf('box', 'Wheel box'), new Set())).toBe(false);
    // only hinges make a wheel: a fixed joint does not
    expect(hingedBodies([joint('fixed', hub.id, wheel.id)]).size).toBe(0);
    expect(hingedBodies([joint('hinge', null, wheel.id)])).toEqual(new Set([wheel.id]));
  });

  it('the mark a wheel leaves is as wide as its tread; a ball or a box leaves a narrower one', () => {
    const wheel = bodyOf('cylinder', 'Front wheel');
    expect(trackWidth(wheel, true)).toBeCloseTo(0.3, 9);
    expect(trackWidth(bodyOf('sphere', 'Ball'), false)).toBeLessThanOrEqual(0.3);
    expect(trackWidth(bodyOf('box', 'Crate'), false)).toBeCloseTo(0.7, 9);
    expect(trackWidth(bodyOf('box', 'Giant', { shape: { type: 'box', size: [20, 20, 20] } }), false)).toBe(0.9);
  });

  it('only dynamic, visible, solid bodies take part in trails; projectiles and fragments are recognised by their tag', () => {
    const info = (over: Record<string, unknown>) => bodyFxInfo(bodyOf('box', 'B', over), new Set(), 1);
    expect(info({}).trails).toBe(true);
    expect(info({ bodyType: 'static' }).trails).toBe(false);
    expect(info({ bodyType: 'kinematic' }).trails).toBe(false);
    expect(info({ hidden: true }).trails).toBe(false);
    expect(info({ ghost: true }).trails).toBe(false);
    expect(info({ tags: [PROJECTILE_TAG] }).projectile).toBe(true);
    expect(info({ tags: [FRAGMENT_TAG] }).fragment).toBe(true);
    expect(info({}).projectile || info({}).fragment).toBe(false);
    const rubber = bodyFxInfo(
      bodyOf('sphere', 'R', { material: { preset: 'rubber', color: '#112233' } }),
      new Set(),
      7,
    );
    expect(rubber.surface.cls).toBe('rubber');
    expect(rubber.skidKey).toBe(7);
    expect(rubber.surface.color).not.toEqual(rubber.surface.base); // its own paint
  });
});

// -- the frame's contact budget ---------------------------------------------------------------------------------------

describe('ContactQueue', () => {
  const ev = (id: string, impulse: number, speed = 5) => contact({ a: id, impulse, speed });

  it('hands over the strongest events first and stops when the budget of handled events is used up', () => {
    const q = new ContactQueue();
    for (const [id, j] of [
      ['weak', 1],
      ['strong', 500],
      ['mid', 50],
      ['stronger', 900],
    ] as const)
      q.push(ev(id, j));
    const seen: string[] = [];
    const used = q.drain(2, (e) => (seen.push(e.a), true));
    expect(seen).toEqual(['stronger', 'strong']);
    expect(used).toBe(2);
    expect(q.size).toBe(0); // the rest is dropped
  });

  it('events the handler declines do not use up the budget', () => {
    const q = new ContactQueue();
    for (let i = 0; i < 10; i++) q.push(ev(`e${i}`, 100 - i));
    const used = q.drain(3, (e) => Number(e.a.slice(1)) % 2 === 0);
    expect(used).toBe(3);
  });

  it('when full it keeps the strongest events', () => {
    const q = new ContactQueue(5);
    for (let i = 1; i <= 20; i++) q.push(ev(`e${i}`, i));
    expect(q.size).toBe(5);
    const seen: number[] = [];
    q.drain(99, (e) => (seen.push(e.impulse), true));
    expect(seen).toEqual([20, 19, 18, 17, 16]);
    q.push(ev('x', 1));
    q.clear();
    expect(q.size).toBe(0);
  });
});

// -- physical debris, against the real engine ----------------------------------------------------------------------

/** A stand-in for the app's `SimController` that forwards to a real physics world. */
async function debrisRig() {
  const world = await worldOf([]);
  const ephemeral = new Map<string, BodyEntity>();
  const sim = {
    client: { active: true, op: (op: SimOp) => world.applyOp(op) },
    ephemeral,
    layouts: 0,
    spawn(def: BodyEntity) {
      ephemeral.set(def.id, def);
      world.applyOp({ op: 'addBody', body: def, ephemeral: true });
    },
    emit() {
      this.layouts++;
    },
  };
  const debris = new PhysicalDebris(sim as unknown as SimController);
  return { world, sim, debris };
}
const burst = (count = 10): ImpactBurst => ({
  type: 'debris',
  count,
  scale: 1,
  speed: 1,
  dir: 1,
  physical: true,
  from: 'b',
});

describe('physical debris (FX-6)', () => {
  it('throws real rigid fragments out of the hit: they exist in the world, carry the tag and the material', async () => {
    const { world, sim, debris } = await debrisRig();
    const n = debris.spawn(burst(), 'glass', '#9fd8e8', [0, 1, 0], [0, 1, 0]);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(6);
    expect(debris.count).toBe(n);
    expect(world.bodyIds).toHaveLength(n);
    for (const def of sim.ephemeral.values()) {
      expect(def.tags).toContain(FRAGMENT_TAG);
      expect(def.material.preset).toBe('glass');
      expect(def.position[1]).toBeGreaterThan(1);
    }
  });

  it('is capped: never more fragments alive than the cap, however many hits', async () => {
    const { world, debris } = await debrisRig();
    debris.cap = 10;
    let made = 0;
    for (let i = 0; i < 20; i++) made += debris.spawn(burst(14), 'glass', undefined, [i, 1, 0], [0, 1, 0]);
    expect(made).toBe(10);
    expect(debris.count).toBe(10);
    expect(world.bodyIds).toHaveLength(10);
    debris.cap = 0;
    expect(debris.spawn(burst(), 'glass', undefined, [0, 1, 0], [0, 1, 0])).toBe(0);
  });

  it('cleans up after itself: every fragment is removed from the world after its few seconds, and the page is told', async () => {
    const { world, sim, debris } = await debrisRig();
    debris.spawn(burst(), 'glass', undefined, [0, 1, 0], [0, 1, 0]);
    debris.spawn(burst(), 'glass', undefined, [3, 1, 0], [0, 1, 0]);
    const made = debris.count;
    expect(made).toBeGreaterThan(1);
    debris.update(4.5);
    expect(world.bodyIds).toHaveLength(made); // still within the minimum lifetime (5 s)
    debris.update(5);
    expect(debris.count).toBe(0);
    expect(world.bodyIds).toHaveLength(0);
    expect(sim.ephemeral.size).toBe(0);
    expect(sim.layouts).toBeGreaterThan(0);
    // After a reset the list is forgotten (the world is gone with its ephemeral bodies).
    debris.spawn(burst(), 'glass', undefined, [0, 1, 0], [0, 1, 0]);
    debris.clear();
    expect(debris.count).toBe(0);
  });

  it('fragments land on the ground and rest, pass through each other and are deterministic for a seed', async () => {
    const run1 = async (seed: number) => {
      const { world, debris, sim } = await debrisRig();
      debris.reseed(seed);
      debris.spawn(burst(14), 'glass', undefined, [0, 0.5, 0], [0, 1, 0]);
      debris.spawn(burst(14), 'glass', undefined, [0, 0.5, 0], [0, 1, 0]);
      run(world, 3);
      return [...sim.ephemeral.keys()].map((id) => world.getPose(id)!);
    };
    const a = await run1(11);
    for (const p of a) {
      expect(p.position[1]).toBeGreaterThan(-0.02); // on the ground, not through it
      expect(p.position[1]).toBeLessThan(0.4);
      expect(Math.hypot(...p.linvel)).toBeLessThan(2);
    }
    expect(JSON.stringify((await run1(11)).map((p) => p.position))).toBe(JSON.stringify(a.map((p) => p.position)));
    expect(JSON.stringify((await run1(12)).map((p) => p.position))).not.toBe(JSON.stringify(a.map((p) => p.position)));
  });
});

// -- preferences and the panel registry ---------------------------------------------------------------------------------

describe('stored preferences', () => {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  afterEach(() => {
    store.clear();
    delete g.localStorage;
  });
  const install = () => {
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  };

  it('loads damaged effect settings as valid ones, keeps what was valid, and persists changes', async () => {
    install();
    const { PrefsStore } = await import('../src/app/prefs');
    store.set(
      'physicslab:prefs:v1',
      JSON.stringify({ fx: { enabled: false, quality: 'ultra', intensity: 99, skidMarks: 'maybe', debris: false } }),
    );
    const p = new PrefsStore();
    expect(p.value.fx).toMatchObject({ enabled: false, quality: 'auto', intensity: 2, skidMarks: true, debris: false });
    p.set({ fx: { ...p.value.fx, quality: 'low' } });
    expect((JSON.parse(store.get('physicslab:prefs:v1') as string) as { fx: { quality: string } }).fx.quality).toBe(
      'low',
    );
    store.set('physicslab:prefs:v1', '{not json');
    expect(new PrefsStore().value.fx.enabled).toBe(true); // storage garbage: defaults
  });

  it('a first run has every effect on, quality auto, physical debris off', async () => {
    install();
    const { PrefsStore } = await import('../src/app/prefs');
    expect(new PrefsStore().value.fx).toEqual({
      enabled: true,
      quality: 'auto',
      intensity: 1,
      impacts: true,
      trails: true,
      skidMarks: true,
      explosions: true,
      debris: true,
      physicalDebris: false,
    });
  });
});

describe('Effects panel sections', () => {
  it('later packages add their own section; malformed ones are refused', () => {
    const off = registerFxPanelSection({ id: 'test.audio', order: 50, build: () => ({ el: {} as HTMLElement }) });
    expect(fxPanelSections.list().map((s) => s.id)).toContain('test.audio');
    expect(() =>
      registerFxPanelSection({ id: 'test.bad', order: Number.NaN, build: () => ({ el: {} as HTMLElement }) }),
    ).toThrow(/numeric order/);
    expect(() =>
      registerFxPanelSection({ id: 'test.audio', order: 1, build: () => ({ el: {} as HTMLElement }) }),
    ).toThrow(/already registered/);
    off();
    expect(fxPanelSections.list().map((s) => s.id)).not.toContain('test.audio');
  });

  it('the surfaces helper is reachable for panels: ground and steel profiles differ', () => {
    expect(surfaceFor('ground').cls).not.toBe(surfaceFor('steel').cls);
  });
});

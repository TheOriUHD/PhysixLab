/**
 * The zone content (example scenes and prefabs): each promises something visible and is tested for exactly that.
 */
import { describe, expect, it } from 'vitest';
import { getPrefab, getTemplate, listPrefabs } from '../src/model/content';
import { sanitizeDocument } from '../src/model/serialize';
import { newReport } from '../src/model/errors';
import { BOUNDS_EVENT_TYPE, ZONES_STATE_ID, type ZonesPublic } from '../src/model/zones';
import { PhysicsWorld } from '../src/physics/world';
import type { ComponentEvent } from '../src/physics/protocol';
import { eventsOf, isZoneEvent, runCollect } from './zonesHelpers';

describe('Zones playground', () => {
  it('loads cleanly and every lane does what it shows: launch, coin, sound, teleport, trap and respawn, spawn', async () => {
    const t = getTemplate('zones-playground')!;
    const report = newReport();
    const doc = sanitizeDocument(JSON.parse(JSON.stringify(t.build())), report);
    expect(report.warnings).toEqual([]);
    const w = await PhysicsWorld.create(doc);
    const ev = runCollect(w, 9);
    const names = new Set(ev.map((e) => e.name));
    for (const n of ['launch', 'score', 'sound', 'teleport', 'kill', 'respawn', 'spawn'])
      expect(names.has(n), n).toBe(true);
    // the coin paid out
    const score = w.drainComponentState().changed[ZONES_STATE_ID]?.json as ZonesPublic | undefined;
    expect(score?.score.total ?? 0).toBeGreaterThanOrEqual(25);
    // the trap sends the ball back again and again (more than one respawn in nine seconds is the point of the lane)
    expect(ev.filter((e) => e.name === 'respawn').length).toBeGreaterThanOrEqual(2);
    // the emitter keeps making balls (and the page is told about each: the definition travels with the event)
    const spawns = ev.filter((e) => e.name === 'spawn');
    expect(spawns.length).toBeGreaterThanOrEqual(3);
    expect(spawns.every((e) => !!(e.data as { def?: unknown }).def)).toBe(true);
  });

  it('is a stable scene: no body leaves the world, the zero-g runner floats', async () => {
    const doc = getTemplate('zones-playground')!.build();
    const w = await PhysicsWorld.create(doc);
    runCollect(w, 6);
    const c = doc.entities.find((e) => e.kind === 'body' && e.name === 'Runner C')!;
    const p = w.getPose(c.id)!;
    expect(p.position.every(Number.isFinite)).toBe(true);
    // dropped from 4.5 m into the zero-g bubble: it would have hit the ground in 0.95 s; it is still up in the air
    expect(p.position[1]).toBeGreaterThan(1.5);
  });
});

describe('Drag strip', () => {
  it('the car (one group, eight bodies) drives the strip as one racer: start, two checkpoints, finish, with times', async () => {
    const t = getTemplate('drag-strip')!;
    const doc = sanitizeDocument(JSON.parse(JSON.stringify(t.build())), newReport());
    const w = await PhysicsWorld.create(doc);
    w.setKeys(['KeyW']);
    const ev: ComponentEvent[] = [];
    let lost = 0;
    for (let i = 0; i < 20 * w.settings.physicsHz; i++) {
      w.stepOnce();
      const all = w.drainEvents();
      ev.push(...all.filter(isZoneEvent));
      lost += all.filter((e) => e.kind === 'component' && e.type === BOUNDS_EVENT_TYPE).length;
    }
    const race = ev.filter((e) => ['start', 'checkpoint', 'lap', 'finish'].includes(e.name));
    expect(race.map((e) => e.name)).toEqual(['start', 'checkpoint', 'checkpoint', 'lap', 'finish']);
    const group = doc.entities.find((e) => e.kind === 'group')!;
    expect(race.every((e) => (e.data as { racer: string }).racer === group.id)).toBe(true);
    const fin = race[4].data as { time: number; rank: number };
    expect(fin.rank).toBe(1);
    expect(fin.time).toBeGreaterThan(4); // 72 m from a standing start
    expect(fin.time).toBeLessThan(15);
    expect(lost).toBe(0); // the walls and the floor never had to act
  });

  it('driving off the strip brings the car back: the soft wall turns it, and a fall respawns it at the last checkpoint with the penalty', async () => {
    const doc = getTemplate('drag-strip')!.build();
    const w = await PhysicsWorld.create(doc);
    const chassis = doc.entities.find((e) => e.kind === 'body' && e.name === 'Chassis')!;
    // push the car sideways at 12 m/s towards the +z wall (16 m away, the soft wall starts at 12 m)
    for (const e of doc.entities) if (e.kind === 'body' && e.parent) w.setVelocity(e.id, [0, 0, 12], [0, 0, 0]);
    runCollect(w, 4);
    expect(w.getPose(chassis.id)!.position[2]).toBeLessThan(16);
    expect(w.getPose(chassis.id)!.linvel[2]).toBeLessThan(0.5); // turned around by the spring wall (or at least stopped)
    // now lift the whole car over the edge of the world: it falls through the floor plane at y = −4
    const falling = await PhysicsWorld.create(doc);
    for (const e of doc.entities)
      if (e.kind === 'body' && e.parent) falling.teleport(e.id, [e.position[0], -6, e.position[2]], e.rotation);
    const bounds: ComponentEvent[] = [];
    for (let i = 0; i < 4 * falling.settings.physicsHz; i++) {
      falling.stepOnce();
      bounds.push(...eventsOf(falling, BOUNDS_EVENT_TYPE));
    }
    const kills = bounds.filter((e) => e.name === 'kill');
    expect(kills).toHaveLength(1); // the car is lost once, as one group
    expect(kills[0].data).toMatchObject({ mode: 'respawn', cause: 'bounds' });
    expect(bounds.some((e) => e.name === 'respawn')).toBe(true);
  });
});

describe('zone prefabs', () => {
  it('are registered in the Zones & races category and load without repairs', () => {
    const zp = listPrefabs().filter((p) => p.category === 'Zones & races');
    expect(zp.length).toBeGreaterThanOrEqual(9);
    expect(getPrefab('zones-race-gates')?.name).toBe('Race gates');
    for (const p of zp) {
      const doc = sanitizeDocument(
        {
          format: 'physicslab-scene',
          version: 3,
          name: p.name,
          entities: JSON.parse(JSON.stringify(p.build())) as unknown[],
        },
        newReport(),
      );
      expect(doc.entities.length, p.id).toBeGreaterThan(0);
    }
  });

  it('race gates make a three-lap circuit with a start / finish line and two ordered checkpoints', () => {
    const e = getPrefab('zones-race-gates')!.build();
    const params = e.map((b) => (b.kind === 'body' ? b.components[0].params : null));
    expect(params[0]).toMatchObject({ action: 'finish', laps: 3, startsClock: true });
    expect(params[1]).toMatchObject({ action: 'checkpoint', index: 1 });
    expect(params[2]).toMatchObject({ action: 'checkpoint', index: 2 });
  });
});

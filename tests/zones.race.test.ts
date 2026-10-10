/**
 * Zones, part 3 (ZN-3): races in the real engine — ordered checkpoints, start and finish lines, lap counting,
 * split times, best lap, penalties, per-body progress, a whole vehicle as one racer, snapshots mid-race.
 */
import { describe, expect, it } from 'vitest';
import { newDocument, createGroup } from '../src/model/factory';
import { buildCar } from '../src/model/templates';
import type { BodyEntity, Entity } from '../src/model/types';
import { ZONES_STATE_ID, type RacerPublic, type ZonesPublic } from '../src/model/zones';
import { PhysicsWorld } from '../src/physics/world';
import type { ComponentEvent } from '../src/physics/protocol';
import { ball, run, runCollect, runUntil, SPACE, worldOf, zoneBody, zoneEvents } from './zonesHelpers';
import { docOf } from './helpers';

const DT = 1 / 120;
const RACE_EVENTS = ['start', 'checkpoint', 'lap', 'finish', 'skipped'];
const gate = (action: string, x: number, params: Record<string, unknown> = {}, name = `${action}@${x}`) =>
  zoneBody({ action, race: 'r1', ...params }, { position: [x, 0, 0], size: [1, 8, 8], name });
const raceEvents = (ev: ComponentEvent[]) => ev.filter((e) => RACE_EVENTS.includes(e.name));
const published = (w: PhysicsWorld): ZonesPublic => {
  const st = w.drainComponentState().changed[ZONES_STATE_ID];
  return st.json as ZonesPublic;
};
/** Time the front of a ball moving at `v` from x = 0 meets a 1 m deep gate at `x`, plus up to three steps of detection lag. */
const meets = (x: number, v = 10) => (x - 0.75) / v;
const near = (t: number, expected: number, lag = 3 * DT) => {
  expect(t).toBeGreaterThanOrEqual(expected);
  expect(t).toBeLessThan(expected + lag);
};

describe('a point-to-point race', () => {
  it('three checkpoints and a finish line: splits at the times the gates are reached, finish time = the last split', async () => {
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf(
      [
        gate('checkpoint', 10, { index: 1 }),
        gate('checkpoint', 20, { index: 2 }),
        gate('checkpoint', 30, { index: 3 }),
        gate('finish', 40, { laps: 1 }),
        b,
      ],
      SPACE,
    );
    const ev = raceEvents(runCollect(w, 5));
    expect(ev.map((e) => e.name)).toEqual(['checkpoint', 'checkpoint', 'checkpoint', 'lap', 'finish']);
    const splits = ev.filter((e) => e.name === 'checkpoint').map((e) => (e.data as { split: number }).split);
    splits.forEach((s, i) => near(s, meets(10 * (i + 1))));
    expect(ev.map((e) => (e.data as { racer: string }).racer)).toEqual(Array(5).fill(b.id));
    expect(ev.filter((e) => e.name === 'checkpoint').map((e) => (e.data as { index: number }).index)).toEqual([
      1, 2, 3,
    ]);
    const fin = ev[4].data as { time: number; laps: number; rank: number; lapTimes: number[]; penalty: number };
    near(fin.time, meets(40));
    expect(fin).toMatchObject({ laps: 1, rank: 1, penalty: 0 });
    expect(fin.lapTimes).toEqual([fin.time]);
    expect(ev[3].data).toMatchObject({ lap: 1, best: true, overall: true });
    // a lap’s splits are the ones the checkpoints reported
    expect((ev[3].data as { splits: number[] }).splits).toEqual(splits);
  });

  it('the published state carries the standings: racer, lap, splits, best lap, finishing time, rank', async () => {
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf([gate('checkpoint', 10, { index: 1 }), gate('finish', 20, { laps: 1 }), b], SPACE);
    run(w, 3);
    const state = published(w);
    expect(state.races).toHaveLength(1);
    const race = state.races[0];
    expect(race).toMatchObject({ race: 'r1', laps: 1, checkpoints: [1], hasStart: false });
    const r: RacerPublic = race.racers[0];
    expect(r).toMatchObject({ racer: b.id, lap: 1, finished: true, rank: 1, passed: 0, penalty: 0 });
    near(r.finishTime!, meets(20));
    expect(r.lapTimes).toHaveLength(1);
    expect(r.bestLap).toBe(r.lapTimes[0]);
    expect(race.record).toEqual({ racer: b.id, time: r.bestLap });
  });

  it('checkpoints must be taken in order: crossing out of order is reported as skipped and the lap does not count', async () => {
    // gates laid out 2, 1, 3, finish
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf(
      [
        gate('checkpoint', 10, { index: 2 }),
        gate('checkpoint', 20, { index: 1 }),
        gate('checkpoint', 30, { index: 3 }),
        gate('finish', 40, { laps: 1 }),
        b,
      ],
      SPACE,
    );
    const ev = raceEvents(runCollect(w, 5));
    expect(ev.map((e) => e.name)).toEqual(['skipped', 'checkpoint', 'skipped', 'skipped']);
    expect(ev[0].data).toMatchObject({ index: 2, expected: 1 });
    expect(ev[1].data).toMatchObject({ index: 1 });
    expect(ev[2].data).toMatchObject({ index: 3, expected: 2 });
    expect(ev[3].data).toMatchObject({ index: 0, expected: 2 }); // the line, with checkpoint 2 still missing
    const r = published(w).races[0].racers[0];
    expect(r).toMatchObject({ lap: 0, passed: 1, finished: false });
  });

  it('a start line holds the clock until it is crossed: splits and the lap are measured from there', async () => {
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf(
      [
        gate('checkpoint', 5, { index: 1 }),
        gate('start', 10),
        gate('checkpoint', 20, { index: 1 }),
        gate('finish', 30, { laps: 1 }),
        b,
      ],
      SPACE,
    );
    const ev = raceEvents(runCollect(w, 4));
    // the checkpoint before the start line is ignored; the clock starts at x = 10, the one at 20 is 1 s later
    expect(ev.map((e) => e.name)).toEqual(['start', 'checkpoint', 'lap', 'finish']);
    near((ev[0].data as { time: number }).time, meets(10));
    const split = (ev[1].data as { split: number }).split;
    expect(Math.abs(split - 1)).toBeLessThan(3 * DT);
    expect(Math.abs((ev[3].data as { time: number }).time - 2)).toBeLessThan(3 * DT);
  });

  it('without checkpoints the finish line alone makes a lap (the “all checkpoints” rule has nothing to wait for)', async () => {
    const w = await worldOf([gate('finish', 10, { laps: 1 }), ball([0, 0, 0], [10, 0, 0])], SPACE);
    expect(raceEvents(runCollect(w, 2)).map((e) => e.name)).toEqual(['lap', 'finish']);
  });
});

describe('laps', () => {
  /** A ring road: start / finish line at 0, checkpoints at 20 and 40, a loop-back teleporter at 60 that returns the ball to x = −5. */
  const circuit = (laps: number, extra: Record<string, unknown> = {}) => [
    gate('finish', 0, { laps, startsClock: true, ...extra }),
    gate('checkpoint', 20, { index: 1 }),
    gate('checkpoint', 40, { index: 2 }),
    zoneBody(
      { action: 'teleport', offset: [-5, 0, 0], velocity: 'keep' },
      { position: [60, 0, 0], size: [1, 8, 8], name: 'loop' },
    ),
  ];

  it('counts three laps of a loop: one start, a lap and two splits per round, the finish after the last', async () => {
    const b = ball([-5, 0, 0], [10, 0, 0]);
    const w = await worldOf([...circuit(3), b], SPACE);
    const ev = raceEvents(runCollect(w, 24));
    const names = ev.map((e) => e.name);
    expect(names).toEqual([
      'start',
      'checkpoint', 'checkpoint', 'lap',
      'checkpoint', 'checkpoint', 'lap',
      'checkpoint', 'checkpoint', 'lap', 'finish',
    ]); // prettier-ignore
    const laps = ev
      .filter((e) => e.name === 'lap')
      .map((e) => e.data as { lap: number; lapTime: number; best: boolean });
    expect(laps.map((l) => l.lap)).toEqual([1, 2, 3]);
    // every round is the same 65 m: identical lap times (to a step), 6.5 s plus the detection lag of the loop-back gate
    const times = laps.map((l) => l.lapTime);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(DT + 1e-9);
    times.forEach((t) => {
      expect(t).toBeGreaterThan(6.4);
      expect(t).toBeLessThan(6.6);
    });
    expect(laps[0].best).toBe(true);
    const fin = ev[ev.length - 1].data as { time: number; lapTimes: number[]; rank: number };
    expect(fin.lapTimes).toEqual(times);
    expect(fin.time).toBeCloseTo(times[0] + times[1] + times[2], 9);
    expect(fin.rank).toBe(1);
    // the second lap's splits equal the first lap's
    const cps = ev.filter((e) => e.name === 'checkpoint').map((e) => (e.data as { split: number }).split);
    expect(Math.abs(cps[2] - cps[0])).toBeLessThanOrEqual(DT + 1e-9);
    expect(Math.abs(cps[3] - cps[1])).toBeLessThanOrEqual(DT + 1e-9);
    // after the finish nothing more is counted, however long the ball keeps looping
    expect(published(w).races[0].racers[0]).toMatchObject({ lap: 3, finished: true });
  });

  it('reports the lap counter while the race is on, and the best lap as laps improve', async () => {
    const b = ball([-5, 0, 0], [10, 0, 0]);
    const w = await worldOf([...circuit(5), b], SPACE);
    run(w, 14); // start at ≈ 0.5 s, laps complete at ≈ 6.9 and 13.4 s
    const r = published(w).races[0].racers[0];
    expect(r.lap).toBe(2);
    expect(r.finished).toBe(false);
    expect(r.lapTimes).toHaveLength(2);
    expect(r.bestLap).toBe(Math.min(...r.lapTimes));
    expect(r.bestSplits).toHaveLength(2);
    expect(r.passed).toBeGreaterThanOrEqual(0);
  });

  it('delta against the best lap: a slower second lap shows positive splits', async () => {
    const b = ball([-5, 0, 0], [10, 0, 0]);
    const w = await worldOf([...circuit(2), b], SPACE);
    let slowed = false;
    const ev: ComponentEvent[] = [];
    for (let i = 0; i < 20 * 120; i++) {
      w.stepOnce();
      const got = zoneEvents(w);
      ev.push(...got);
      // after the first lap, drive 20% slower
      if (!slowed && got.some((e) => e.name === 'lap')) {
        slowed = true;
        w.setVelocity(b.id, [8, 0, 0], [0, 0, 0]);
      }
    }
    const cps = ev.filter((e) => e.name === 'checkpoint').map((e) => e.data as { delta: number | null; lap: number });
    expect(cps[0].delta).toBeNull(); // nothing to compare with in the first lap
    expect(cps[2].lap).toBe(2);
    expect(cps[2].delta).toBeGreaterThan(0.3); // the slower first checkpoint of lap 2 is behind the best lap
  });
});

describe('penalties', () => {
  it('a respawning kill zone adds its time penalty to the lap and the total', async () => {
    const b = ball([0, 0, 0], [10, 0, 0]);
    const trap = zoneBody(
      { action: 'kill', killMode: 'respawn', respawnTo: 'checkpoint', penalty: 5, maxTriggers: 1, race: 'r1' },
      { position: [15, 0, 0], size: [1, 8, 8], name: 'trap' },
    );
    const w = await worldOf([gate('checkpoint', 10, { index: 1 }), trap, gate('finish', 30, { laps: 1 }), b], SPACE);
    expect(runUntil(w, 'respawn', 3)).not.toBeNull(); // thrown back to checkpoint 1, at rest
    w.setVelocity(b.id, [10, 0, 0], [0, 0, 0]); // …and sent on again
    const fin = runUntil(w, 'finish', 5)!;
    const data = fin.data as { time: number; penalty: number; lapTimes: number[] };
    expect(data.penalty).toBe(5);
    expect(data.time).toBeCloseTo(fin.t + 5, 6); // clock from 0, plus the penalty
    expect(data.lapTimes[0]).toBeCloseTo(data.time, 9);
    expect(published(w).races[0].racers[0].penalty).toBe(5);
  });

  it('a score penalty comes off the score', async () => {
    const trap = zoneBody({ action: 'kill', killMode: 'remove', penaltyPoints: 25 }, { size: [4, 4, 4] });
    const coin = zoneBody({ action: 'score', points: 100 }, { position: [20, 0, 0], size: [2, 2, 2] });
    const w = await worldOf([trap, coin, ball([0, 0, 0]), ball([20, 0, 0])], SPACE);
    run(w, 0.1);
    expect(published(w).score.total).toBe(75);
  });
});

describe('who is racing', () => {
  it('each body has its own progress; two balls are two racers, ranked in the order they finish', async () => {
    const fast = ball([0, 0, -2], [12, 0, 0]);
    const slow = ball([0, 0, 2], [10, 0, 0]);
    const w = await worldOf([gate('checkpoint', 10, { index: 1 }), gate('finish', 30, { laps: 1 }), fast, slow], SPACE);
    const ev = raceEvents(runCollect(w, 4));
    const finishes = ev
      .filter((e) => e.name === 'finish')
      .map((e) => e.data as { racer: string; rank: number; time: number });
    expect(finishes.map((f) => [f.racer, f.rank])).toEqual([
      [fast.id, 1],
      [slow.id, 2],
    ]);
    expect(finishes[0].time).toBeLessThan(finishes[1].time);
    const standing = published(w).races[0].racers.map((r) => r.racer);
    expect(standing).toEqual([fast.id, slow.id]);
  });

  it('a tag filter keeps scenery out of the race', async () => {
    const racer = ball([0, 0, -2], [10, 0, 0], { tags: ['racer'] });
    const crate = ball([0, 0, 2], [10, 0, 0]);
    const w = await worldOf([gate('checkpoint', 10, { index: 1, tags: 'racer' }), racer, crate], SPACE);
    const ev = raceEvents(runCollect(w, 2));
    expect(ev.map((e) => (e.data as { racer: string }).racer)).toEqual([racer.id]);
  });

  it('bodies of one group race as one: the group is the racer, each gate counts once however many bodies cross it', async () => {
    const front = ball([2, 0, 0], [10, 0, 0], { parent: 'car' });
    const rear = ball([-2, 0, 0], [10, 0, 0], { parent: 'car' });
    const gates = [gate('checkpoint', 10, { index: 1, unit: 'group' }), gate('finish', 20, { laps: 1, unit: 'group' })];
    const w = await worldOf([...gates, front, rear], SPACE);
    const ev = raceEvents(runCollect(w, 3));
    expect(ev.map((e) => e.name)).toEqual(['checkpoint', 'lap', 'finish']);
    expect(ev.every((e) => (e.data as { racer: string }).racer === 'car')).toBe(true);
    // the same scene per body: two racers
    const w2 = await worldOf(
      [
        gate('checkpoint', 10, { index: 1 }),
        gate('finish', 20, { laps: 1 }),
        ball([2, 0, 0], [10, 0, 0]),
        ball([-2, 0, 0], [10, 0, 0]),
      ],
      SPACE,
    );
    expect(raceEvents(runCollect(w2, 3)).filter((e) => e.name === 'finish')).toHaveLength(2);
  });
});

describe('any vehicle: the drivable car', () => {
  function carRace(): { entities: Entity[]; chassisId: string; groupId: string } {
    const doc = buildCar(false);
    const group = createGroup({ name: 'Car' });
    const bodies = doc.entities.filter((e): e is BodyEntity => e.kind === 'body');
    const members = new Set(bodies.map((b) => b.id));
    const entities: Entity[] = [group];
    for (const e of doc.entities) entities.push(members.has(e.id) ? { ...(e as BodyEntity), parent: group.id } : e);
    const gates = [
      gate('checkpoint', 6, { index: 1, unit: 'group' }),
      gate('checkpoint', 12, { index: 2, unit: 'group' }),
      gate('finish', 18, { laps: 1, unit: 'group' }),
    ].map(
      (z) =>
        ({ ...z, size: undefined, shape: { ...z.shape, size: [1, 6, 12] as [number, number, number] } }) as BodyEntity,
    );
    const chassis = bodies.find((b) => b.name === 'Chassis')!;
    return { entities: [...entities, ...gates], chassisId: chassis.id, groupId: group.id };
  }

  it('a multi-body car (chassis, cabin, hubs, four wheels on hinges) driven with W runs the course as one racer', async () => {
    const { entities, groupId } = carRace();
    const doc = docOf(entities, { solverIterations: 10 });
    const w = await PhysicsWorld.create(doc);
    w.setKeys(['KeyW']);
    const ev: ComponentEvent[] = [];
    for (let i = 0; i < 12 * 120; i++) {
      w.stepOnce();
      ev.push(...zoneEvents(w));
    }
    const race = raceEvents(ev);
    expect(race.map((e) => e.name)).toEqual(['checkpoint', 'checkpoint', 'lap', 'finish']);
    expect(race.every((e) => (e.data as { racer: string }).racer === groupId)).toBe(true);
    const splits = race.filter((e) => e.name === 'checkpoint').map((e) => (e.data as { split: number }).split);
    expect(splits[1]).toBeGreaterThan(splits[0]);
    expect((race[3].data as { time: number }).time).toBeGreaterThan(splits[1]);
    // …and exactly one racer was ever created, however many of the car's bodies touched a gate
    expect(published(w).races[0].racers).toHaveLength(1);
  });
});

describe('snapshots', () => {
  it('a snapshot taken mid-race brings back the standings and the replay is identical', async () => {
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf(
      [gate('checkpoint', 10, { index: 1 }), gate('checkpoint', 20, { index: 2 }), gate('finish', 40, { laps: 1 }), b],
      SPACE,
    );
    run(w, 2.5); // past both checkpoints
    zoneEvents(w);
    const mid = published(w);
    expect(mid.races[0].racers[0].passed).toBe(2);
    const snap = w.snapshot();
    const first = runCollect(w, 3);
    const stateFirst = published(w);
    w.restore(snap);
    const restored = published(w);
    expect(restored.races[0].racers[0]).toEqual(mid.races[0].racers[0]); // the standings are back
    const second = runCollect(w, 3);
    expect(second).toEqual(first);
    expect(published(w)).toEqual(stateFirst);
    expect(raceEvents(second).map((e) => e.name)).toEqual(['lap', 'finish']);
  });

  it('restoring into a fresh world of the same scene continues the race there', async () => {
    const entities = () => {
      const b = ball([0, 0, 0], [10, 0, 0]);
      return [gate('checkpoint', 10, { index: 1 }), gate('finish', 30, { laps: 1 }), b];
    };
    const ents = entities();
    const w = await PhysicsWorld.create(docOf(ents, SPACE));
    run(w, 1.5);
    zoneEvents(w);
    const snap = w.snapshot();
    const rest = runCollect(w, 3);
    const other = await PhysicsWorld.create(docOf(ents, SPACE));
    other.restore(snap);
    expect(runCollect(other, 3)).toEqual(rest);
  });
});

describe('document sanity', () => {
  it('a document with zones round-trips through the serialiser with its components intact', async () => {
    const { serializeDocument, parseDocument } = await import('../src/model/serialize');
    const doc = newDocument('race');
    doc.entities = [gate('checkpoint', 10, { index: 2, race: 'night' }), gate('finish', 20, { laps: 3 })];
    const back = parseDocument(serializeDocument(doc));
    expect(back.entities).toEqual(doc.entities);
  });
});

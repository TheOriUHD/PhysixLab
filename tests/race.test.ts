/**
 * The race rules on their own (ZN-3): ordered checkpoints, lap counting, split times, best lap, penalties, the finishing
 * order and snapshots of the book — pure logic, no engine.
 */
import { describe, expect, it } from 'vitest';
import { RaceBook, type FinishLineSpec, type RaceSpec } from '../src/physics/zones/race';

const SPEC: RaceSpec = { checkpoints: [1, 2, 3], hasStart: false, laps: 3 };
const LINE: FinishLineSpec = { laps: 3, requireAll: true, startsClock: false };

/** One clean lap: the three checkpoints at `t0 + 1, 2, 3` and the line at `t0 + 4`. */
function lap(book: RaceBook, racer: string, t0: number, spec = SPEC, line = LINE, scale = 1) {
  for (const i of [1, 2, 3]) book.checkpoint('r', racer, i, t0 + i * scale, spec);
  return book.finishLine('r', racer, t0 + 4 * scale, line, spec);
}

describe('ordered checkpoints', () => {
  it('passing them in order records a split for each', () => {
    const b = new RaceBook();
    const out = [1, 2, 3].map((i) => b.checkpoint('r', 'a', i, i * 1.5, SPEC));
    expect(out.map((o) => o.kind)).toEqual(['passed', 'passed', 'passed']);
    expect(out.map((o) => (o.kind === 'passed' ? o.split : -1))).toEqual([1.5, 3, 4.5]);
    expect(b.racer('r', 'a')?.passed).toBe(3);
  });

  it('jumping ahead is reported as skipped and does not count; the racer still needs the missed one', () => {
    const b = new RaceBook();
    expect(b.checkpoint('r', 'a', 1, 1, SPEC).kind).toBe('passed');
    const jump = b.checkpoint('r', 'a', 3, 2, SPEC);
    expect(jump).toEqual({ kind: 'skipped', index: 3, expected: 2 });
    expect(b.racer('r', 'a')?.passed).toBe(1);
    expect(b.checkpoint('r', 'a', 2, 3, SPEC).kind).toBe('passed');
    expect(b.checkpoint('r', 'a', 3, 4, SPEC).kind).toBe('passed');
  });

  it('driving back through a gate that is already behind the racer is ignored', () => {
    const b = new RaceBook();
    b.checkpoint('r', 'a', 1, 1, SPEC);
    b.checkpoint('r', 'a', 2, 2, SPEC);
    expect(b.checkpoint('r', 'a', 1, 2.5, SPEC)).toEqual({ kind: 'ignored' });
    expect(b.checkpoint('r', 'a', 2, 2.6, SPEC)).toEqual({ kind: 'ignored' });
    expect(b.racer('r', 'a')?.passed).toBe(2);
  });

  it('zones that share a number are alternatives: the spec lists the number once', () => {
    const b = new RaceBook();
    const spec: RaceSpec = { checkpoints: [1, 2], hasStart: false, laps: 1 };
    expect(b.checkpoint('r', 'a', 1, 1, spec).kind).toBe('passed'); // either gate numbered 1
    expect(b.checkpoint('r', 'a', 1, 1.1, spec).kind).toBe('ignored'); // the other one afterwards is behind the racer
    expect(b.checkpoint('r', 'a', 2, 2, spec).kind).toBe('passed');
  });

  it('racers are independent', () => {
    const b = new RaceBook();
    b.checkpoint('r', 'a', 1, 1, SPEC);
    b.checkpoint('r', 'a', 2, 2, SPEC);
    expect(b.checkpoint('r', 'b', 2, 2, SPEC).kind).toBe('skipped');
    expect(b.racer('r', 'a')?.passed).toBe(2);
    expect(b.racer('r', 'b')?.passed).toBe(0);
  });

  it('a race of its own name does not mix with another', () => {
    const b = new RaceBook();
    b.checkpoint('one', 'a', 1, 1, SPEC);
    expect(b.checkpoint('two', 'a', 1, 2, SPEC).kind).toBe('passed');
    expect(b.racesOf('a').sort()).toEqual(['one', 'two']);
  });
});

describe('laps', () => {
  it('a lap needs every checkpoint, then the line: lap time, lap counter, splits reset', () => {
    const b = new RaceBook();
    const out = lap(b, 'a', 0);
    expect(out.kind).toBe('lap');
    if (out.kind !== 'lap') return;
    expect(out.lap).toMatchObject({ lap: 1, lapTime: 4, best: true, overall: true, splits: [1, 2, 3] });
    expect(out.finish).toBeNull();
    const r = b.racer('r', 'a')!;
    expect(r).toMatchObject({ lap: 1, passed: 0, lastLap: 4, bestLap: 4, lapStart: 4 });
    expect(r.splits).toEqual([]);
  });

  it('the line without all checkpoints does not count (reported with the checkpoint that was missing)', () => {
    const b = new RaceBook();
    b.checkpoint('r', 'a', 1, 1, SPEC);
    expect(b.finishLine('r', 'a', 2, LINE, SPEC)).toEqual({ kind: 'skipped', index: 0, expected: 2 });
    expect(b.racer('r', 'a')?.lap).toBe(0);
  });

  it('a line that does not require the checkpoints counts every crossing', () => {
    const b = new RaceBook();
    const out = b.finishLine('r', 'a', 3, { ...LINE, requireAll: false }, SPEC);
    expect(out.kind).toBe('lap');
  });

  it('counts laps and finishes after the last: three laps of 4 s, total 12 s, rank 1', () => {
    const b = new RaceBook();
    const outs = [0, 4, 8].map((t0) => lap(b, 'a', t0));
    const kinds = outs.map((o) => (o.kind === 'lap' ? [o.lap.lap, o.finish !== null] : null));
    expect(kinds).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    const last = outs[2];
    if (last.kind !== 'lap' || !last.finish) throw new Error('no finish');
    expect(last.finish).toMatchObject({ time: 12, laps: 3, rank: 1, lapTimes: [4, 4, 4], penalty: 0 });
    const r = b.racer('r', 'a')!;
    expect(r).toMatchObject({ finished: true, finishTime: 12, rank: 1, lap: 3 });
    // once finished, nothing more counts
    expect(b.checkpoint('r', 'a', 1, 13, SPEC).kind).toBe('ignored');
    expect(b.finishLine('r', 'a', 14, LINE, SPEC).kind).toBe('ignored');
  });

  it('ranks are the order in which the finish line was crossed (not the lap times), finishers come first in the standings', () => {
    const b = new RaceBook();
    lap(b, 'first', 0, SPEC, { ...LINE, laps: 1 }, 2); // crosses the line first (at t = 8)…
    lap(b, 'second', 0, SPEC, { ...LINE, laps: 1 }, 1); // …a racer that crosses afterwards is second whatever its times
    b.checkpoint('r', 'still-racing', 1, 1, SPEC);
    const pub = b.toPublic(new Map([['r', { ...SPEC, laps: 1 }]]));
    expect(pub[0].racers.map((r) => [r.racer, r.rank])).toEqual([
      ['first', 1],
      ['second', 2],
      ['still-racing', 0],
    ]);
  });

  it('running positions: more laps, then more checkpoints, then who got there first', () => {
    const b = new RaceBook();
    lap(b, 'a', 0); // a: 1 lap
    b.checkpoint('r', 'b', 1, 1, SPEC);
    b.checkpoint('r', 'b', 2, 2, SPEC); // b: lap 0, 2 checkpoints
    b.checkpoint('r', 'c', 1, 1, SPEC);
    b.checkpoint('r', 'c', 2, 2.5, SPEC); // c: same progress as b, later
    b.checkpoint('r', 'd', 1, 1, SPEC); // d: 1 checkpoint
    const pub = b.toPublic(new Map([['r', SPEC]]));
    expect(pub[0].racers.map((r) => r.racer)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('split times and the best lap', () => {
  it('the best lap and its splits are kept; later laps are compared against them', () => {
    const b = new RaceBook();
    lap(b, 'a', 0, SPEC, LINE, 1); // 4 s, splits 1 2 3
    lap(b, 'a', 4, SPEC, LINE, 1.5); // 6 s, slower
    const r = b.racer('r', 'a')!;
    expect(r.bestLap).toBe(4);
    expect(r.lastLap).toBe(6);
    expect(r.bestSplits).toEqual([1, 2, 3]);
    // a third lap: delta against the best splits (1, 2, 3)
    const o = b.checkpoint('r', 'a', 1, 10 + 1.2, SPEC);
    expect(o.kind === 'passed' && o.delta).toBeCloseTo(0.2, 9);
    const o2 = b.checkpoint('r', 'a', 2, 10 + 1.7, SPEC);
    expect(o2.kind === 'passed' && o2.delta).toBeCloseTo(-0.3, 9);
  });

  it('flags a new personal best and a new race record', () => {
    const b = new RaceBook();
    const first = lap(b, 'a', 0, SPEC, LINE, 1);
    expect(first.kind === 'lap' && [first.lap.best, first.lap.overall]).toEqual([true, true]);
    const slower = lap(b, 'b', 0, SPEC, LINE, 1.5); // b's first lap: personal best, not a record
    expect(slower.kind === 'lap' && [slower.lap.best, slower.lap.overall]).toEqual([true, false]);
    const faster = lap(b, 'a', 4, SPEC, LINE, 0.9); // a improves: 3.6 s
    expect(faster.kind === 'lap' && [faster.lap.best, faster.lap.overall]).toEqual([true, true]);
    const record = b.toPublic(new Map([['r', SPEC]]))[0].record!;
    expect(record.racer).toBe('a');
    expect(record.time).toBeCloseTo(3.6, 9);
  });
});

describe('the clock', () => {
  const withStart: RaceSpec = { ...SPEC, hasStart: true };

  it('with a start line nothing counts until it is crossed; the clock starts there', () => {
    const b = new RaceBook();
    expect(b.checkpoint('r', 'a', 1, 1, withStart).kind).toBe('ignored');
    expect(b.start('r', 'a', 2, withStart)).toEqual({ kind: 'started', time: 2 });
    expect(b.start('r', 'a', 3, withStart)).toEqual({ kind: 'ignored' }); // already running
    const o = b.checkpoint('r', 'a', 1, 5, withStart);
    expect(o.kind === 'passed' && o.split).toBe(3); // relative to the start, not to time 0
  });

  it('without one every racer’s clock runs from its birth (0 for the scene’s bodies)', () => {
    const b = new RaceBook();
    const o = b.checkpoint('r', 'a', 1, 5, SPEC);
    expect(o.kind === 'passed' && o.split).toBe(5);
    const late = b.checkpoint('r', 'spawned', 1, 12, SPEC, 10);
    expect(late.kind === 'passed' && late.split).toBe(2);
  });

  it('a start / finish line starts the clock on the first crossing and completes laps afterwards', () => {
    const b = new RaceBook();
    const circuit: RaceSpec = { checkpoints: [1], hasStart: true, laps: 2 };
    const line: FinishLineSpec = { laps: 2, requireAll: true, startsClock: true };
    expect(b.finishLine('r', 'a', 3, line, circuit)).toEqual({ kind: 'started', time: 3 });
    b.checkpoint('r', 'a', 1, 8, circuit);
    const l1 = b.finishLine('r', 'a', 13, line, circuit);
    expect(l1.kind === 'lap' && l1.lap.lapTime).toBe(10);
    b.checkpoint('r', 'a', 1, 18, circuit);
    const l2 = b.finishLine('r', 'a', 22, line, circuit);
    expect(l2.kind === 'lap' && l2.finish).toMatchObject({ time: 19, rank: 1, lapTimes: [10, 9] });
  });
});

describe('penalties', () => {
  it('add to the current lap and to the total time, never to a racer that is not racing', () => {
    const b = new RaceBook();
    b.start('r', 'a', 0, { ...SPEC, hasStart: true });
    b.checkpoint('r', 'a', 1, 2, { ...SPEC, hasStart: true });
    expect(b.penalise('a', 5)).toBe(1);
    const cp = b.checkpoint('r', 'a', 2, 3, { ...SPEC, hasStart: true });
    expect(cp.kind === 'passed' && cp.split).toBe(8); // 3 s + the 5 s penalty
    b.checkpoint('r', 'a', 3, 4, { ...SPEC, hasStart: true });
    const done = b.finishLine('r', 'a', 5, { ...LINE, laps: 1 }, { ...SPEC, hasStart: true });
    if (done.kind !== 'lap' || !done.finish) throw new Error('not finished');
    expect(done.lap.lapTime).toBe(10);
    expect(done.finish).toMatchObject({ time: 10, penalty: 5 });
    expect(b.penalise('a', 5)).toBe(0); // finished
    expect(b.penalise('nobody', 5)).toBe(0);
  });

  it('a penalty belongs to the lap it was earned in', () => {
    const b = new RaceBook();
    lap(b, 'a', 0);
    b.penalise('a', 3);
    const second = lap(b, 'a', 4);
    expect(second.kind === 'lap' && second.lap.lapTime).toBe(7);
    expect(b.racer('r', 'a')?.lapTimes).toEqual([4, 7]);
    expect(b.racer('r', 'a')?.penalty).toBe(3);
  });
});

describe('saving', () => {
  it('a saved book loads back to the same standings', () => {
    const b = new RaceBook();
    lap(b, 'a', 0);
    lap(b, 'b', 0, SPEC, LINE, 2);
    b.checkpoint('r', 'a', 1, 5, SPEC);
    b.penalise('a', 2);
    const copy = new RaceBook();
    copy.load(JSON.parse(JSON.stringify(b.save())));
    const specs = new Map([['r', SPEC]]);
    expect(copy.toPublic(specs)).toEqual(b.toPublic(specs));
    // and it carries on identically
    expect(copy.checkpoint('r', 'a', 2, 6, SPEC)).toEqual(b.checkpoint('r', 'a', 2, 6, SPEC));
  });

  it('garbage loads as an empty book', () => {
    const b = new RaceBook();
    b.load('nonsense');
    b.load([{ nope: 1 }]);
    expect(b.raceNames).toEqual([]);
  });
});

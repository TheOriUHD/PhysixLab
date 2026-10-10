/**
 * Race bookkeeping for the zone system (ZN-3): per-racer progress through ordered checkpoints, laps, split times,
 * best lap, penalties and the finishing order. Pure TypeScript — no engine, no world — so the rules are unit-tested
 * on their own (`tests/race.test.ts`) and then again through real zones in the engine (`tests/zones.race.test.ts`).
 *
 * Vocabulary
 *   race        a name; every start / checkpoint / finish zone with the same name belongs to the same race.
 *   racer       whoever crosses the zones: a body, or a whole group (a vehicle) — the zone decides, see `unit`.
 *   checkpoint  has a number (`index`, 1 …). The racer must pass them in ascending order within a lap; zones that
 *               share a number are alternatives (either counts). Crossing an earlier one again is ignored; jumping
 *               ahead is reported as `skipped` and does not count.
 *   lap         start/finish line → every checkpoint in order → the finish line again.
 *   clock       starts at a start line (or at a start / finish line's first crossing). A race without either starts
 *               every racer's clock at `born` (0 for bodies of the scene).
 *   penalty     seconds added to the racer's times (lap and total) — a respawn after a fall, a kill zone.
 *
 * All times are simulation seconds. A lap time is `t − lapStart + penalty collected during the lap`; the total time of
 * a finished racer is `t − clockStart + all penalties`.
 */
import type { RacePublic, RacerPublic } from '../../model/zones';

/** What the book needs to know about a race from the zones that exist right now. */
export interface RaceSpec {
  /** Distinct checkpoint numbers, ascending. */
  checkpoints: number[];
  /** A start line (or a start / finish line) controls the clock. */
  hasStart: boolean;
  /** Laps to finish: the largest `laps` of the race's finish lines (1 if there is none). */
  laps: number;
}

export interface FinishLineSpec {
  laps: number;
  /** The racer must have passed every checkpoint this lap for the crossing to count. */
  requireAll: boolean;
  /** The first crossing starts the clock instead of completing a lap (a circuit's start / finish line). */
  startsClock: boolean;
}

export type StartOutcome = { kind: 'started'; time: number } | { kind: 'ignored' };

export type CheckpointOutcome =
  | { kind: 'passed'; index: number; split: number; delta: number | null; lap: number }
  | { kind: 'skipped'; index: number; expected: number }
  | { kind: 'ignored' };

export interface LapInfo {
  lap: number;
  lapTime: number;
  best: boolean;
  overall: boolean;
  splits: number[];
}
export interface FinishInfo {
  time: number;
  laps: number;
  rank: number;
  lapTimes: number[];
  penalty: number;
}
export type LineOutcome =
  | { kind: 'started'; time: number }
  | { kind: 'lap'; lap: LapInfo; finish: FinishInfo | null }
  | { kind: 'skipped'; index: number; expected: number }
  | { kind: 'ignored' };

interface RaceData {
  racers: Map<string, RacerPublic>;
  record: { racer: string; time: number } | null;
  finishers: number;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class RaceBook {
  private races = new Map<string, RaceData>();

  clear(): void {
    this.races.clear();
  }

  get raceNames(): string[] {
    return [...this.races.keys()];
  }

  racer(race: string, racer: string): RacerPublic | undefined {
    return this.races.get(race)?.racers.get(racer);
  }

  /** Every race a racer takes part in. */
  racesOf(racer: string): string[] {
    const out: string[] = [];
    for (const [name, r] of this.races) if (r.racers.has(racer)) out.push(name);
    return out;
  }

  private data(race: string): RaceData {
    let d = this.races.get(race);
    if (!d) this.races.set(race, (d = { racers: new Map(), record: null, finishers: 0 }));
    return d;
  }

  private ensure(race: string, racer: string, spec: RaceSpec, born: number): RacerPublic {
    const d = this.data(race);
    let r = d.racers.get(racer);
    if (!r) {
      const start = spec.hasStart ? null : born;
      r = {
        racer,
        clockStart: start,
        lap: 0,
        passed: 0,
        lapStart: start,
        lapPenalty: 0,
        splits: [],
        lapTimes: [],
        lastLap: null,
        bestLap: null,
        bestSplits: null,
        penalty: 0,
        finished: false,
        finishTime: null,
        rank: 0,
        lastTime: born,
      };
      d.racers.set(racer, r);
    }
    return r;
  }

  /** A start line was entered. A racer that already started (or finished) is left alone. */
  start(race: string, racer: string, t: number, spec: RaceSpec, born = 0): StartOutcome {
    const r = this.ensure(race, racer, { ...spec, hasStart: true }, born);
    if (r.clockStart !== null || r.finished) return { kind: 'ignored' };
    r.clockStart = t;
    r.lapStart = t;
    r.lastTime = t;
    return { kind: 'started', time: t };
  }

  checkpoint(race: string, racer: string, index: number, t: number, spec: RaceSpec, born = 0): CheckpointOutcome {
    const r = this.ensure(race, racer, spec, born);
    if (r.finished || r.clockStart === null || r.lapStart === null) return { kind: 'ignored' };
    const expected = spec.checkpoints[r.passed];
    if (expected === undefined) return { kind: 'ignored' }; // every checkpoint of this lap is behind the racer
    if (index === expected) {
      const split = t - r.lapStart + r.lapPenalty;
      r.splits.push(split);
      r.passed++;
      r.lastTime = t;
      const ref = r.bestSplits?.[r.passed - 1];
      return { kind: 'passed', index, split, delta: ref === undefined ? null : split - ref, lap: r.lap + 1 };
    }
    // A number already behind the racer is just the racer driving back through a gate: ignore it.
    if (spec.checkpoints.indexOf(index) >= 0 && index < expected) return { kind: 'ignored' };
    return { kind: 'skipped', index, expected };
  }

  finishLine(race: string, racer: string, t: number, line: FinishLineSpec, spec: RaceSpec, born = 0): LineOutcome {
    const r = this.ensure(race, racer, spec, born);
    if (r.finished) return { kind: 'ignored' };
    if (r.clockStart === null && line.startsClock) {
      r.clockStart = t;
      r.lapStart = t;
      r.lastTime = t;
      return { kind: 'started', time: t };
    }
    if (r.clockStart === null || r.lapStart === null) return { kind: 'ignored' };
    if (line.requireAll && r.passed < spec.checkpoints.length) {
      return { kind: 'skipped', index: 0, expected: spec.checkpoints[r.passed] };
    }
    const d = this.data(race);
    const lapTime = t - r.lapStart + r.lapPenalty;
    r.lap++;
    r.lapTimes.push(lapTime);
    r.lastLap = lapTime;
    const best = r.bestLap === null || lapTime < r.bestLap;
    if (best) {
      r.bestLap = lapTime;
      r.bestSplits = [...r.splits];
    }
    const overall = d.record === null || lapTime < d.record.time;
    if (overall) d.record = { racer, time: lapTime };
    const info: LapInfo = { lap: r.lap, lapTime, best, overall, splits: [...r.splits] };
    r.passed = 0;
    r.splits = [];
    r.lapStart = t;
    r.lapPenalty = 0;
    r.lastTime = t;
    let finish: FinishInfo | null = null;
    if (r.lap >= Math.max(1, line.laps)) {
      r.finished = true;
      r.finishTime = t - r.clockStart + r.penalty;
      r.rank = ++d.finishers;
      finish = { time: r.finishTime, laps: r.lap, rank: r.rank, lapTimes: [...r.lapTimes], penalty: r.penalty };
    }
    return { kind: 'lap', lap: info, finish };
  }

  /** Add `seconds` to a racer's lap and total time in every race it is racing in. Returns how many races it touched. */
  penalise(racer: string, seconds: number): number {
    if (!(seconds > 0)) return 0;
    let n = 0;
    for (const d of this.races.values()) {
      const r = d.racers.get(racer);
      if (!r || r.finished || r.clockStart === null) continue;
      r.penalty += seconds;
      r.lapPenalty += seconds;
      n++;
    }
    return n;
  }

  /** The published form: every race with its racers in running order (finishers by rank, then by progress). */
  toPublic(specs: ReadonlyMap<string, RaceSpec>): RacePublic[] {
    const out: RacePublic[] = [];
    for (const [race, d] of this.races) {
      const spec = specs.get(race) ?? { checkpoints: [], hasStart: false, laps: 1 };
      const racers = [...d.racers.values()].sort((a, b) => {
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.finished && b.finished) return a.rank - b.rank;
        if (a.lap !== b.lap) return b.lap - a.lap;
        if (a.passed !== b.passed) return b.passed - a.passed;
        return a.lastTime - b.lastTime;
      });
      out.push({
        race,
        laps: spec.laps,
        checkpoints: [...spec.checkpoints],
        hasStart: spec.hasStart,
        record: d.record ? { ...d.record } : null,
        racers: racers.map((r) => clone(r)),
      });
    }
    return out.sort((a, b) => a.race.localeCompare(b.race));
  }

  save(): unknown {
    return [...this.races].map(([race, d]) => ({
      race,
      record: d.record,
      finishers: d.finishers,
      racers: [...d.racers.values()].map((r) => clone(r)),
    }));
  }

  load(data: unknown): void {
    this.races.clear();
    if (!Array.isArray(data)) return;
    for (const item of data as {
      race?: unknown;
      record?: { racer: string; time: number } | null;
      finishers?: unknown;
      racers?: unknown;
    }[]) {
      if (typeof item?.race !== 'string' || !Array.isArray(item.racers)) continue;
      const d: RaceData = {
        racers: new Map(),
        record: item.record ?? null,
        finishers: typeof item.finishers === 'number' ? item.finishers : 0,
      };
      for (const r of item.racers as RacerPublic[]) d.racers.set(r.racer, clone(r));
      this.races.set(item.race, d);
    }
  }
}

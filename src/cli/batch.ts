/**
 * DT-33: headless batch runner. Pure TypeScript over `PhysicsWorld` — no DOM, no worker — so the same code is
 * used by the CLI (`npm run cli`), by tests and by anything that wants to run a scene to completion.
 *
 *  - `parseSweep('gravity=-1,-9.81')` / `expandSweeps` build the cartesian product of parameter values.
 *  - `setParam(doc, path, value)` writes one parameter into a (cloned) document.
 *  - `runBatch(doc, opts)` simulates every sweep point and returns a time series per run and a final-state summary.
 *
 * Determinism: the world is stepped with `stepOnce()` (fixed step, no wall-clock) and seeded from
 * `settings.seed` (or `opts.seed`), so identical inputs give identical outputs on every machine.
 */
import type { SceneDocument } from '../model/types';
import { PhysicsWorld } from '../physics/world';

export interface SweepSpec {
  path: string;
  values: (number | string | boolean)[];
}

export interface BatchOptions {
  /** Fixed steps to simulate per run. */
  steps: number;
  /** Record a sample every `every` steps (1 = every step); the final step is always recorded. */
  every?: number;
  /** Seed override (also reachable as a sweep over `seed`). */
  seed?: number;
  sweeps?: SweepSpec[];
  /** Entity names or ids to record; default: every body. */
  track?: string[];
}

export interface RunSample {
  step: number;
  time: number;
  /** Per tracked body: [x y z vx vy vz]. */
  bodies: Record<string, number[]>;
  energy: { kinetic: number; rotational: number; potential: number; elastic: number };
}

export interface RunResult {
  index: number;
  params: Record<string, number | string | boolean>;
  seed: number;
  samples: RunSample[];
  final: RunSample;
}

export class BatchError extends Error {}

// ── sweeps ─────────────────────────────────────────────────────────────────────────────────────

const MAX_SWEEP_POINTS = 10_000;
const MAX_STEPS = 10_000_000;
/** Cap on recorded rows (runs × samples × bodies) so memory stays bounded. */
const MAX_SAMPLES = 2_000_000;

/** `path=v1,v2,v3` or `path=from:to:count` (inclusive, linear). Values parse as number / true / false / text. */
export function parseSweep(text: string): SweepSpec {
  const eq = text.indexOf('=');
  if (eq <= 0) throw new BatchError(`Sweep "${text}" must look like path=v1,v2,v3 or path=from:to:count`);
  const path = text.slice(0, eq).trim();
  const rhs = text.slice(eq + 1).trim();
  if (!rhs) throw new BatchError(`Sweep "${text}" has no values`);
  const range = /^(-?[\d.eE+-]+):(-?[\d.eE+-]+):(\d+)$/.exec(rhs);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    const n = Number(range[3]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || n < 1 || n > MAX_SWEEP_POINTS)
      throw new BatchError(`Sweep "${text}": invalid range`);
    const values = n === 1 ? [from] : Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
    return { path, values };
  }
  return {
    path,
    values: rhs.split(',').map((s) => {
      const t = s.trim();
      if (t === 'true') return true;
      if (t === 'false') return false;
      const n = Number(t);
      return t !== '' && Number.isFinite(n) ? n : t;
    }),
  };
}

/** Cartesian product of the sweeps (first sweep varies slowest). No sweeps = one empty parameter set. */
export function expandSweeps(sweeps: SweepSpec[]): Record<string, number | string | boolean>[] {
  let total = 1;
  for (const s of sweeps) {
    if (s.values.length === 0) throw new BatchError(`Sweep "${s.path}" has no values`);
    total *= s.values.length;
    if (total > MAX_SWEEP_POINTS) throw new BatchError(`Sweep has more than ${MAX_SWEEP_POINTS} points`);
  }
  let out: Record<string, number | string | boolean>[] = [{}];
  for (const s of sweeps) out = out.flatMap((p) => s.values.map((v) => ({ ...p, [s.path]: v })));
  return out;
}

// ── parameter paths ────────────────────────────────────────────────────────────────────────────

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Write one parameter into `doc` (mutates). Paths:
 *   gravity            → settings.gravity[1]  (also gravity.x / gravity.y / gravity.z)
 *   seed               → settings.seed
 *   settings.<a.b.c>   → any scene setting, e.g. settings.airDrag
 *   <entity>.<a.b.c>   → a field of the entity with that name or id, e.g. Ball.material.friction, Ball.position.1
 */
export function setParam(doc: SceneDocument, path: string, value: number | string | boolean): void {
  const parts = path.split('.');
  if (parts.some((p) => FORBIDDEN.has(p) || p === '')) throw new BatchError(`Invalid parameter path "${path}"`);
  const head = parts[0];
  if (head === 'gravity') {
    const axis = parts[1] === undefined ? 1 : ({ x: 0, y: 1, z: 2 } as Record<string, number>)[parts[1]];
    if (axis === undefined || typeof value !== 'number') throw new BatchError(`Invalid gravity parameter "${path}"`);
    doc.settings.gravity = [...doc.settings.gravity];
    doc.settings.gravity[axis] = value;
    return;
  }
  if (head === 'seed') {
    if (typeof value !== 'number') throw new BatchError('seed must be a number');
    doc.settings.seed = value >>> 0;
    return;
  }
  let target: unknown;
  let rest: string[];
  if (head === 'settings') {
    target = doc.settings;
    rest = parts.slice(1);
  } else {
    const matches = doc.entities.filter((e) => e.id === head || e.name === head);
    if (matches.length === 0) throw new BatchError(`No entity named or with id "${head}" for parameter "${path}"`);
    if (matches.length > 1) throw new BatchError(`"${head}" matches ${matches.length} entities; use the id instead`);
    target = matches[0];
    rest = parts.slice(1);
  }
  if (rest.length === 0) throw new BatchError(`Parameter "${path}" names no field`);
  let obj = target as Record<string, unknown>;
  for (let i = 0; i < rest.length - 1; i++) {
    const next = obj[rest[i]];
    if (next === null || typeof next !== 'object')
      throw new BatchError(`Parameter "${path}": "${rest[i]}" is not an object`);
    // Copy arrays/objects on the way so the shared source document is never touched.
    obj[rest[i]] = Array.isArray(next) ? [...(next as unknown[])] : { ...next };
    obj = obj[rest[i]] as Record<string, unknown>;
  }
  const last = rest[rest.length - 1];
  if (!(last in obj)) throw new BatchError(`Parameter "${path}": unknown field "${last}"`);
  if (typeof obj[last] !== typeof value) throw new BatchError(`Parameter "${path}" expects a ${typeof obj[last]}`);
  obj[last] = value;
}

// ── running ────────────────────────────────────────────────────────────────────────────────────

function sample(w: PhysicsWorld, step: number, ids: string[]): RunSample {
  const bodies: Record<string, number[]> = {};
  for (const id of ids) {
    const p = w.getPose(id);
    if (p) bodies[id] = [...p.position, ...p.linvel];
  }
  const e = w.stats().energy;
  return {
    step,
    time: w.simTime,
    bodies,
    energy: { kinetic: e.kinetic, rotational: e.rotational, potential: e.potential, elastic: e.elastic },
  };
}

function check(s: RunSample): void {
  for (const v of Object.values(s.bodies))
    if (v.some((x) => !Number.isFinite(x)))
      throw new BatchError(`Simulation diverged (non-finite state) at step ${s.step}`);
}

export async function runBatch(source: SceneDocument, opts: BatchOptions): Promise<RunResult[]> {
  if (!Number.isInteger(opts.steps) || opts.steps < 1 || opts.steps > MAX_STEPS)
    throw new BatchError(`steps must be an integer between 1 and ${MAX_STEPS}`);
  const every = Math.max(1, Math.floor(opts.every ?? 1));
  const points = expandSweeps(opts.sweeps ?? []);
  const results: RunResult[] = [];
  let recorded = 0;
  for (let index = 0; index < points.length; index++) {
    const params = points[index];
    const doc = structuredClone(source);
    if (opts.seed !== undefined) doc.settings.seed = opts.seed >>> 0;
    for (const [path, value] of Object.entries(params)) setParam(doc, path, value);
    const track = opts.track?.length
      ? doc.entities.filter((e) => e.kind === 'body' && (opts.track!.includes(e.name) || opts.track!.includes(e.id)))
      : doc.entities.filter((e) => e.kind === 'body');
    if (opts.track?.length && track.length === 0)
      throw new BatchError(`None of the tracked names exist: ${opts.track.join(', ')}`);
    const ids = track.map((e) => e.id);
    const w = await PhysicsWorld.create(doc);
    try {
      const samples: RunSample[] = [sample(w, 0, ids)];
      for (let s = 1; s <= opts.steps; s++) {
        w.stepOnce();
        if (s % every === 0 || s === opts.steps) {
          const smp = sample(w, s, ids);
          check(smp);
          samples.push(smp);
          recorded += ids.length || 1;
          if (recorded > MAX_SAMPLES)
            throw new BatchError('Too many recorded values: increase --every or reduce --steps / tracked bodies');
        }
      }
      results.push({ index, params, seed: doc.settings.seed, samples, final: samples[samples.length - 1] });
    } finally {
      w.dispose();
    }
  }
  return results;
}

// ── output ─────────────────────────────────────────────────────────────────────────────────────

const csvCell = (v: unknown): string => {
  let s = String(v);
  // Names come from scene files: neutralise spreadsheet formulas (=, +, -, @ at the start).
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Long-format CSV: one row per run × sample × body. `final: true` keeps only each run's last sample. */
export function toCsv(doc: SceneDocument, results: RunResult[], finalOnly: boolean): string {
  const paramNames = [...new Set(results.flatMap((r) => Object.keys(r.params)))];
  const names = new Map(doc.entities.map((e) => [e.id, e.name]));
  const head = [
    'run',
    ...paramNames,
    'seed',
    'step',
    'time',
    'body',
    'x',
    'y',
    'z',
    'vx',
    'vy',
    'vz',
    'kinetic',
    'potential',
  ];
  const lines = [head.join(',')];
  for (const r of results) {
    for (const s of finalOnly ? [r.final] : r.samples) {
      for (const [id, v] of Object.entries(s.bodies)) {
        lines.push(
          [
            r.index,
            ...paramNames.map((p) => csvCell(r.params[p] ?? '')),
            r.seed,
            s.step,
            s.time,
            csvCell(names.get(id) ?? id),
            ...v,
            s.energy.kinetic,
            s.energy.potential,
          ].join(','),
        );
      }
    }
  }
  return lines.join('\n') + '\n';
}

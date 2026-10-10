/**
 * DT-33: command line front end of the batch runner. Bundled and launched by `scripts/cli.mjs`
 * (`npm run cli -- run scene.json --steps 600 --sweep gravity=-1,-9.81 --out result.csv`).
 *
 * Exit codes: 0 success · 1 simulation failure (diverged, bad parameter) · 2 usage error · 3 scene file unreadable/invalid.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { newReport } from '../model/errors';
import { getTemplate } from '../model/content';
import { parseDocument } from '../model/serialize';
import type { SceneDocument } from '../model/types';
import { BatchError, parseSweep, runBatch, toCsv, type SweepSpec } from './batch';

export const USAGE = `PhysicsLab headless batch runner

Usage:
  npm run cli -- run <scene.json | template:<id>> [options]

Options:
  --steps N            fixed steps to simulate (default 600)
  --every N            record every N-th step (default 10)
  --seed N             RNG seed override (default: the scene's seed)
  --sweep p=v1,v2,..   parameter sweep; also p=from:to:count. Repeatable (cartesian product)
                       paths: gravity | seed | settings.<field> | <entity name or id>.<field>
  --track a,b          entities to record (default: all bodies)
  --out FILE           write results; .csv (default format) or .json; omit to print CSV to stdout
  --final              CSV: only the last sample of every run
  --quiet              no progress summary on stderr
  -h, --help           this text

Exit codes: 0 ok · 1 simulation failed · 2 usage error · 3 scene unreadable
`;

interface Args {
  scene: string;
  steps: number;
  every: number;
  seed?: number;
  sweeps: SweepSpec[];
  track: string[];
  out?: string;
  final: boolean;
  quiet: boolean;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): Args | 'help' {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return 'help';
  if (argv[0] !== 'run') throw new UsageError(`Unknown command "${argv[0]}"`);
  const a: Args = { scene: '', steps: 600, every: 10, sweeps: [], track: [], final: false, quiet: false };
  const num = (flag: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) throw new UsageError(`${flag} needs a number`);
    return n;
  };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${t} needs a value`);
      return v;
    };
    switch (t) {
      case '--steps':
        a.steps = num(t, val());
        break;
      case '--every':
        a.every = num(t, val());
        break;
      case '--seed':
        a.seed = num(t, val());
        break;
      case '--sweep':
        a.sweeps.push(parseSweep(val()));
        break;
      case '--track':
        a.track = val()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--out':
        a.out = val();
        break;
      case '--final':
        a.final = true;
        break;
      case '--quiet':
        a.quiet = true;
        break;
      default:
        if (t.startsWith('-')) throw new UsageError(`Unknown option ${t}`);
        if (a.scene) throw new UsageError(`Unexpected argument ${t}`);
        a.scene = t;
    }
  }
  if (!a.scene) throw new UsageError('Missing scene (file path or template:<id>)');
  return a;
}

function loadScene(spec: string): SceneDocument {
  if (spec.startsWith('template:')) {
    const t = getTemplate(spec.slice('template:'.length));
    if (!t) throw new Error(`Unknown template "${spec.slice(9)}"`);
    return t.build();
  }
  return parseDocument(readFileSync(spec, 'utf8'), newReport());
}

interface CliIo {
  out(s: string): void;
  err(s: string): void;
}

/** Runs the CLI; returns the exit code (never calls process.exit, so tests can drive it). */
export async function main(
  argv: string[],
  io: CliIo = { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s) },
): Promise<number> {
  let args: Args | 'help';
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return e instanceof UsageError || e instanceof BatchError ? 2 : 1;
  }
  if (args === 'help') {
    io.out(USAGE);
    return 0;
  }
  let doc: SceneDocument;
  try {
    doc = loadScene(args.scene);
  } catch (e) {
    io.err(`Cannot open scene: ${(e as Error).message}\n`);
    return 3;
  }
  try {
    const results = await runBatch(doc, {
      steps: args.steps,
      every: args.every,
      seed: args.seed,
      sweeps: args.sweeps,
      track: args.track,
    });
    const json = args.out?.toLowerCase().endsWith('.json');
    const text = json
      ? JSON.stringify({ scene: doc.name, steps: args.steps, runs: results }, null, 1)
      : toCsv(doc, results, args.final);
    if (args.out) writeFileSync(args.out, text);
    else io.out(text);
    if (!args.quiet)
      io.err(`${doc.name}: ${results.length} run(s) × ${args.steps} steps${args.out ? ` → ${args.out}` : ''}\n`);
    return 0;
  } catch (e) {
    io.err(`Simulation failed: ${(e as Error).message}\n`);
    return e instanceof BatchError && /sweep|parameter|steps|tracked|entit|gravity|seed|field/i.test(e.message) ? 2 : 1;
  }
}

/**
 * DT-32: run a scene script in the sandbox and turn what it recorded into a validated scene.
 * Browser only (needs the sandbox); the pure part is `buildFromOps` in ./replay.ts.
 */
import { Sandbox, SandboxError } from '../sandbox/sandbox';
import dslPrelude from './dslPrelude.mjs?raw';
import { buildFromOps, ScriptError, type BuiltScene, type ScriptResult } from './replay';

export const SCRIPT_LIMITS = { maxCodeChars: 100_000, timeoutMs: 3000 } as const;

export interface ScriptRun extends BuiltScene {
  logs: { level: 'log' | 'warn' | 'error'; text: string }[];
  ms: number;
}

export class ScriptFailure extends Error {
  constructor(
    message: string,
    /** 1-based line in the user's code, when the engine reported one. */
    readonly line?: number,
    readonly logs: ScriptRun['logs'] = [],
  ) {
    super(message);
  }
}

/** Line of the user's code mentioned in an engine stack ("<anonymous>:7:3"), or undefined. */
export function userLineOf(stack: string | undefined): number | undefined {
  const m = /<anonymous>:(\d+):\d+/.exec(stack ?? '');
  if (!m) return undefined;
  // The engine wraps the code in `(async function anonymous(...) {\n"use strict";\n<code>` → 3 header lines.
  const line = Number(m[1]) - 3;
  return line >= 1 ? line : undefined;
}

export async function runSceneScript(code: string, timeoutMs: number = SCRIPT_LIMITS.timeoutMs): Promise<ScriptRun> {
  if (code.length > SCRIPT_LIMITS.maxCodeChars)
    throw new ScriptFailure(`The script is longer than ${SCRIPT_LIMITS.maxCodeChars} characters`);
  const logs: ScriptRun['logs'] = [];
  const t0 = performance.now();
  let sb: Sandbox | null = null;
  try {
    sb = await Sandbox.create({
      handlers: {}, // a scene script may call nothing on the host; it only records
      onLog: (level, text) => logs.push({ level, text }),
    });
    const raw = (await sb.run(code, `${dslPrelude}\nreturn build(api);`, timeoutMs)) as ScriptResult;
    const built = buildFromOps(raw);
    return { ...built, logs, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    if (e instanceof SandboxError) {
      if (e.kind === 'timeout')
        throw new ScriptFailure(
          `The script ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped (infinite loop?)`,
          undefined,
          logs,
        );
      throw new ScriptFailure(e.message, userLineOf(e.stack), logs);
    }
    if (e instanceof ScriptError) throw new ScriptFailure(e.message, undefined, logs);
    throw e;
  } finally {
    sb?.dispose();
  }
}

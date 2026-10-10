import { describe, expect, it } from 'vitest';
import { applyScriptScene } from '../src/scripting/apply';
import dslPrelude from '../src/scripting/dslPrelude.mjs?raw';
import { SCRIPT_EXAMPLES } from '../src/scripting/examples';
import { buildFromOps, ScriptError, type ScriptResult } from '../src/scripting/replay';
import { userLineOf } from '../src/scripting/run';
import { SceneStore } from '../src/model/store';
import { PhysicsWorld } from '../src/physics/world';

/** Runs a script through the REAL prelude (the code that runs in the sandbox worker), minus the sandbox. */
async function record(code: string): Promise<{ result: ScriptResult; logs: string[] }> {
  const logs: string[] = [];
  const consoleShim = {
    log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
    warn: () => undefined,
    error: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  const mode = new Function('api', `"use strict";${dslPrelude}\nreturn build(api);`)({ console: consoleShim }) as {
    scope: Record<string, unknown>;
    finish(): ScriptResult;
  };
  const AsyncFunction = (Object.getPrototypeOf(async function () {}) as { constructor: unknown }).constructor as new (
    ...a: string[]
  ) => (...v: unknown[]) => Promise<void>;
  const names = Object.keys(mode.scope);
  await new AsyncFunction(...names, `"use strict";\n${code}`)(...names.map((n) => mode.scope[n]));
  return { result: mode.finish(), logs };
}

describe('DT-32 scene scripts', () => {
  for (const ex of SCRIPT_EXAMPLES) {
    it(`example "${ex.id}" builds a valid scene that simulates`, async () => {
      const { result } = await record(ex.code);
      const { doc, report } = buildFromOps(result);
      expect(doc.entities.length).toBeGreaterThan(2);
      expect(report.warnings).toEqual([]);
      const w = await PhysicsWorld.create(doc);
      for (let i = 0; i < 30; i++) w.stepOnce();
      expect(w.stats().bodies).toBeGreaterThan(0);
      w.dispose();
    });
  }

  it('is deterministic (seeded random, Math.random replaced)', async () => {
    const code = `array(5, () => body('b', 'box', [1,1,1], [random(), Math.random(), 0]));`;
    const a = buildFromOps((await record(code)).result).doc;
    const b = buildFromOps((await record(code)).result).doc;
    expect(a.entities.map((e) => 'position' in e && e.position)).toEqual(
      b.entities.map((e) => 'position' in e && e.position),
    );
  });

  it('joints resolve their bodies and compute anchors', async () => {
    const { result } = await record(
      `const a = body('A','box',[1,1,1],[0,2,0]); const b = body('B','box',[1,1,1],[0,1,0]); joint('hinge', a, b, [0,1.5,0], [0,0,1]); joint('ball', null, a, [0,3,0]);`,
    );
    const { doc } = buildFromOps(result);
    expect(doc.entities.filter((e) => e.kind === 'joint')).toHaveLength(2);
  });

  it('rejects malformed recordings and unknown calls', () => {
    expect(() => buildFromOps({ ops: [{ f: 'exec', a: [] }] })).toThrow(ScriptError);
    expect(() =>
      buildFromOps({ ops: [{ f: 'joint', a: ['hinge', { __ref: 5 }, null, [0, 0, 0], [0, 0, 1], {}] }] }),
    ).toThrow(/does not exist/);
    expect(() => buildFromOps({ ops: [{ f: 'body', a: ['x', 'box', [1, 1], [0, 0, 0], {}] }] })).toThrow(
      /three numbers/,
    );
    expect(() => buildFromOps({ ops: [], settings: { bogus: 1 } })).toThrow(/Unknown setting/);
    expect(() => buildFromOps(null as never)).toThrow(ScriptError);
  });

  it('limits the number of calls', async () => {
    await expect(record(`for (let i = 0; i < 30000; i++) body('x','box',[1,1,1],[0,0,0]);`)).rejects.toThrow(
      /Too many objects/,
    );
    await expect(record(`array(1e9, () => 0)`)).rejects.toThrow(/array/);
  });

  it('rejects non-plain arguments', async () => {
    await expect(
      record(`body('x','box',[1,1,1],[0,0,0],{ f(){} , c: (()=>{ const o={}; o.o=o; return o; })() })`),
    ).rejects.toThrow(/plain data/);
  });

  it('console.log and print are captured', async () => {
    expect((await record(`console.log('hi', 2); print('there')`)).logs).toEqual(['hi 2', 'there']);
  });

  it('applies as ONE undo step, replace or add', async () => {
    const store = new SceneStore();
    const first = buildFromOps((await record(`body('keep','box',[1,1,1],[0,1,0]); name('First')`)).result).doc;
    applyScriptScene(store, first, 'replace');
    expect(store.all()).toHaveLength(1);
    const second = buildFromOps(
      (
        await record(
          `array(3, (i) => body('n'+i,'box',[1,1,1],[i,1,0])); name('Second'); settings({ gravity: [0,-3,0] })`,
        )
      ).result,
    ).doc;
    applyScriptScene(store, second, 'replace');
    expect(store.all()).toHaveLength(3);
    expect(store.name).toBe('Second');
    expect(store.settings.gravity).toEqual([0, -3, 0]);
    store.undo();
    expect(store.all()).toHaveLength(1);
    expect(store.name).toBe('First');
    applyScriptScene(store, second, 'add');
    expect(store.all()).toHaveLength(4);
    store.undo();
    expect(store.all()).toHaveLength(1);
  });

  it('maps engine stack positions to the user line', () => {
    expect(userLineOf('Error: x\n    at eval (eval at <anonymous> (blob:1:2), <anonymous>:7:3)')).toBe(4);
    expect(userLineOf(undefined)).toBeUndefined();
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BatchError, expandSweeps, parseSweep, runBatch, setParam, toCsv } from '../src/cli/batch';
import { main, parseArgs } from '../src/cli/main';
import { serializeDocument } from '../src/model/serialize';
import { createBody, docOf } from './helpers';

const ball = () => createBody({ name: 'Ball', shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [0, 20, 0] });
const sceneDoc = () => docOf([ball()], { ground: { ...docOf([]).settings.ground, enabled: false } });

describe('DT-33 batch runner', () => {
  it('parses lists and ranges and expands the cartesian product', () => {
    expect(parseSweep('gravity=-1,-9.81')).toEqual({ path: 'gravity', values: [-1, -9.81] });
    expect(parseSweep('a=0:1:3').values).toEqual([0, 0.5, 1]);
    expect(parseSweep('flag=true,false').values).toEqual([true, false]);
    expect(expandSweeps([parseSweep('a=1,2'), parseSweep('b=3,4,5')])).toHaveLength(6);
    expect(expandSweeps([])).toEqual([{}]);
    expect(() => parseSweep('nonsense')).toThrow(BatchError);
    expect(() => expandSweeps([parseSweep('a=0:1:5000'), parseSweep('b=0:1:5000')])).toThrow(/more than/);
  });

  it('free fall matches ½·g·t² under swept gravity', async () => {
    const doc = sceneDoc();
    const hz = doc.settings.physicsHz;
    const runs = await runBatch(doc, { steps: hz, every: hz, sweeps: [parseSweep('gravity=-4,-9.81,-20')] });
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      const g = r.params['gravity'] as number;
      const y = Object.values(r.final.bodies)[0][1];
      // semi-implicit Euler over 1 s: y = y0 + g·t²/2 (+ O(dt) error)
      expect(y).toBeCloseTo(20 + g / 2, 0);
      expect(Math.abs(y - (20 + g / 2))).toBeLessThan(0.15);
    }
  });

  it('is deterministic: same document and seed give identical output', async () => {
    const doc = sceneDoc();
    const a = await runBatch(doc, { steps: 90, every: 30, seed: 7 });
    const b = await runBatch(doc, { steps: 90, every: 30, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a[0].seed).toBe(7);
  });

  it('sweeps entity fields without touching the source document', async () => {
    const doc = sceneDoc();
    const before = JSON.stringify(doc);
    const runs = await runBatch(doc, { steps: 30, every: 30, sweeps: [parseSweep('Ball.position.1=5,10')] });
    expect(JSON.stringify(doc)).toBe(before);
    const ys = runs.map((r) => Object.values(r.final.bodies)[0][1]);
    expect(ys[1] - ys[0]).toBeCloseTo(5, 3);
  });

  it('rejects bad parameters with a clear error', () => {
    const doc = sceneDoc();
    expect(() => setParam(doc, 'Nobody.mass', 1)).toThrow(/No entity/);
    expect(() => setParam(doc, 'Ball.nosuchfield', 1)).toThrow(/unknown field/);
    expect(() => setParam(doc, 'Ball.__proto__.x', 1)).toThrow(/Invalid parameter/);
    expect(() => setParam(doc, 'gravity', 'high')).toThrow(/gravity/);
  });

  it('CSV has a header and one row per tracked body, sample and run', async () => {
    const doc = sceneDoc();
    const runs = await runBatch(doc, { steps: 20, every: 10, sweeps: [parseSweep('gravity=-1,-2')] });
    const lines = toCsv(doc, runs, false).trim().split('\n');
    expect(lines[0]).toContain('run,gravity,seed,step,time,body,x,y,z');
    expect(lines).toHaveLength(1 + 2 * 3);
    expect(toCsv(doc, runs, true).trim().split('\n')).toHaveLength(1 + 2);
  });

  it('main() returns the documented exit codes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'plcli-'));
    const file = path.join(dir, 'scene.json');
    writeFileSync(file, serializeDocument(sceneDoc()));
    const sink = { out: () => undefined, err: () => undefined };
    const outFile = path.join(dir, 'r.csv');
    expect(await main(['run', file, '--steps', '20', '--out', outFile, '--quiet'], sink)).toBe(0);
    expect(readFileSync(outFile, 'utf8').split('\n')[0]).toMatch(/^run,/);
    const jsonFile = path.join(dir, 'r.json');
    expect(await main(['run', file, '--steps', '20', '--out', jsonFile, '--quiet'], sink)).toBe(0);
    expect((JSON.parse(readFileSync(jsonFile, 'utf8')) as { runs: unknown[] }).runs).toHaveLength(1);
    expect(await main(['run'], sink)).toBe(2);
    expect(await main(['run', file, '--bogus'], sink)).toBe(2);
    expect(await main(['run', path.join(dir, 'missing.json')], sink)).toBe(3);
    expect(await main(['run', file, '--sweep', 'Nobody.x=1'], sink)).toBe(2);
    expect(await main(['--help'], sink)).toBe(0);
    expect(parseArgs(['run', 'a.json', '--steps', '5'])).toMatchObject({ scene: 'a.json', steps: 5 });
  });

  it('the real launcher (`npm run cli`) runs end to end', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'plcli-'));
    const file = path.join(dir, 'scene.json');
    writeFileSync(file, serializeDocument(sceneDoc()));
    const r = spawnSync(
      process.execPath,
      ['scripts/cli.mjs', 'run', file, '--steps', '30', '--every', '30', '--final', '--quiet'],
      {
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(2);
    const bad = spawnSync(process.execPath, ['scripts/cli.mjs', 'run', path.join(dir, 'nope.json')], {
      encoding: 'utf8',
    });
    expect(bad.status).toBe(3);
  }, 90_000);
});

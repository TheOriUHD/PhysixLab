/** Diagnostics without a DOM: the profiler's ring buffers, capability checks on a fake environment, the error gate and log, report text. */
import { describe, expect, it } from 'vitest';
import { PHYSICS, RENDER, SCENE, SECTION_COUNT, UI, Profiler } from '../src/core/profiler';
import { checkCapabilities, probeEnvironment, type CapEnv } from '../src/ui/diag/capabilities';
import { ErrorGate, ErrorLog, describeError, isIgnorableError } from '../src/ui/diag/errorLog';
import { resetPreferences } from '../src/ui/diag/errorCard';
import { browserName, diagSections, formatReport, type ReportInput } from '../src/ui/diag/report';
import { cheatSections, filterCheat } from '../src/ui/help/cheatLogic';
import type { CommandDef } from '../src/app/registry/commands';

/** A manual clock. */
const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('profiler', () => {
  it('credits the time between marks to sections and rolls over the ring', () => {
    const c = clock();
    const p = new Profiler(4, c.now);
    for (let f = 0; f < 6; f++) {
      p.begin();
      c.advance(1);
      p.mark(PHYSICS);
      c.advance(2);
      p.mark(SCENE);
      c.advance(f + 3);
      p.mark(RENDER);
      p.end();
      c.advance(4); // idle until the next frame
    }
    expect(p.frames).toBe(6);
    expect(p.count).toBe(4); // bounded
    expect(p.stats(PHYSICS)).toEqual({ avg: 1, max: 1, last: 1 });
    expect(p.stats(SCENE).avg).toBe(2);
    // render = 3, 4, 5, 6, 7, 8 -> the last four are 5, 6, 7, 8
    expect(p.stats(RENDER)).toEqual({ avg: 6.5, max: 8, last: 8 });
    expect(p.stats(UI).max).toBe(0);
    // intervals: frame n lasts (1+2+n+3)+4
    const iv = p.intervalStats();
    expect(iv.last).toBe(14); // the previous frame took 1 + 2 + 7 ms, then 4 ms idle
    expect(iv.avg).toBeGreaterThan(0);
  });

  it('newest-first indexing wraps correctly', () => {
    const c = clock();
    const p = new Profiler(3, c.now);
    for (let f = 1; f <= 5; f++) {
      p.begin();
      c.advance(f);
      p.mark(UI);
      p.end();
    }
    const seen = [0, 1, 2].map((i) => p.rings[UI][p.indexOfRecent(i)]);
    expect(seen).toEqual([5, 4, 3]);
  });

  it('does nothing while disabled, ignores marks outside a frame, and resets', () => {
    const c = clock();
    const p = new Profiler(8, c.now);
    p.mark(PHYSICS); // no frame open
    p.enabled = false;
    p.begin();
    p.end();
    expect(p.frames).toBe(0);
    p.enabled = true;
    p.begin();
    c.advance(2);
    p.mark(PHYSICS);
    p.end();
    expect(p.stats(PHYSICS).last).toBe(2);
    p.reset();
    expect(p.count).toBe(0);
    expect(p.stats(PHYSICS)).toEqual({ avg: 0, max: 0, last: 0 });
  });

  it('allocates nothing per frame (the rings are fixed typed arrays)', () => {
    const p = new Profiler(16);
    const before = p.rings.map((r) => r.buffer);
    for (let i = 0; i < 100; i++) {
      p.begin();
      p.mark(PHYSICS);
      p.end();
    }
    expect(p.rings.map((r) => r.buffer)).toEqual(before);
    expect(p.rings.length).toBe(SECTION_COUNT);
    expect(p.rings.every((r) => r instanceof Float64Array)).toBe(true);
  });
});

const goodEnv: CapEnv = {
  webgl2: true,
  webAssembly: true,
  worker: true,
  moduleWorker: true,
  localStorage: true,
  indexedDB: true,
  offscreenCanvas: false,
};

describe('capability checks', () => {
  it('passes a capable browser and does not require OffscreenCanvas', () => {
    const r = checkCapabilities(goodEnv);
    expect(r.fatal).toBe(false);
    expect(r.degraded).toBe(false);
    expect(r.items.find((i) => i.id === 'offscreenCanvas')!.status).toBe('ok');
  });

  it('missing WebGL 2 is fatal and explained in plain words', () => {
    const r = checkCapabilities({ ...goodEnv, webgl2: false });
    expect(r.fatal).toBe(true);
    expect(r.headline).toMatch(/WebGL 2/);
    const item = r.items.find((i) => i.id === 'webgl2')!;
    expect(item.status).toBe('fail');
    expect(item.guidance).toMatch(/hardware acceleration/i);
    expect(item.guidance).not.toMatch(/Error:|at \w+\.ts/);
  });

  it('each essential feature is fatal, storage problems only degrade', () => {
    for (const k of ['webAssembly', 'worker'] as const)
      expect(checkCapabilities({ ...goodEnv, [k]: false }).fatal, k).toBe(true);
    expect(checkCapabilities({ ...goodEnv, moduleWorker: false }).fatal).toBe(true);
    const noStore = checkCapabilities({ ...goodEnv, localStorage: false, indexedDB: false });
    expect(noStore.fatal).toBe(false);
    expect(noStore.degraded).toBe(true);
    expect(noStore.items.filter((i) => i.status === 'warn').length).toBe(2);
    expect(noStore.items.find((i) => i.id === 'indexedDB')!.guidance).toMatch(/export/i);
  });

  it('an unknown module-worker answer does not block the app', () => {
    expect(checkCapabilities({ ...goodEnv, moduleWorker: null }).fatal).toBe(false);
  });

  it('probes a fake environment', () => {
    class FakeWorker {
      constructor(_u: string, o?: { type?: string }) {
        void o?.type; // a module-aware browser reads it
      }
      terminate() {}
    }
    const storage = { setItem() {}, removeItem() {} };
    const env = probeEnvironment(
      { Worker: FakeWorker, WebAssembly: {}, localStorage: storage, indexedDB: {}, OffscreenCanvas: function () {} },
      () => ({ getContext: (id: string) => (id === 'webgl2' ? {} : null) }),
    );
    expect(env).toEqual({
      webgl2: true,
      webAssembly: true,
      worker: true,
      moduleWorker: true,
      localStorage: true,
      indexedDB: true,
      offscreenCanvas: true,
    });
    const bad = probeEnvironment(
      {
        localStorage: {
          setItem() {
            throw new Error('denied');
          },
          removeItem() {},
        },
      },
      () => ({ getContext: () => null }),
    );
    expect(bad).toMatchObject({
      webgl2: false,
      webAssembly: false,
      worker: false,
      moduleWorker: false,
      localStorage: false,
    });
  });
});

describe('error log and gate', () => {
  it('keeps only the last N errors and counts all', () => {
    const log = new ErrorLog(3);
    for (let i = 0; i < 5; i++) log.push({ t: i, kind: 'error', message: `e${i}` });
    expect(log.recent().map((e) => e.message)).toEqual(['e2', 'e3', 'e4']);
    expect(log.recent(2).map((e) => e.message)).toEqual(['e3', 'e4']);
    expect(log.total).toBe(5);
  });

  it('collapses a loop of identical errors into one counted entry', () => {
    const log = new ErrorLog(5);
    for (let i = 0; i < 100; i++) log.push({ t: i, kind: 'error', message: 'same', source: 'a.ts:1:1' });
    log.push({ t: 100, kind: 'error', message: 'other' });
    expect(log.recent().map((e) => [e.message, e.count])).toEqual([
      ['same', 100],
      ['other', undefined],
    ]);
    expect(log.total).toBe(101);
  });

  it('describes anything that can be thrown', () => {
    expect(describeError(new Error('boom')).message).toBe('boom');
    expect(describeError('text').message).toBe('text');
    expect(describeError({ message: 'obj' }).message).toBe('obj');
    expect(describeError({ a: 1 }).message).toBe('{"a":1}');
    expect(describeError(undefined).message).toBe('undefined');
    expect(isIgnorableError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isIgnorableError('x', 'chrome-extension://abc/content.js:1:1')).toBe(true);
    expect(isIgnorableError('real bug', 'http://localhost/src/a.ts:1:1')).toBe(false);
  });

  it('an error loop shows one card, then counts, then at most one toast per cooldown', () => {
    const g = new ErrorGate();
    expect(g.report(0)).toBe('card');
    for (let t = 16; t < 1000; t += 16) expect(g.report(t)).toBe('count'); // 60 errors/s while the card is open
    expect(g.suppressed).toBeGreaterThan(50);
    expect(g.looping(1000)).toBe(true);
    g.closed(1000);
    // dismissed: a new error 1 s later is not a new card
    expect(g.report(2000)).toBe('toast');
    expect(g.report(2016)).toBe('quiet');
    expect(g.report(4000)).toBe('quiet');
    expect(g.report(7100)).toBe('toast');
    // after the card cooldown a card may come back
    expect(g.report(17000)).toBe('card');
  });

  it('isolated errors are not an error loop', () => {
    const g = new ErrorGate();
    g.report(0);
    g.closed(10);
    g.report(20000);
    expect(g.looping(20001)).toBe(false);
  });
});

describe('reset preferences', () => {
  it('removes layout and preference keys but never scene data', () => {
    const data = new Map([
      ['physicslab:prefs:v1', '{}'],
      ['physicslab:layout:v1', '{}'],
      ['physicslab.cheat.unbound', '1'],
      ['physicslab:autosave:v1', 'scene'],
      ['physicslab:library:v1', 'scenes'],
      ['other:thing', 'x'],
    ]);
    const store = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      removeItem: (k: string) => void data.delete(k),
    };
    const removed = resetPreferences(store);
    expect(removed.sort()).toEqual(['physicslab.cheat.unbound', 'physicslab:layout:v1', 'physicslab:prefs:v1']);
    expect([...data.keys()].sort()).toEqual(['other:thing', 'physicslab:autosave:v1', 'physicslab:library:v1']);
  });
});

const report = (over: Partial<ReportInput> = {}): ReportInput => ({
  app: { name: 'PhysicsLab', version: '1.2.3', mode: 'production' },
  time: '2026-01-01T00:00:00.000Z',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  platform: 'Linux x86_64',
  language: 'en-US',
  cores: 8,
  deviceMemoryGB: 8,
  screen: { width: 1920, height: 1080, dpr: 1 },
  viewport: { width: 1600, height: 900 },
  online: true,
  gpu: {
    version: 'WebGL 2.0',
    shadingLanguage: 'WebGL GLSL ES 3.00',
    vendor: 'WebKit',
    renderer: 'WebKit WebGL',
    unmaskedVendor: 'NVIDIA',
    unmaskedRenderer: 'NVIDIA GeForce RTX',
    limits: { 'Max texture size': 16384 },
  },
  caps: checkCapabilities(goodEnv),
  worker: {
    active: true,
    protocol: 2,
    expectedProtocol: 2,
    frameNo: 120,
    simTime: 2,
    stepMs: 0.4,
    roundTripMs: 2.1,
    applyMs: 0.2,
    bodies: 31,
    awake: 12,
    contacts: 5,
    particles: 0,
    lastError: null,
  },
  memory: { usedMB: 50, totalMB: 80, limitMB: 4096 },
  scene: { name: 'Car', entities: 40, bodies: 31, joints: 9, selected: 0, mode: 'running' },
  timings: {
    fps: 60,
    intervalAvg: 16.7,
    intervalMax: 20,
    sections: [{ key: 'render', label: 'Render', avg: 3, max: 6 }],
  },
  errors: [
    { t: 1234.5, kind: 'error', message: 'boom', stack: 'Error: boom\n    at a (a.ts:1:1)', source: 'a.ts:1:1' },
  ],
  ...over,
});

describe('diagnostics report', () => {
  it('names the browser', () => {
    expect(browserName(report().userAgent)).toBe('Chrome/Chromium 124.0.0.0');
    expect(browserName('Mozilla/5.0 Firefox/125.0')).toBe('Firefox 125.0');
    expect(browserName('')).toBe('unknown');
  });

  it('copy text is valid JSON with version, UA, GPU, limits, worker, errors and scene', () => {
    const text = formatReport(report());
    const j = JSON.parse(text) as {
      app: { version: string };
      browser: { userAgent: string };
      gpu: { unmaskedRenderer: string; limits: Record<string, number> };
      worker: { protocol: number };
      recentErrors: { message: string }[];
      scene: { bodies: number };
      capabilities: unknown[];
    };
    expect(j.app.version).toBe('1.2.3');
    expect(j.browser.userAgent).toMatch(/Chrome\/124/);
    expect(j.gpu.unmaskedRenderer).toBe('NVIDIA GeForce RTX');
    expect(j.gpu.limits['Max texture size']).toBe(16384);
    expect(j.worker.protocol).toBe(2);
    expect(j.recentErrors[0].message).toBe('boom');
    expect(j.scene.bodies).toBe(31);
    expect(j.capabilities.length).toBeGreaterThan(5);
  });

  it('panel rows flag problems: software rendering, protocol mismatch, worker error', () => {
    const rows = (r: ReportInput) => diagSections(r).flatMap((s) => s.rows);
    expect(rows(report()).some((r) => r.tone === 'bad' || r.tone === 'warn')).toBe(false);
    const soft = report({
      gpu: { ...report().gpu!, unmaskedRenderer: 'Google SwiftShader' },
    });
    expect(rows(soft).some((r) => r.tone === 'warn' && /software/i.test(r.value))).toBe(true);
    const bad = report({ worker: { ...report().worker!, protocol: 1, lastError: 'worker died' } });
    expect(rows(bad).filter((r) => r.tone === 'bad').length).toBe(3);
    const none = report({ gpu: null, memory: null, worker: null, scene: null, timings: null });
    expect(rows(none).some((r) => r.label === 'WebGL' && r.tone === 'bad')).toBe(true);
    expect(rows(none).some((r) => /not reported/.test(r.value))).toBe(true);
  });
});

describe('cheat-sheet data', () => {
  const run = () => undefined;
  const commands: CommandDef[] = [
    { id: 'edit.undo', label: 'Undo', category: 'Edit', shortcut: 'Mod+Z', keywords: ['revert'], run },
    { id: 'edit.redo', label: 'Redo', category: 'Edit', shortcut: ['Mod+Shift+Z', 'Mod+Y'], run },
    { id: 'file.export', label: 'Export scene file…', category: 'File', run },
    { id: 'hidden.cmd', label: 'Hidden', category: 'Edit', shortcut: 'H', help: false, run },
    { id: 'sim.toggle', label: 'Start / pause', category: 'Simulation', shortcut: 'Space', run },
  ];
  const entries = [{ id: 'gesture.zoom', group: 'Camera', label: 'Zoom', keys: 'Scroll', order: 0 }];

  it('lists commands with shortcuts and gestures, grouped in category order, platform aware', () => {
    const pc = cheatSections({ platform: 'pc', commands, entries });
    expect(pc.map((s) => s.title)).toEqual(['Simulation', 'Edit', 'Camera']);
    const undo = pc[1].rows.find((r) => r.label === 'Undo')!;
    expect(undo.alternatives).toEqual([['Ctrl', 'Z']]);
    expect(pc[1].rows.find((r) => r.label === 'Redo')!.alternatives.length).toBe(2);
    expect(pc[1].rows.some((r) => r.label === 'Hidden')).toBe(false);
    const mac = cheatSections({ platform: 'mac', commands, entries });
    expect(mac[1].rows.find((r) => r.label === 'Undo')!.alternatives[0]).not.toContain('Ctrl');
  });

  it('commands without a shortcut appear only behind the toggle', () => {
    expect(
      cheatSections({ platform: 'pc', commands, entries })
        .flatMap((s) => s.rows)
        .some((r) => r.label.startsWith('Export')),
    ).toBe(false);
    const all = cheatSections({ platform: 'pc', commands, entries, includeUnbound: true });
    const exp = all.find((s) => s.title === 'File')!.rows[0];
    expect(exp.alternatives).toEqual([]);
    expect(exp.commandId).toBe('file.export');
  });

  it('filters by every word across label, category, keywords and keys', () => {
    const s = cheatSections({ platform: 'pc', commands, entries, includeUnbound: true });
    expect(filterCheat(s, 'undo').flatMap((x) => x.rows.map((r) => r.label))).toEqual(['Undo']);
    expect(filterCheat(s, 'revert').flatMap((x) => x.rows.map((r) => r.label))).toEqual(['Undo']);
    expect(filterCheat(s, 'edit ctrl').flatMap((x) => x.rows.map((r) => r.label))).toEqual(['Undo', 'Redo']);
    expect(filterCheat(s, 'scroll')[0].title).toBe('Camera');
    expect(filterCheat(s, 'zzz')).toEqual([]);
    expect(filterCheat(s, '  ').length).toBe(s.length);
  });
});

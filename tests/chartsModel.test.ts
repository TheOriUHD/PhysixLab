import { describe, expect, it } from 'vitest';
import { ChartModel, defaultChart, sanitizeChart } from '../src/ui/charts/model';
import type { ChartCfg, TraceCfg } from '../src/ui/charts/model';
import type { SignalSource } from '../src/ui/charts/signals';
import { loadPersisted } from '../src/ui/charts/panel';
import { B } from '../src/physics/protocol';

/** One falling body "ball" with a settable velocity; a selection that can change. */
function fake() {
  const pose = new Float32Array(18);
  let t = 0;
  let selected: string | null = 'ball';
  const src: SignalSource = {
    time: () => t,
    gravity: () => [0, -9.81, 0],
    pose: (id) => (id === 'ball' || id === 'id1' ? pose : null),
    joint: () => null,
    mass: () => 2,
    com: () => null,
    gravityScale: () => 1,
    world: () => null,
    resolve: (ref, kind) => (kind !== 'body' ? null : ref === 'selected' ? selected : ref === 'ball' ? 'ball' : null),
  };
  return {
    src,
    pose,
    get time() {
      return t;
    },
    set time(v: number) {
      t = v;
    },
    set selected(v: string | null) {
      selected = v;
    },
  };
}

const tr = (id: string, expr: string, extra: Partial<TraceCfg> = {}): TraceCfg => ({
  id,
  label: '',
  expr,
  color: '#3ddcff',
  unit: '',
  axis: 'L',
  visible: true,
  ...extra,
});

describe('ChartModel', () => {
  it('samples traces, derived traces and expressions into aligned channels', () => {
    const f = fake();
    const cfg: ChartCfg = {
      ...defaultChart('t'),
      traces: [
        tr('a', 'vel_y(ball)'),
        tr('b', '', { derived: { op: 'derivative', of: 'a' } }),
        tr('c', '', { derived: { op: 'integral', of: 'a' } }),
        tr('d', '0.5*mass(ball)*speed(ball)^2'),
      ],
    };
    const m = new ChartModel(cfg);
    m.bind(f.src);
    for (let i = 0; i <= 60; i++) {
      f.time = i / 60;
      f.pose[B.vy] = -9.81 * f.time;
      expect(m.sample(f.time)).toBe(true);
    }
    const d = m.data;
    const last = d.length - 1;
    expect(d.valueAt(0, last)).toBeCloseTo(-9.81, 4);
    expect(d.valueAt(1, last)).toBeCloseTo(-9.81, 3); // derivative of -g t
    expect(d.valueAt(2, last)).toBeCloseTo(-0.5 * 9.81, 3); // integral
    expect(d.valueAt(3, last)).toBeCloseTo(9.81 ** 2, 3); // m/2 v² with m = 2
    expect(m.unitOf(0)).toBe('m/s');
    expect(m.unitOf(1)).toBe('m/s/s');
    expect(m.unitOf(2)).toBe('m/s·s');
    expect(m.unitOf(3)).toBe('');
    expect(m.nameOf(1)).toBe('vel_y(ball) d/dt');
  });

  it('keeps going after an invalid expression and records NaN for it', () => {
    const f = fake();
    const m = new ChartModel({ ...defaultChart('t'), traces: [tr('a', 'speed(nobody)'), tr('b', 'speed(ball)')] });
    m.bind(f.src);
    expect(m.traces[0].error).toMatch(/No body called "nobody"/);
    f.pose[B.vx] = 3;
    m.sample(0.5);
    expect(Number.isNaN(m.data.valueAt(0, 0))).toBe(true);
    expect(m.data.valueAt(1, 0)).toBe(3);
  });

  it('follows the selection: traces on `selected` recompile when it changes', () => {
    const f = fake();
    const m = new ChartModel({ ...defaultChart('t'), traces: [tr('a', 'speed(selected)'), tr('b', 'speed(ball)')] });
    f.selected = null;
    m.bind(f.src);
    expect(m.traces[0].error).toMatch(/nothing suitable is selected/);
    expect(m.traces[0].usesSelected).toBe(false); // failed compiles are retried
    f.selected = 'ball';
    expect(m.rebindSelected()).toBe(true);
    expect(m.traces[0].error).toBe('');
    expect(m.traces[0].usesSelected).toBe(true);
    f.pose[B.vz] = 2;
    m.sample(1);
    expect(m.data.valueAt(0, 0)).toBe(2);
  });

  it('adding and removing traces keeps the channels of the others', () => {
    const f = fake();
    const cfg: ChartCfg = { ...defaultChart('t'), traces: [tr('a', 'pos_x(ball)')] };
    const m = new ChartModel(cfg);
    m.bind(f.src);
    f.pose[B.px] = 1;
    m.sample(0);
    cfg.traces.push(tr('b', 'pos_y(ball)'), tr('c', 'pos_z(ball)'));
    m.bind(f.src);
    f.pose[B.py] = 2;
    f.pose[B.pz] = 3;
    m.sample(1);
    expect(m.data.valueAt(0, 1)).toBe(1);
    expect(m.data.valueAt(1, 1)).toBe(2);
    expect(m.data.valueAt(2, 1)).toBe(3);
    expect(Number.isNaN(m.data.valueAt(1, 0))).toBe(true); // a trace added later has no history
    cfg.traces.splice(1, 1); // remove b
    m.bind(f.src);
    f.pose[B.pz] = 4;
    m.sample(2);
    expect(m.traces.map((t) => t.cfg.id)).toEqual(['a', 'c']);
    expect(m.data.valueAt(m.traces[1].channel, 2)).toBe(4);
    expect(m.data.valueAt(m.traces[0].channel, 1)).toBe(1);
  });

  it('rebinding (spawned debris, added traces) keeps the running state of derived traces', () => {
    const f = fake();
    const cfg: ChartCfg = {
      ...defaultChart('t'),
      traces: [tr('a', 'vel_y(ball)'), tr('b', '', { derived: { op: 'integral', of: 'a' } })],
    };
    const m = new ChartModel(cfg);
    m.bind(f.src);
    for (let i = 0; i <= 30; i++) {
      f.time = i / 60;
      f.pose[B.vy] = -1;
      m.sample(f.time);
    }
    const before = m.data.valueAt(1, m.data.length - 1);
    expect(before).toBeCloseTo(-0.5, 3);
    cfg.traces.push(tr('c', 'speed(ball)'));
    m.bind(f.src); // a trace was added
    m.bind(f.src); // and a plain rebind
    f.time = 31 / 60;
    m.sample(f.time);
    expect(m.data.valueAt(1, m.data.length - 1)).toBeCloseTo(-31 / 60, 3);
  });

  it('a clock that goes backwards starts a new recording; record length bounds the memory', () => {
    const f = fake();
    const cfg = { ...defaultChart('t'), recordLen: 5, sampleHz: 10, traces: [tr('a', 't')] };
    const m = new ChartModel(cfg);
    m.bind(f.src);
    for (let i = 0; i < 200; i++) {
      f.time = i / 10;
      m.sample(f.time);
    }
    expect(m.data.length).toBe(50); // 5 s x 10 Hz
    expect(m.data.firstTime).toBeCloseTo(15, 5);
    m.sample(0.2);
    expect(m.data.length).toBe(1);
    cfg.recordLen = 10;
    m.applyRecording();
    expect(m.data.cap).toBe(100);
  });
});

describe('chart configuration sanitising', () => {
  it('survives garbage and clamps values', () => {
    expect(sanitizeChart(null)).toBeNull();
    expect(sanitizeChart('x')).toBeNull();
    const c = sanitizeChart({
      id: 'x',
      title: 5,
      mode: 'nope',
      span: -4,
      recordLen: 1e9,
      sampleHz: 0,
      w: 1,
      h: 99999,
      traces: [
        { id: 't1', expr: 'speed(a)', color: 'red', axis: 'Q' },
        { id: 't1', expr: 'dup' },
        { id: 't2', expr: '', derived: { op: 'rms', of: 't1' } },
        { id: 't3', expr: '', derived: { op: 'rms', of: 'missing' } },
        { id: 't4' },
        42,
      ],
      xy: { x: 't1', y: 'zzz' },
      markers: [{ t: 1, text: 'ok' }, { t: 'x' }, null],
    })!;
    expect(c.title).toBe('Chart');
    expect(c.mode).toBe('time');
    expect(c.span).toBe(0.5);
    expect(c.recordLen).toBe(3600);
    expect(c.sampleHz).toBe(5);
    expect(c.w).toBe(240);
    expect(c.h).toBe(900);
    expect(c.traces.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(c.traces[0].axis).toBe('L');
    expect(c.traces[0].color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(c.traces[1].derived).toEqual({ op: 'rms', of: 't1' });
    expect(c.xy).toEqual({ x: 't1', y: '' });
    expect(c.markers).toEqual([{ t: 1, text: 'ok' }]);
  });

  it('round-trips through JSON and tolerates corrupt storage', () => {
    const cfg: ChartCfg = { ...defaultChart('Mine'), traces: [tr('a', 'speed(x)')], mode: 'spectrum' };
    cfg.spectrum.trace = 'a';
    cfg.spectrum.window = 'hamming';
    const back = loadPersisted(JSON.stringify({ v: 1, charts: [cfg], aliases: { a: 'id1', 'bad name': 'x', b: 7 } }));
    expect(back.charts).toHaveLength(1);
    expect(back.charts[0]).toEqual(cfg);
    expect(back.aliases).toEqual({ a: 'id1' });
    expect(loadPersisted('{not json').charts).toEqual([]);
    expect(loadPersisted(null).charts).toEqual([]);
    expect(loadPersisted('[1,2]').charts).toEqual([]);
  });
});

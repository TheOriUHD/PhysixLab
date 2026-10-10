/**
 * The audio engine's own logic (FX-10, FX-14), run in Node against a fake WebAudio context: nothing is created before a
 * gesture, a disabled engine never creates anything, mute silences and suspends, the voice pool limits and steals, a
 * request whose buffer is not ready waits for the next frame, the buffer cache is bounded, the time scale and the
 * spatial state reach the playback rate and the pan. (The real WebAudio graphs are rendered and measured in the browser
 * by `e2e/tests/audio.mjs`.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio/engine';
import { registerSoundEvent, type SoundEventDef } from '../src/audio/events';
import type { LoopVoice } from '../src/audio/loops';
import { DEFAULT_AUDIO_SETTINGS, patchAudioSettings, type AudioSettings } from '../src/audio/settings';

// -- a minimal fake of the WebAudio objects the engine uses ---------------------------------------------------------------------

class FakeParam {
  events: string[] = [];
  constructor(public value = 0) {}
  setValueAtTime(v: number): this {
    this.value = v;
    this.events.push(`set ${v}`);
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v; // the approach is not simulated: the target is what matters
    this.events.push(`target ${v}`);
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class FakeNode {
  connections: FakeNode[] = [];
  connect(n: FakeNode): FakeNode {
    this.connections.push(n);
    return n;
  }
  disconnect(): void {
    this.connections = [];
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}
class FakeBiquad extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
}
class FakePanner extends FakeNode {
  pan = new FakeParam(0);
}
class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  getFloatTimeDomainData(a: Float32Array): void {
    a.fill(0.25);
  }
}
class FakeBuffer {
  data: Float32Array;
  numberOfChannels = 1;
  constructor(
    public length: number,
    public sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  copyToChannel(d: Float32Array): void {
    this.data.set(d);
  }
}
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  playbackRate = new FakeParam(1);
  loop = false;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  sampleRate = 44100;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  buffers: FakeBuffer[] = [];
  suspends = 0;
  resumes = 0;
  private listeners: (() => void)[] = [];
  addEventListener(_t: string, fn: () => void): void {
    this.listeners.push(fn);
  }
  private set(s: FakeContext['state']): void {
    this.state = s;
    for (const fn of this.listeners) fn();
  }
  resume(): Promise<void> {
    this.resumes++;
    this.set('running');
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspends++;
    this.set('suspended');
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.set('closed');
    return Promise.resolve();
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad();
  }
  createStereoPanner(): FakePanner {
    return new FakePanner();
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
  createBuffer(_ch: number, len: number, sr: number): FakeBuffer {
    const b = new FakeBuffer(len, sr);
    this.buffers.push(b);
    return b;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

class FakeTarget {
  handlers = new Map<string, () => void>();
  addEventListener(type: string, fn: () => void): void {
    this.handlers.set(type, fn);
  }
  removeEventListener(type: string): void {
    this.handlers.delete(type);
  }
  fire(type: string): void {
    this.handlers.get(type)?.();
  }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

let ctx: FakeContext;
let created: number;
const makeEngine = (settings: AudioSettings = DEFAULT_AUDIO_SETTINGS) => {
  const engine = new AudioEngine({
    createContext: () => {
      created++;
      return ctx as unknown as AudioContext;
    },
  });
  engine.configure(settings);
  return engine;
};
/** An engine whose context is up and running. */
const running = (settings?: AudioSettings) => {
  const engine = makeEngine(settings);
  engine.unlock();
  expect(engine.state).toBe('running');
  engine.setListener(IDENTITY, 1 / 60);
  return engine;
};

beforeEach(() => {
  ctx = new FakeContext();
  created = 0;
});
afterEach(() => vi.useRealTimers());

describe('lazy start (FX-10)', () => {
  it('creates no context until a user gesture, and only one after it', () => {
    const engine = makeEngine();
    expect(created).toBe(0);
    expect(engine.state).toBe('idle');
    expect(engine.playEvent('ui.select', null)).toBe(false); // nothing is queued for later
    const target = new FakeTarget();
    engine.arm(target as unknown as Window);
    expect(created).toBe(0);
    target.fire('pointerdown');
    expect(created).toBe(1);
    expect(engine.state).toBe('running');
    expect(target.handlers.size).toBe(0); // the listeners are gone once it runs
    engine.unlock();
    expect(created).toBe(1);
  });

  it('a disabled engine never creates a context, even on a gesture; enabling it from a click does', () => {
    const engine = makeEngine(patchAudioSettings(DEFAULT_AUDIO_SETTINGS, { enabled: false }));
    const target = new FakeTarget();
    engine.arm(target as unknown as Window);
    target.fire('pointerdown');
    target.fire('keydown');
    expect(created).toBe(0);
    expect(engine.state).toBe('idle');
    // The click on the switch: the gesture handler runs first (nothing to do yet), then the setting changes.
    engine.configure(DEFAULT_AUDIO_SETTINGS);
    expect(created).toBe(1);
    expect(engine.state).toBe('running');
  });

  it('builds master → limiter → destination with a bus per category, and starts the clock at the volumes', () => {
    const engine = running();
    expect(engine.audible).toBe(true);
    expect(engine.volumeOf('impacts')).toBeCloseTo(0.8 * 0.8 * 1 * 1, 6); // master² × category²
    expect(engine.volumeOf('ambience')).toBeCloseTo(0.64 * 0.25, 6);
    expect(ctx.destination.connections).toEqual([]); // the destination is the end of the chain
    expect(ctx.gains.length).toBeGreaterThanOrEqual(6); // master + five buses
  });
});

describe('mute and the master switch', () => {
  it('muting silences every voice at once, refuses new ones, then suspends the idle context', () => {
    vi.useFakeTimers();
    const engine = running();
    expect(engine.playEvent('launch', [0, 0, -4], { level: 0.6 })).toBe(true);
    expect(engine.stats.voices).toBe(1);
    engine.configure(patchAudioSettings(engine.settings, { muted: true }));
    expect(engine.stats.voices).toBe(0);
    expect(engine.audible).toBe(false);
    expect(engine.playEvent('launch', [0, 0, -4])).toBe(false);
    expect(engine.volumeOf('impacts')).toBe(0);
    expect(ctx.suspends).toBe(0); // the fade to silence finishes first
    vi.advanceTimersByTime(300);
    expect(ctx.suspends).toBe(1);
    expect(engine.state).toBe('suspended');
    // Unmuting resumes the same context.
    engine.configure(patchAudioSettings(engine.settings, { muted: false }));
    expect(ctx.resumes).toBeGreaterThanOrEqual(2);
    expect(engine.state).toBe('running');
    expect(created).toBe(1);
    expect(engine.playEvent('launch', [0, 0, -4])).toBe(true);
  });

  it('interface sounds can be switched off on their own', () => {
    const engine = running();
    expect(engine.playEvent('ui.select', null)).toBe(true);
    engine.configure(patchAudioSettings(engine.settings, { uiSounds: false }));
    expect(engine.playEvent('ui.select', null)).toBe(false);
    expect(engine.playEvent('launch', null)).toBe(true); // the rest is unaffected
  });

  it('category volumes move the buses', () => {
    const engine = running();
    engine.configure(patchAudioSettings(engine.settings, { master: 0.5, volume: { impacts: 0 } }));
    expect(engine.volumeOf('impacts')).toBe(0);
    expect(engine.volumeOf('ui')).toBeCloseTo(0.25 * 0.36, 6);
    // A sound in a category set to zero is not even started.
    expect(engine.playEvent('launch', null)).toBe(false);
    expect(engine.playEvent('ui.error', null)).toBe(true);
  });
});

describe('voice limiting and priority (FX-10)', () => {
  it('keeps a category within its budget; quieter newcomers are turned away, louder ones steal', () => {
    const engine = running();
    // Distinct sounds at distinct distances: the nearer, the louder.
    let started = 0;
    for (let i = 0; i < 40; i++) {
      engine.beginFrame();
      if (engine.playEvent('launch', [0, 0, -4 - 4 * i], { level: 0.6 })) started++;
    }
    // The first 24 fill the category; the later (farther, quieter) ones are rejected.
    expect(engine.stats.byCategory.impacts).toBeLessThanOrEqual(24);
    expect(engine.stats.rejected).toBeGreaterThan(0);
    expect(started).toBeLessThan(40);
    const before = engine.stats.stolen;
    // A loud close one steals the quietest.
    engine.beginFrame();
    expect(engine.playEvent('explosion', [0, 0, -3], { size: 7, level: 1 })).toBe(true);
    expect(engine.stats.stolen).toBeGreaterThan(before);
    expect(engine.stats.byCategory.impacts).toBeLessThanOrEqual(24);
    // Ended sounds free their place.
    for (const s of ctx.sources) s.onended?.();
    expect(engine.stats.voices).toBe(0);
  });

  it('a stolen one-shot is faded out, not cut', () => {
    const engine = running();
    for (let i = 0; i < 24; i++) {
      engine.beginFrame();
      engine.playEvent('launch', [0, 0, -40 - i], { level: 0.2 });
    }
    expect(engine.stats.byCategory.impacts).toBe(24);
    const gainsBefore = ctx.gains.length;
    engine.beginFrame();
    engine.playEvent('explosion', [0, 0, -2], { size: 7, level: 1 });
    expect(ctx.gains.length).toBeGreaterThan(gainsBefore);
    expect(ctx.sources.some((s) => s.stopped)).toBe(true);
  });

  it('sustained loops share the pool: a full category steals its quietest loop for a louder one', () => {
    const engine = running();
    const stopped: number[] = [];
    const make =
      (id: number) =>
      (c: AudioContext): LoopVoice => {
        const out = (c as unknown as FakeContext).createGain();
        return {
          out: out as unknown as GainNode,
          inspect: () => ({}),
          stop: () => void stopped.push(id),
          dispose: () => undefined,
        };
      };
    const handles = [];
    for (let i = 0; i < 6; i++) handles.push(engine.openLoop('rolling', 0.1 + i * 0.01, make(i)));
    expect(handles.every((h) => h !== null)).toBe(true);
    expect(engine.stats.byCategory.rolling).toBe(6);
    expect(engine.openLoop('rolling', 0.05, make(99))).toBeNull(); // quieter than all of them
    const loud = engine.openLoop('rolling', 0.5, make(100));
    expect(loud).not.toBeNull();
    expect(stopped).toEqual([0]); // the quietest was faded
    expect(handles[0]?.dead).toBe(true);
    expect(engine.stats.byCategory.rolling).toBe(6);
    engine.closeLoop(loud!);
    expect(engine.stats.byCategory.rolling).toBe(5);
  });
});

describe('buffers: rendered once, within a budget, bounded', () => {
  const unique = (n: number): SoundEventDef => ({
    id: `test.unique${n}`,
    label: 'Unique',
    category: 'ui',
    spatial: false,
    key: () => `test|unique|${n}`,
    gain: () => 0.2,
    recipe: () => ({ duration: 0.05, modes: [{ freq: 500 + n, gain: 1, t60: 0.02 }] }),
  });

  it('renders a distinct sound once and reuses its buffer', () => {
    const engine = running();
    for (let i = 0; i < 400 && engine.stats.warming > 0; i++) engine.beginFrame(); // let the warm-up finish first
    engine.beginFrame(); // a fresh render budget (the last warm-up render may have used the previous one)
    engine.playEvent('launch', null, { level: 0.9 });
    const n = engine.stats.renders;
    engine.beginFrame();
    engine.playEvent('launch', null, { level: 0.9 });
    engine.playEvent('launch', null, { level: 0.9 });
    expect(engine.stats.renders).toBe(n);
    expect(ctx.buffers.length).toBe(n);
  });

  it('a request whose buffer cannot be rendered this frame waits and plays on the next', () => {
    const engine = running();
    // The explosion is the one expensive render: it uses the frame's budget…
    expect(engine.playEvent('explosion', null, { size: 7, level: 0.5 })).toBe(true);
    // …so a second new sound is deferred, not lost and not played yet.
    const off = registerSoundEvent(unique(1));
    const startedBefore = engine.stats.started;
    expect(engine.playEvent('test.unique1', null)).toBe(true);
    expect(engine.stats.deferred).toBe(1);
    expect(engine.stats.started).toBe(startedBefore);
    engine.beginFrame(); // a new frame, a new budget
    expect(engine.stats.deferred).toBe(0);
    expect(engine.stats.started).toBe(startedBefore + 1);
    off();
  });

  it('keeps the cache bounded (least recently used buffers are dropped)', () => {
    const engine = running();
    const offs: (() => void)[] = [];
    for (let i = 0; i < 320; i++) {
      offs.push(registerSoundEvent(unique(i)));
      engine.beginFrame();
      engine.playEvent(`test.unique${i}`, null);
    }
    expect(engine.stats.buffers).toBeLessThanOrEqual(280);
    expect(engine.stats.renders).toBeGreaterThanOrEqual(300);
    for (const off of offs) off();
  });

  it('prepares the common sounds in idle frames after the context starts', () => {
    const engine = running();
    expect(engine.stats.warming).toBeGreaterThan(10);
    for (let i = 0; i < 400 && engine.stats.warming > 0; i++) engine.beginFrame();
    expect(engine.stats.warming).toBe(0);
    const keys = engine.cachedKeys();
    expect(keys.some((k) => k.startsWith('i|steel|'))).toBe(true);
    expect(keys).toContain('u|ui.select');
    expect(keys.some((k) => k.startsWith('e|x|'))).toBe(true);
  });
});

describe('time scale and spatial state reach the voices (FX-10, FX-14)', () => {
  it('the pitch factor multiplies the playback rate, and can be switched off', () => {
    const engine = running();
    engine.pitch = 0.5;
    engine.playEvent('ui.select', null);
    expect(engine.recent.at(-1)?.rate).toBeCloseTo(0.5, 6);
    engine.configure(patchAudioSettings(engine.settings, { pitchWithTimeScale: false }));
    engine.playEvent('ui.select', null);
    expect(engine.recent.at(-1)?.rate).toBe(1);
    // The fake source got the same rate.
    expect(ctx.sources.at(-1)?.playbackRate.value).toBe(1);
    expect(ctx.sources.at(-2)?.playbackRate.value).toBeCloseTo(0.5, 6);
  });

  it('pans and attenuates by the position relative to the listener; flat when 3D positioning is off', () => {
    const engine = running();
    engine.playEvent('launch', [8, 0, 0], { level: 0.6 });
    engine.beginFrame();
    engine.playEvent('launch', [-8, 0, 0], { level: 0.6 });
    engine.playEvent('launch', [0, 0, -120], { level: 0.6 });
    const [right, left, far] = engine.recent.slice(-3);
    expect(right.pan).toBeGreaterThan(0.5);
    expect(left.pan).toBeLessThan(-0.5);
    expect(far.gain).toBeLessThan(right.gain * 0.5);
    expect(far.cutoff).toBeLessThan(right.cutoff);
    engine.configure(patchAudioSettings(engine.settings, { spatial: false }));
    engine.playEvent('launch', [80, 0, 0], { level: 0.6 });
    const flat = engine.recent.at(-1);
    expect(flat?.pan).toBe(0);
    expect(flat?.cutoff).toBe(20000);
    expect(flat?.gain).toBeGreaterThan(right.gain);
  });

  it('Doppler shifts the rate only when asked, and the interface is not positioned at all', () => {
    const engine = running();
    engine.playEvent('launch', [0, 0, -40], { level: 0.6 }, [0, 0, 30]);
    expect(engine.recent.at(-1)?.rate).toBe(1);
    engine.configure(patchAudioSettings(engine.settings, { doppler: true }));
    engine.beginFrame();
    engine.playEvent('launch', [0, 0, -40], { level: 0.6 }, [0, 0, 30]);
    expect(engine.recent.at(-1)?.rate).toBeGreaterThan(1.05);
    engine.playEvent('ui.error', [50, 0, -40]);
    expect(engine.recent.at(-1)).toMatchObject({ pan: 0, category: 'ui' });
  });

  it('measures the output level, and reports 0 when it is not running', () => {
    const engine = running();
    expect(engine.level()).toBeCloseTo(0.25, 6); // the fake analyser's constant block
    ctx.state = 'suspended';
    expect(engine.level()).toBe(0);
  });
});

describe('robustness', () => {
  it('survives a browser without WebAudio (state "unsupported", no throw)', () => {
    const engine = new AudioEngine({
      createContext: () => {
        throw new Error('no audio device');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    engine.unlock();
    expect(engine.state).toBe('unsupported');
    expect(engine.playEvent('ui.select', null)).toBe(false);
    expect(() => engine.beginFrame()).not.toThrow();
    warn.mockRestore();
  });

  it('dispose closes the context and forgets the voices', () => {
    const engine = running();
    engine.playEvent('launch', null);
    engine.dispose();
    expect(ctx.state).toBe('closed');
    expect(engine.state).toBe('idle');
    expect(engine.stats.voices).toBe(0);
  });
});

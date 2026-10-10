/**
 * The audio engine's pure core (FX-10, FX-12, FX-13, FX-14): settings, the volume and time-scale laws, voice
 * limiting and priority, spatialisation, the rolling / motor / wind mappings, and the synthesis maths itself — the
 * rendered waveforms are measured (frequency, decay, brightness), not just checked for "no throw".
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import {
  Biquad,
  NoiseSource,
  dominantFrequency,
  renderNoiseLoop,
  renderRecipe,
  ringTime,
  rms,
  spectralCentroid,
  spectrum,
} from '../src/audio/dsp';
import {
  MOTOR_AUDIBLE,
  defaultMotorKind,
  motorParams,
  newMotorParams,
  pulseHarmonics,
  type MotorKind,
} from '../src/audio/motor';
import { airDensityForGravity, bedParams, windParams, newWindParams } from '../src/audio/ambience';
import { dbToGain, gainToDb, hashString, pitchForTimeScale, smoothstep, volumeToGain } from '../src/audio/mapping';
import { ROLL_AUDIBLE, loadFactor, newRollParams, rollParams, type RollInput } from '../src/audio/rolling';
import {
  AUDIO_CATEGORIES,
  AUDIO_CATEGORY_IDS,
  DEFAULT_AUDIO_SETTINGS,
  MAX_TOTAL_VOICES,
  patchAudioSettings,
  sanitizeAudioSettings,
} from '../src/audio/settings';
import {
  DEFAULT_SPATIAL_MODEL,
  distanceGain,
  flatSpatial,
  listenerFromMatrix,
  newListener,
  newSpatialResult,
  spatialize,
} from '../src/audio/spatial';
import { STEAL_MARGIN, TopN, VoicePool, type PoolVoice } from '../src/audio/voicePool';

const SR = 44100;

// -- settings ------------------------------------------------------------------------------------------------------------

describe('audio settings', () => {
  it('has the checklist categories, with sane defaults', () => {
    expect(AUDIO_CATEGORY_IDS).toEqual(['impacts', 'rolling', 'engines', 'ambience', 'ui']);
    expect(DEFAULT_AUDIO_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_AUDIO_SETTINGS.muted).toBe(false);
    for (const c of AUDIO_CATEGORIES) {
      expect(DEFAULT_AUDIO_SETTINGS.volume[c.id]).toBe(c.volume);
      expect(c.maxVoices).toBeGreaterThan(0);
    }
    // The ambience bed and the interface are quieter than the physics by default.
    expect(DEFAULT_AUDIO_SETTINGS.volume.ambience).toBeLessThan(DEFAULT_AUDIO_SETTINGS.volume.impacts);
    expect(DEFAULT_AUDIO_SETTINGS.volume.ui).toBeLessThan(DEFAULT_AUDIO_SETTINGS.volume.impacts);
  });

  it('sanitises garbage, clamps volumes and keeps valid values', () => {
    expect(sanitizeAudioSettings(undefined)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(sanitizeAudioSettings('nope')).toEqual(DEFAULT_AUDIO_SETTINGS);
    const s = sanitizeAudioSettings({
      enabled: false,
      muted: true,
      master: 7,
      volume: { impacts: -3, rolling: 0.25, engines: 'loud', bogus: 1 },
      spatial: 'yes',
      doppler: true,
    });
    expect(s.enabled).toBe(false);
    expect(s.muted).toBe(true);
    expect(s.master).toBe(1);
    expect(s.volume.impacts).toBe(0);
    expect(s.volume.rolling).toBe(0.25);
    expect(s.volume.engines).toBe(DEFAULT_AUDIO_SETTINGS.volume.engines);
    expect('bogus' in s.volume).toBe(false);
    expect(s.spatial).toBe(DEFAULT_AUDIO_SETTINGS.spatial);
    expect(s.doppler).toBe(true);
    expect(Number.isNaN(sanitizeAudioSettings({ master: NaN }).master)).toBe(false);
  });

  it('round-trips through JSON and patches one field at a time', () => {
    const a = patchAudioSettings(DEFAULT_AUDIO_SETTINGS, { muted: true, volume: { ui: 0.1 } });
    expect(a.muted).toBe(true);
    expect(a.volume.ui).toBe(0.1);
    expect(a.volume.impacts).toBe(DEFAULT_AUDIO_SETTINGS.volume.impacts);
    expect(sanitizeAudioSettings(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(MAX_TOTAL_VOICES).toBeGreaterThanOrEqual(Math.max(...AUDIO_CATEGORIES.map((c) => c.maxVoices)));
  });
});

// -- laws ----------------------------------------------------------------------------------------------------------------

describe('volume and time-scale laws', () => {
  it('maps the volume slider to a gain: zero is silence, full is unity, monotonic, half is −12 dB', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBe(1);
    expect(gainToDb(volumeToGain(0.5))).toBeCloseTo(-12.04, 1);
    let prev = -1;
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const g = volumeToGain(v);
      expect(g).toBeGreaterThan(prev - 1e-12);
      prev = g;
    }
    expect(volumeToGain(NaN)).toBe(0);
    expect(volumeToGain(5)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 2);
  });

  it('bends pitch with the time scale: unity at 1×, lower and monotonic when slowed, a little higher when fast', () => {
    expect(pitchForTimeScale(1)).toBe(1);
    const slow = [0.1, 0.25, 0.5, 0.75, 1].map(pitchForTimeScale);
    for (let i = 1; i < slow.length; i++) expect(slow[i]).toBeGreaterThan(slow[i - 1]);
    expect(pitchForTimeScale(0.5)).toBeCloseTo(0.73, 1);
    expect(pitchForTimeScale(0.25)).toBeCloseTo(0.54, 1);
    expect(pitchForTimeScale(0.1)).toBeCloseTo(0.355, 2); // about the floor: not three octaves down
    expect(pitchForTimeScale(0.001)).toBe(0.35);
    expect(pitchForTimeScale(4)).toBeGreaterThan(1);
    expect(pitchForTimeScale(4)).toBeLessThanOrEqual(1.25);
    expect(pitchForTimeScale(1000)).toBe(1.25);
    expect(pitchForTimeScale(0)).toBe(1); // garbage in, neutral out
    expect(pitchForTimeScale(NaN)).toBe(1);
  });

  it('hashes strings stably', () => {
    expect(hashString('steel')).toBe(hashString('steel'));
    expect(hashString('steel')).not.toBe(hashString('wood'));
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
  });
});

// -- voice limiting and priority -------------------------------------------------------------------------------------------

interface V extends PoolVoice {
  name: string;
}
const voice = (name: string, category: string, priority: number, start = 0): V => ({ name, category, priority, start });

describe('voice pool (FX-10: limiting and priority)', () => {
  const limits = { total: 5, perCategory: { impacts: 3, ui: 2 } };

  it('admits voices while there is room, in the category and in total', () => {
    const pool = new VoicePool<V>(limits);
    for (let i = 0; i < 3; i++) {
      const a = pool.admit('impacts', 1, 0);
      expect(a).toEqual({ ok: true, steals: [] });
      pool.add(voice(`i${i}`, 'impacts', 1));
    }
    expect(pool.count('impacts')).toBe(3);
    expect(pool.count()).toBe(3);
  });

  it('turns a quieter newcomer away when its category is full, and steals the quietest for a louder one', () => {
    const pool = new VoicePool<V>(limits);
    const quiet = voice('quiet', 'impacts', 0.1);
    pool.add(quiet);
    pool.add(voice('mid', 'impacts', 0.5));
    pool.add(voice('loud', 'impacts', 0.9));
    expect(pool.admit('impacts', 0.05, 0)).toEqual({ ok: false });
    // Must beat the victim by the steal margin, not merely equal it.
    expect(pool.admit('impacts', 0.1 * STEAL_MARGIN * 0.99, 0)).toEqual({ ok: false });
    const a = pool.admit('impacts', 0.3, 0);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.steals).toEqual([quiet]);
    // Other categories are unaffected by a full impacts category.
    expect(pool.admit('ui', 0.01, 0)).toEqual({ ok: true, steals: [] });
  });

  it('enforces the total budget across categories', () => {
    const pool = new VoicePool<V>(limits);
    pool.add(voice('a', 'impacts', 0.8));
    pool.add(voice('b', 'impacts', 0.8));
    pool.add(voice('c', 'ui', 0.2));
    pool.add(voice('d', 'ui', 0.3));
    pool.add(voice('e', 'rolling', 0.05));
    expect(pool.count()).toBe(5);
    expect(pool.admit('rolling', 0.01, 0)).toEqual({ ok: false });
    const a = pool.admit('rolling', 0.5, 0);
    expect(a.ok && a.steals.map((v) => v.name)).toEqual(['e']);
    // A category over its limit and the total over theirs at once: two voices can go.
    pool.add(voice('f', 'impacts', 0.1));
    expect(pool.count('impacts')).toBe(3);
  });

  it('lets an old voice be stolen a little more easily than a fresh one of the same loudness', () => {
    const pool = new VoicePool<V>({ total: 1, perCategory: {} });
    const old = voice('old', 'x', 1, 0);
    pool.add(old);
    expect(pool.effective(old, 0)).toBeCloseTo(1, 6);
    expect(pool.effective(old, 10)).toBeLessThan(0.6);
    expect(pool.admit('x', 1.1, 0)).toEqual({ ok: false }); // within the margin of a fresh voice
    expect(pool.admit('x', 1.1, 10).ok).toBe(true); // …but beats a voice that has been ringing for 10 s
  });

  it('removes voices and keeps counting right', () => {
    const pool = new VoicePool<V>(limits);
    const a = voice('a', 'impacts', 1);
    const b = voice('b', 'ui', 1);
    pool.add(a);
    pool.add(b);
    expect(pool.remove(a)).toBe(true);
    expect(pool.remove(a)).toBe(false);
    expect(pool.count()).toBe(1);
    expect(pool.count('impacts')).toBe(0);
  });
});

describe('TopN', () => {
  it('keeps the n best candidates, best first, ignoring silent ones', () => {
    const top = new TopN<string>(3);
    for (const [name, s] of [
      ['a', 1],
      ['b', 5],
      ['c', 3],
      ['d', 0],
      ['e', 4],
      ['f', 2],
      ['g', -1],
    ] as const)
      top.offer(name, s);
    expect(top.size).toBe(3);
    expect(top.items.slice(0, 3)).toEqual(['b', 'e', 'c']);
    expect(top.scores.slice(0, 3)).toEqual([5, 4, 3]);
    top.clear();
    expect(top.size).toBe(0);
    expect(top.offer('x', 0)).toBe(false);
  });
});

// -- spatialisation --------------------------------------------------------------------------------------------------------

describe('spatialisation (FX-14)', () => {
  // A camera at the origin looking down −Z with +Y up and +X to the right.
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const listener = () => listenerFromMatrix(identity, newListener());
  const at = (x: number, y: number, z: number) => spatialize(listener(), x, y, z, newSpatialResult());

  it('reads a camera world matrix: position, right, up, forward', () => {
    const m = [...identity];
    m[12] = 3;
    m[13] = 4;
    m[14] = 5;
    const l = listenerFromMatrix(m, newListener());
    expect([l.x, l.y, l.z]).toEqual([3, 4, 5]);
    expect([l.fx + 0, l.fy + 0, l.fz]).toEqual([0, 0, -1]); // + 0 turns the −0 of a negated zero into 0
    expect([l.rx, l.ry, l.rz]).toEqual([1, 0, 0]);
  });

  it('pans a source to the side it is on, and centres one straight ahead or behind', () => {
    expect(at(10, 0, 0).pan).toBeCloseTo(1, 5);
    expect(at(-10, 0, 0).pan).toBeCloseTo(-1, 5);
    expect(at(0, 0, -10).pan).toBeCloseTo(0, 5);
    expect(at(0, 0, 10).pan).toBeCloseTo(0, 5);
    expect(at(10, 0, -10).pan).toBeCloseTo(Math.SQRT1_2, 3);
    expect(at(0, 5, -10).pan).toBeCloseTo(0, 5); // above does not pan
    // Pan grows monotonically as the source moves from ahead to the right.
    let prev = -2;
    for (let a = 0; a <= 90; a += 15) {
      const r = (a * Math.PI) / 180;
      const p = at(Math.sin(r) * 10, 0, -Math.cos(r) * 10).pan;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    // A source at the listener has no direction.
    expect(at(0, 0, 0).pan).toBe(0);
    expect(at(0.05, 0, 0).pan).toBeLessThan(0.2);
  });

  it('attenuates with distance: full inside the reference distance, inverse beyond, silent past the maximum', () => {
    const m = DEFAULT_SPATIAL_MODEL;
    expect(distanceGain(0, m)).toBe(1);
    expect(distanceGain(m.refDistance, m)).toBe(1);
    expect(distanceGain(2 * m.refDistance, m)).toBeCloseTo(m.refDistance / (m.refDistance + m.refDistance), 6);
    let prev = 2;
    for (const d of [1, 4, 8, 16, 32, 64, 128, 256, 319]) {
      const g = distanceGain(d, m);
      expect(g).toBeLessThanOrEqual(prev);
      expect(g).toBeGreaterThan(0);
      prev = g;
    }
    expect(distanceGain(m.maxDistance, m)).toBe(0);
    expect(distanceGain(1000, m)).toBe(0);
    // Doubling the distance far away halves the level (inverse-distance law).
    expect(distanceGain(100, m) / distanceGain(50, m)).toBeLessThan(0.55);
    expect(at(0, 0, -40).gain).toBeLessThan(at(0, 0, -10).gain);
  });

  it('dulls distant sounds and sounds behind the listener', () => {
    expect(at(0, 0, -2).cutoff).toBeGreaterThan(at(0, 0, -100).cutoff);
    expect(at(0, 0, 20).cutoff).toBeLessThan(at(0, 0, -20).cutoff); // behind is duller than ahead at equal distance
    expect(at(0, 0, -1).cutoff).toBeGreaterThan(15000);
    expect(at(0, 0, -300).cutoff).toBeGreaterThanOrEqual(1200);
  });

  it('shifts pitch (Doppler) up for approaching sources and down for receding ones, only when asked', () => {
    const l = listener();
    const out = newSpatialResult();
    // Source 50 m ahead moving towards the listener at 30 m/s.
    spatialize(l, 0, 0, -50, out, DEFAULT_SPATIAL_MODEL, 0, 0, 30, 1);
    expect(out.rate).toBeCloseTo(343 / (343 - 30), 4);
    // Moving away.
    spatialize(l, 0, 0, -50, out, DEFAULT_SPATIAL_MODEL, 0, 0, -30, 1);
    expect(out.rate).toBeCloseTo(343 / (343 + 30), 4);
    // A listener driving towards a still source also hears it rise.
    l.vz = -20;
    spatialize(l, 0, 0, -50, out, DEFAULT_SPATIAL_MODEL, 0, 0, 0, 1);
    expect(out.rate).toBeCloseTo((343 + 20) / 343, 4);
    // Half amount is the square root of the ratio; zero is off.
    spatialize(l, 0, 0, -50, out, DEFAULT_SPATIAL_MODEL, 0, 0, 0, 0.5);
    expect(out.rate).toBeCloseTo(Math.sqrt((343 + 20) / 343), 4);
    spatialize(l, 0, 0, -50, out, DEFAULT_SPATIAL_MODEL, 0, 0, 0, 0);
    expect(out.rate).toBe(1);
    // Extreme speeds are clamped to a musical range.
    spatialize(newListener(), 0, 0, -50, out, DEFAULT_SPATIAL_MODEL, 0, 0, 330, 1);
    expect(out.rate).toBeLessThanOrEqual(1.25);
  });

  it('flat mode centres everything at full level', () => {
    const r = flatSpatial(newSpatialResult());
    expect(r).toMatchObject({ gain: 1, pan: 0, cutoff: 20000, rate: 1 });
  });
});

// -- rolling and sliding ------------------------------------------------------------------------------------------------------

describe('rolling and sliding mapping (FX-12)', () => {
  const base: RollInput = { cls: 'metal', speed: 4, slip: 0, load: 1500, size: 0.5, rounded: true };
  const roll = (over: Partial<RollInput>) => rollParams({ ...base, ...over }, newRollParams());

  it('a ball rolling freely is all rumble, a box dragged along is all scrape', () => {
    const rolling = roll({});
    expect(rolling.rumbleGain).toBeGreaterThan(ROLL_AUDIBLE);
    expect(rolling.scrapeGain).toBe(0);
    const sliding = roll({ rounded: false, slip: 4 });
    expect(sliding.rumbleGain).toBe(0);
    expect(sliding.scrapeGain).toBeGreaterThan(ROLL_AUDIBLE);
    // A round body that skids (a locked wheel) trades rumble for scrape.
    const skid = roll({ slip: 4 });
    expect(skid.scrapeGain).toBeGreaterThan(0);
    expect(skid.rumbleGain).toBeLessThan(rolling.rumbleGain * 0.2);
  });

  it('rumble level and cutoff rise monotonically with rolling speed, and nothing sounds at rest', () => {
    let g = -1;
    let c = -1;
    for (const speed of [0, 0.2, 0.5, 1, 2, 4, 8, 16]) {
      const p = roll({ speed });
      expect(p.rumbleGain).toBeGreaterThanOrEqual(g);
      expect(p.rumbleCutoff).toBeGreaterThanOrEqual(c);
      g = p.rumbleGain;
      c = p.rumbleCutoff;
    }
    expect(roll({ speed: 0 }).loudness).toBe(0);
    expect(roll({ speed: 0.1 }).loudness).toBeLessThan(ROLL_AUDIBLE);
  });

  it('scrape level and pitch rise monotonically with the slip speed', () => {
    let g = -1;
    let f = -1;
    for (const slip of [0, 0.5, 1, 2, 4, 8, 16]) {
      const p = roll({ rounded: false, speed: slip, slip });
      expect(p.scrapeGain).toBeGreaterThanOrEqual(g);
      expect(p.scrapeFreq).toBeGreaterThanOrEqual(f);
      g = p.scrapeGain;
      f = p.scrapeFreq;
    }
  });

  it('loud with load: a heavy body is louder than a light one, logarithmically', () => {
    let prev = 0;
    for (const load of [5, 20, 100, 500, 2500, 12000, 60000]) {
      const l = loadFactor(load);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
    expect(loadFactor(10)).toBeCloseTo(0.35, 2);
    expect(loadFactor(20000)).toBeCloseTo(1, 1);
    expect(roll({ load: 12000 }).rumbleGain).toBeGreaterThan(roll({ load: 50 }).rumbleGain);
  });

  it('materials differ: rubber squeals higher-Q than stone rasps; rolling foam is nearly silent', () => {
    const rubber = roll({ cls: 'rubber', rounded: false, slip: 5, speed: 5 });
    const stone = roll({ cls: 'stone', rounded: false, slip: 5, speed: 5 });
    expect(rubber.scrapeQ).toBeGreaterThan(stone.scrapeQ);
    expect(roll({ cls: 'foam' }).loudness).toBeLessThan(roll({ cls: 'metal' }).loudness * 0.3);
    // Bigger bodies are lower in pitch.
    expect(roll({ size: 3, rounded: false, slip: 5, speed: 5 }).scrapeFreq).toBeLessThan(
      roll({ size: 0.2, rounded: false, slip: 5, speed: 5 }).scrapeFreq,
    );
  });
});

// -- engines and motors ---------------------------------------------------------------------------------------------------------

describe('engine and motor mapping (FX-13)', () => {
  const kinds: MotorKind[] = ['combustion', 'electric', 'rotor'];
  const at = (kind: MotorKind, rpm: number, load: number) => motorParams(kind, rpm, load, newMotorParams());

  it('pitch follows motor speed: the fundamental rises monotonically with rpm', () => {
    for (const kind of kinds) {
      let prev = 0;
      for (const rpm of [0, 100, 300, 900, 2000, 4000, 7000]) {
        const f = at(kind, rpm, 0.5).f1;
        expect(f, `${kind} ${rpm}`).toBeGreaterThanOrEqual(prev);
        prev = f;
      }
    }
    // The combustion engine fires at rpm/60 × 3: 6000 rpm = 300 Hz.
    expect(at('combustion', 6000, 0.5).f1).toBeCloseTo(300, 6);
    expect(at('combustion', 6000, 0.5).f2).toBeCloseTo(600 * 1.007, 3);
  });

  it('timbre follows load: the filter opens and the voice gets louder as load rises', () => {
    for (const kind of kinds) {
      const rpm = kind === 'rotor' ? 600 : kind === 'electric' ? 1500 : 3000;
      let cutoff = 0;
      let gain = 0;
      for (const load of [0, 0.25, 0.5, 0.75, 1]) {
        const p = at(kind, rpm, load);
        expect(p.cutoff, `${kind} cutoff`).toBeGreaterThanOrEqual(cutoff);
        expect(p.gain, `${kind} gain`).toBeGreaterThanOrEqual(gain);
        cutoff = p.cutoff;
        gain = p.gain;
      }
    }
  });

  it('is silent when stopped, and louder when revving than when ticking over', () => {
    for (const kind of kinds) {
      expect(at(kind, 0, 1).gain, kind).toBe(0);
      expect(at(kind, 0, 1).gain).toBeLessThan(MOTOR_AUDIBLE);
    }
    expect(at('combustion', 6000, 0.6).gain).toBeGreaterThan(at('combustion', 900, 0.6).gain);
    expect(at('combustion', 900, 0.2).gain).toBeGreaterThan(MOTOR_AUDIBLE); // idle is audible
    expect(at('electric', 600, 0.5).gain).toBeGreaterThan(MOTOR_AUDIBLE);
  });

  it('a rotor chops at the blade-pass frequency, deeply when slow and blurred when fast; a jet roars with thrust', () => {
    const slow = at('rotor', 300, 0.5);
    expect(slow.lfoRate).toBeCloseTo(10, 6);
    expect(slow.lfoDepth).toBeGreaterThan(0.7);
    const fast = at('rotor', 3000, 0.5);
    expect(fast.lfoRate).toBeCloseTo(100, 6);
    expect(fast.lfoDepth).toBe(0);
    expect(at('combustion', 3000, 0.5).lfoRate).toBe(0);
    let g = 0;
    let c = 0;
    for (const thrust of [0, 0.1, 0.3, 0.6, 1]) {
      const p = at('jet', 0, thrust);
      expect(p.gain).toBeGreaterThanOrEqual(g);
      expect(p.noiseCutoff).toBeGreaterThanOrEqual(c);
      g = p.gain;
      c = p.noiseCutoff;
    }
    expect(at('jet', 0, 0).gain).toBe(0);
  });

  it('ignores the sign of the rpm and survives garbage', () => {
    expect(at('combustion', -3000, 0.5)).toEqual(at('combustion', 3000, 0.5));
    const p = at('electric', NaN, NaN);
    for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
    expect(at('electric', 1e9, 5).f1).toBeLessThanOrEqual(3000);
  });

  it('picks a kind from the component type', () => {
    expect(defaultMotorKind('engine')).toBe('combustion');
    expect(defaultMotorKind('propeller')).toBe('rotor');
    expect(defaultMotorKind('rotor')).toBe('rotor');
    expect(defaultMotorKind('jet')).toBe('jet');
    expect(defaultMotorKind('thruster')).toBe('jet');
    expect(defaultMotorKind('motor')).toBe('electric');
    expect(defaultMotorKind(null)).toBe('electric');
  });

  it('builds the pulse-train harmonics: a narrow pulse is rich, a square pulse has only odd harmonics', () => {
    const narrow = pulseHarmonics(24, 0.12);
    expect(narrow.real[0]).toBe(0);
    expect(narrow.real.length).toBe(25);
    expect(Math.abs(narrow.real[8])).toBeGreaterThan(0.005);
    expect(Math.abs(narrow.real[8])).toBeLessThan(Math.abs(narrow.real[1]));
    const square = pulseHarmonics(10, 0.5);
    expect(Math.abs(square.real[2])).toBeLessThan(1e-6);
    expect(Math.abs(square.real[1])).toBeGreaterThan(0.5);
    expect(Math.abs(square.real[3])).toBeCloseTo(Math.abs(square.real[1]) / 3, 4);
  });
});

describe('ambience mapping (FX-13)', () => {
  it('wind rises with air speed and is silent in still air', () => {
    const w = newWindParams();
    expect(windParams(0, 1, w).gain).toBe(0);
    expect(windParams(2, 1, w).gain).toBe(0);
    let g = 0;
    let c = 0;
    for (const v of [3, 8, 15, 25, 40, 60]) {
      windParams(v, 1, w);
      expect(w.gain).toBeGreaterThan(g);
      expect(w.cutoff).toBeGreaterThan(c);
      g = w.gain;
      c = w.cutoff;
    }
    // Faster wind gusts faster and shallower.
    const slow = { ...windParams(10, 1, newWindParams()) };
    const fast = { ...windParams(45, 1, newWindParams()) };
    expect(fast.gustRate).toBeGreaterThan(slow.gustRate);
    expect(fast.gustDepth).toBeLessThan(slow.gustDepth);
    expect(windParams(30, 0, newWindParams()).gain).toBe(0); // no air, no wind
  });

  it('air density follows gravity: space is silent', () => {
    expect(airDensityForGravity(9.81)).toBe(1);
    expect(airDensityForGravity(1.62)).toBe(1);
    expect(airDensityForGravity(0)).toBe(0);
    expect(airDensityForGravity(0.1)).toBeGreaterThan(0);
    expect(airDensityForGravity(0.1)).toBeLessThan(1);
    expect(bedParams(0, { gain: 0, cutoff: 0 }).gain).toBe(0);
    expect(bedParams(1, { gain: 0, cutoff: 0 }).gain).toBeGreaterThan(0);
  });
});

// -- the synthesis maths ----------------------------------------------------------------------------------------------------

describe('synthesis (dsp)', () => {
  it('renders a single mode at its frequency, to within a few hertz', () => {
    for (const f of [110, 440, 1000, 3500, 9000]) {
      const x = renderRecipe({ duration: 0.4, modes: [{ freq: f, gain: 1, t60: 0.5 }] }, SR, 1);
      expect(dominantFrequency(x, SR, 50, 15000, 16384)).toBeCloseTo(f, -1);
    }
  });

  it('decays by 60 dB in t60 seconds', () => {
    const t60 = 0.3;
    const x = renderRecipe({ duration: 0.6, modes: [{ freq: 500, gain: 1, t60 }], peak: 1 }, SR, 1);
    const level = (t: number) => {
      const i = Math.floor(t * SR);
      let m = 0;
      for (let j = i; j < i + 200; j++) m = Math.max(m, Math.abs(x[j]));
      return m;
    };
    const drop = 20 * Math.log10(level(0.05) / level(0.05 + t60));
    expect(drop).toBeGreaterThan(57);
    expect(drop).toBeLessThan(63);
  });

  it('is deterministic for a seed, different for another, and normalised to the requested peak', () => {
    const recipe = {
      duration: 0.3,
      modes: [{ freq: 700, gain: 1, t60: 0.2 }],
      noise: [{ color: 'white' as const, gain: 0.5, t60: 0.1 }],
      grains: [{ count: 10, spread: 0.2, fMin: 1000, fMax: 5000, gain: 0.3, t60: 0.05 }],
    };
    const a = renderRecipe(recipe, SR, 7);
    const b = renderRecipe(recipe, SR, 7);
    const c = renderRecipe(recipe, SR, 8);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(Buffer.from(a.buffer).equals(Buffer.from(c.buffer))).toBe(false);
    expect(Math.max(...a.map(Math.abs))).toBeCloseTo(0.9, 2);
    expect(Math.max(...renderRecipe({ ...recipe, peak: 0.5 }, SR, 7).map(Math.abs))).toBeCloseTo(0.5, 2);
    expect(a[a.length - 1]).toBe(0); // ends with a fade, never a click
  });

  it('a pitch glide starts high and settles on the frequency', () => {
    const x = renderRecipe(
      { duration: 0.5, modes: [{ freq: 200, gain: 1, t60: 1, glide: { from: 2, time: 0.05 } }] },
      SR,
      1,
    );
    const head = x.subarray(0, Math.floor(0.03 * SR));
    const tail = x.subarray(Math.floor(0.3 * SR));
    expect(dominantFrequency(head, SR, 80, 1000, 16384)).toBeGreaterThan(260);
    expect(dominantFrequency(tail, SR, 80, 1000, 16384)).toBeCloseTo(200, -1);
  });

  it('a mode starts at its onset and not before', () => {
    const x = renderRecipe({ duration: 0.4, modes: [{ freq: 800, gain: 1, t60: 0.3, start: 0.2 }] }, SR, 1);
    expect(rms(x.subarray(0, Math.floor(0.19 * SR)))).toBe(0);
    expect(rms(x.subarray(Math.floor(0.21 * SR), Math.floor(0.25 * SR)))).toBeGreaterThan(0.1);
  });

  it('vibrato modulates the pitch and dies away', () => {
    const x = renderRecipe(
      { duration: 0.6, modes: [{ freq: 300, gain: 1, t60: 1, vibrato: { rate: 12, depth: 0.2, t60: 0.2 } }] },
      SR,
      1,
    );
    // Count zero crossings per window: it varies early (vibrato) and is steady late.
    const crossings = (a: number, b: number) => {
      let n = 0;
      for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) if (x[i - 1] <= 0 && x[i] > 0) n++;
      return n;
    };
    const early = [0, 0.04, 0.08, 0.12].map((t) => crossings(t, t + 0.04));
    const late = [0.4, 0.44, 0.48, 0.52].map((t) => crossings(t, t + 0.04));
    expect(Math.max(...early) - Math.min(...early)).toBeGreaterThan(Math.max(...late) - Math.min(...late));
  });

  it('shapes noise: a low-pass is darker than a high-pass; pink is darker than white; a band-pass peaks at its frequency', () => {
    const noise = (
      color: 'white' | 'pink' | 'brown',
      filter?: { type: 'lowpass' | 'highpass' | 'bandpass'; freq: number; q?: number },
    ) => renderRecipe({ duration: 0.5, noise: [{ color, gain: 1, t60: 3, filter }] }, SR, 3);
    const lp = noise('white', { type: 'lowpass', freq: 500 });
    const hp = noise('white', { type: 'highpass', freq: 4000 });
    expect(spectralCentroid(lp, SR)).toBeLessThan(spectralCentroid(hp, SR) / 3);
    expect(spectralCentroid(noise('pink'), SR)).toBeLessThan(spectralCentroid(noise('white'), SR));
    expect(spectralCentroid(noise('brown'), SR)).toBeLessThan(spectralCentroid(noise('pink'), SR));
    const bp = noise('white', { type: 'bandpass', freq: 2000, q: 8 });
    expect(dominantFrequency(bp, SR, 200, 12000, 16384)).toBeCloseTo(2000, -2);
  });

  it('sweeps a filter: a falling low-pass makes the sound darker with time', () => {
    const x = renderRecipe(
      {
        duration: 1,
        noise: [{ color: 'white', gain: 1, t60: 3, filter: { type: 'lowpass', freq: 6000, freqEnd: 200 } }],
      },
      SR,
      5,
    );
    const early = spectralCentroid(x.subarray(0, 4096), SR);
    const late = spectralCentroid(x.subarray(Math.floor(0.8 * SR), Math.floor(0.8 * SR) + 4096), SR);
    expect(late).toBeLessThan(early / 2);
  });

  it('grains scatter fragments over their spread', () => {
    const x = renderRecipe(
      { duration: 0.6, grains: [{ count: 30, start: 0.1, spread: 0.3, fMin: 2000, fMax: 8000, gain: 1, t60: 0.04 }] },
      SR,
      9,
    );
    expect(rms(x.subarray(0, Math.floor(0.09 * SR)))).toBe(0);
    expect(rms(x.subarray(Math.floor(0.1 * SR), Math.floor(0.3 * SR)))).toBeGreaterThan(0.02);
    expect(rms(x.subarray(Math.floor(0.55 * SR)))).toBeLessThan(0.01);
    expect(spectralCentroid(x, SR)).toBeGreaterThan(2500);
  });

  it('measures ring time: a long ring is longer than a short one', () => {
    const long = renderRecipe({ duration: 1.5, modes: [{ freq: 600, gain: 1, t60: 1 }] }, SR, 1);
    const short = renderRecipe({ duration: 1.5, modes: [{ freq: 600, gain: 1, t60: 0.1 }] }, SR, 1);
    expect(ringTime(long, SR)).toBeGreaterThan(ringTime(short, SR) * 5);
    // 40 dB down takes two thirds of t60.
    expect(ringTime(long, SR)).toBeCloseTo(0.667, 1);
  });

  it('a biquad low-pass passes a low tone and rejects a high one', () => {
    const run = (hz: number) => {
      const f = new Biquad();
      f.set('lowpass', 1000, 0.707, SR);
      let s = 0;
      let n = 0;
      for (let i = 0; i < SR / 2; i++) {
        const y = f.process(Math.sin((2 * Math.PI * hz * i) / SR));
        if (i > 2000) {
          s += y * y;
          n++;
        }
      }
      return Math.sqrt(s / n) * Math.SQRT2;
    };
    expect(run(100)).toBeCloseTo(1, 1);
    expect(run(8000)).toBeLessThan(0.05);
  });

  it('coloured noise has the right slope: white rises with bandwidth, pink is level per octave, brown falls', () => {
    const slope = (color: 'white' | 'pink' | 'brown') => {
      const src = new NoiseSource(new Rng(11), color);
      const x = new Float32Array(1 << 16);
      for (let i = 0; i < 4096; i++) src.next();
      for (let i = 0; i < x.length; i++) x[i] = src.next();
      const mag = spectrum(x, 1 << 15);
      const band = (lo: number, hi: number) => {
        let s = 0;
        for (let i = lo; i < hi; i++) s += mag[i] * mag[i];
        return s;
      };
      // Power in an octave around 200 Hz vs the octave around 3.2 kHz (4 octaves apart).
      const bin = (hz: number) => Math.round((hz * (1 << 15)) / SR);
      return 10 * Math.log10(band(bin(200), bin(400)) / band(bin(3200), bin(6400)));
    };
    // Octave 200–400 Hz vs octave 3.2–6.4 kHz: white noise has power ∝ bandwidth (16× more up there: −12 dB), pink
    // has equal power per octave (0 dB), brown falls 6 dB per octave (+24 dB over four octaves in theory; the leaky
    // integrator flattens its lowest octaves, so allow a wide margin).
    expect(slope('white')).toBeGreaterThan(-14);
    expect(slope('white')).toBeLessThan(-10);
    expect(Math.abs(slope('pink'))).toBeLessThan(2.5);
    expect(slope('brown')).toBeGreaterThan(8);
  });

  it('builds a seamless noise loop: the last sample leads into the first like any two neighbours', () => {
    const loop = renderNoiseLoop('pink', 1.5, SR, 3);
    expect(loop.length).toBe(Math.floor(1.5 * SR));
    expect(Math.max(...loop.map(Math.abs))).toBeCloseTo(0.9, 2);
    // The seam step is no bigger than a typical step elsewhere.
    let typical = 0;
    for (let i = 1000; i < 5000; i++) typical = Math.max(typical, Math.abs(loop[i] - loop[i - 1]));
    expect(Math.abs(loop[0] - loop[loop.length - 1])).toBeLessThan(typical * 1.5);
    // Equal-power blend: the level near the seam does not dip.
    expect(rms(loop.subarray(0, 800))).toBeGreaterThan(rms(loop) * 0.5);
    expect(
      Buffer.from(renderNoiseLoop('pink', 0.5, SR, 3).buffer).equals(
        Buffer.from(renderNoiseLoop('pink', 0.5, SR, 3).buffer),
      ),
    ).toBe(true);
  });
});

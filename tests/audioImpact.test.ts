/**
 * Impact and event sounds (FX-11, FX-15): the mapping from a contact to voices (loudness monotonic in the impulse
 * and speed, pitch falling with size, material classes), and the synthesised waveforms themselves, measured — the
 * metal clang's inharmonic partials, how long each material rings, the soft partner's damping, the shatter spray —
 * plus the event sounds (explosion, spawn, break, snap, trampoline, launch, interface).
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL_PRESETS } from '../src/model/materials';
import { dominantFrequency, renderRecipe, ringTime, rms, spectralCentroid, spectrum } from '../src/audio/dsp';
import {
  bucketPitch,
  impactEnergy,
  impactKey,
  impactLevels,
  impactRecipe,
  levelBucket,
  levelToGain,
  pitchBucket,
  planImpact,
  REF_SIZE,
  ringShare,
  sizePitchFactor,
  soundLevel,
  type ImpactInput,
  type ImpactSpec,
} from '../src/audio/impact';
import { gainToDb, hashString } from '../src/audio/mapping';
import {
  GROUND_SOUND,
  SOUND_CLASSES,
  registerSoundMaterial,
  soundProfileFor,
  type SoundProfile,
} from '../src/audio/materials';
import { listSoundEvents, registerSoundEvent, soundEvent, type SoundEventDef } from '../src/audio/events';

const SR = 44100;

const hit = (over: Partial<ImpactInput> = {}): ImpactInput => ({
  speed: 6,
  impulse: 600,
  matA: 'steel',
  matB: 'ground',
  sizeA: 0.5,
  sizeB: 99,
  massA: 10,
  massB: 0,
  ...over,
});

const render = (spec: ImpactSpec): Float32Array => renderRecipe(impactRecipe(spec), SR, hashString(impactKey(spec)));
const specOf = (preset: string, o: Partial<ImpactSpec> = {}): ImpactSpec => ({
  preset,
  pitch: pitchBucket(soundProfileFor(preset).pitch),
  level: 2,
  damp: 0,
  shatter: false,
  ...o,
});

describe('impact loudness (FX-11: velocity / impulse scaled)', () => {
  it('is the kinetic energy ½·J·v on a logarithmic 0 … 1 scale', () => {
    expect(impactEnergy(10, 200)).toBe(1000);
    expect(impactEnergy(-1, 5)).toBe(0);
    expect(soundLevel(0)).toBe(0);
    expect(soundLevel(0.02)).toBeCloseTo(0, 6);
    expect(soundLevel(20000)).toBeCloseTo(1, 6);
    expect(soundLevel(1e9)).toBe(1);
    let prev = -1;
    for (const e of [0.001, 0.02, 0.1, 1, 10, 100, 1000, 10000, 20000]) {
      expect(soundLevel(e)).toBeGreaterThanOrEqual(prev);
      prev = soundLevel(e);
    }
  });

  it('maps the level to a gain from −44 dB to −6 dB, monotonically', () => {
    expect(gainToDb(levelToGain(0))).toBeCloseTo(-44, 3);
    expect(gainToDb(levelToGain(1))).toBeCloseTo(-6, 3);
    let prev = 0;
    for (let l = 0; l <= 1.0001; l += 0.1) {
      expect(levelToGain(l)).toBeGreaterThan(prev);
      prev = levelToGain(l);
    }
  });

  it('gets louder with the impulse at a fixed speed, and with the speed at a fixed impulse', () => {
    let prev = 0;
    for (const impulse of [0.05, 0.2, 1, 5, 30, 200, 1500, 12000]) {
      const v = planImpact(hit({ impulse }));
      if (!v.length) continue;
      expect(v[0].gain, `impulse ${impulse}`).toBeGreaterThanOrEqual(prev);
      prev = v[0].gain;
    }
    expect(prev).toBeGreaterThan(0.1);
    prev = 0;
    for (const speed of [0.2, 0.5, 1, 2, 4, 8, 16, 30]) {
      const v = planImpact(hit({ impulse: 100, speed }));
      expect(v.length, `speed ${speed}`).toBeGreaterThan(0);
      expect(v[0].gain, `speed ${speed}`).toBeGreaterThanOrEqual(prev);
      prev = v[0].gain;
    }
  });

  it('a slow touch of a heavy body is quieter than a fast hit with the same energy, and brighter timbre needs speed', () => {
    // Same ½·J·v = 2000 J: a heavy body at 2 m/s and a light one at 20 m/s.
    const slow = impactLevels(2, 2000);
    const fast = impactLevels(20, 200);
    expect(impactEnergy(2, 2000)).toBe(impactEnergy(20, 200));
    expect(slow.level).toBeCloseTo(fast.level, 6);
    expect(slow.gainLevel).toBeLessThan(fast.gainLevel);
    expect(slow.timbre).toBeLessThan(fast.timbre);
  });

  it('makes no sound for resting contacts', () => {
    expect(planImpact(hit({ speed: 0.05, impulse: 1 }))).toEqual([]);
    expect(planImpact(hit({ speed: 5, impulse: 0.001 }))).toEqual([]);
    expect(planImpact(hit({ speed: 0, impulse: 0 }))).toEqual([]);
  });
});

describe('impact voices (FX-11: material classes, size-aware)', () => {
  it('a body on the ground rings and the slab thumps; two bodies both ring', () => {
    const ground = planImpact(hit());
    expect(ground.map((v) => v.role)).toEqual(['a', 'ground']);
    expect(ground[0].spec.preset).toBe('steel');
    expect(ground[1].spec.preset).toBe('ground');
    const pair = planImpact(hit({ matB: 'wood', sizeB: 1, massB: 40 }));
    expect(pair.map((v) => v.role)).toEqual(['a', 'b']);
    expect([pair[0].spec.preset, pair[1].spec.preset]).toEqual(['steel', 'wood']);
  });

  it('big bodies pitch lower: the fundamental falls monotonically with size, for every material', () => {
    for (const p of MATERIAL_PRESETS) {
      let prev = Infinity;
      for (const size of [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 10]) {
        const v = planImpact(hit({ matA: p.id, sizeA: size }))[0];
        const f = bucketPitch(v.spec.pitch) * v.rate;
        expect(f, `${p.id} ${size} m`).toBeLessThanOrEqual(prev * 1.0001);
        prev = f;
      }
    }
    expect(sizePitchFactor(REF_SIZE)).toBeCloseTo(1, 6);
    expect(sizePitchFactor(0.25)).toBeCloseTo(Math.pow(2, 0.85), 4);
    expect(sizePitchFactor(0.0001)).toBe(5);
    expect(sizePitchFactor(1000)).toBe(0.06);
  });

  it('the rendered fundamental follows the size: a 4 m steel beam clangs an octave-plus below a 0.5 m ball', () => {
    const small = planImpact(hit({ sizeA: 0.5 }))[0];
    const big = planImpact(hit({ sizeA: 4 }))[0];
    const fSmall = dominantFrequency(render(small.spec), SR, 60, 6000, 16384);
    const fBig = dominantFrequency(render(big.spec), SR, 60, 6000, 16384);
    expect(fSmall).toBeGreaterThan(700);
    expect(fSmall).toBeLessThan(900);
    expect(fBig).toBeLessThan(fSmall / 2.5);
  });

  it('quantises pitch to sixths of an octave and corrects the remainder with the playback rate', () => {
    for (const size of [0.07, 0.12, 0.33, 0.9, 2.2, 7]) {
      const v = planImpact(hit({ sizeA: size }))[0];
      expect(v.rate).toBeGreaterThan(0.93);
      expect(v.rate).toBeLessThan(1.07);
    }
    // Two sizes a few percent apart share a buffer.
    const a = planImpact(hit({ sizeA: 0.8 }))[0];
    const b = planImpact(hit({ sizeA: 0.82 }))[0];
    expect(a.key).toBe(b.key);
    expect(pitchBucket(1000)).toBe(Math.round(Math.log2(1000) * 6));
    expect(bucketPitch(pitchBucket(1000))).toBeCloseTo(1000, -2);
  });

  it('a light body hitting a heavy one rings loudly and the heavy one barely does', () => {
    expect(ringShare(1, 1000)).toBeGreaterThan(ringShare(1000, 1));
    expect(ringShare(5, 0)).toBeGreaterThan(ringShare(5, 5)); // against the immovable
    expect(ringShare(0, 5)).toBeLessThan(ringShare(5, 5));
    const v = planImpact(hit({ matB: 'steel', sizeB: 1, massA: 1, massB: 500 }));
    expect(v[0].gain).toBeGreaterThan(v[1].gain * 1.5);
  });

  it('every material preset gets a profile, a recipe and a finite, audible buffer', () => {
    for (const p of MATERIAL_PRESETS) {
      const profile = soundProfileFor(p.id);
      expect(SOUND_CLASSES).toContain(profile.cls);
      const buf = render(specOf(p.id));
      expect(buf.length).toBeGreaterThan(100);
      expect(buf.every(Number.isFinite), p.id).toBe(true);
      expect(rms(buf), p.id).toBeGreaterThan(0.01);
    }
    expect(soundProfileFor('ground')).toBe(GROUND_SOUND);
    // A preset nobody described is classified from its physical numbers instead of failing.
    expect(soundProfileFor('unobtainium').cls).toBe('plastic');
  });

  it('metal clangs with inharmonic partials: strong peaks at 2.756, 5.404 and 8.933 times the fundamental', () => {
    const spec = specOf('steel', { level: 3 });
    const buf = render(spec);
    const f0 = bucketPitch(spec.pitch);
    const mag = spectrum(buf, 32768);
    const at = (hz: number) => {
      const c = Math.round((hz * 32768) / SR);
      let m = 0;
      for (let i = c - 3; i <= c + 3; i++) m = Math.max(m, mag[i]);
      return m;
    };
    const floor = (hz: number) => at(hz * 1.19); // between partials
    for (const r of [1, 2.756, 5.404]) expect(at(f0 * r), `partial ${r}`).toBeGreaterThan(floor(f0 * r) * 4);
    // …and not harmonic: nothing special at the integer multiples 2× and 3× the fundamental.
    expect(at(f0 * 2)).toBeLessThan(at(f0 * 2.756) / 3);
    expect(at(f0 * 3)).toBeLessThan(at(f0 * 2.756) / 2);
  });

  it('each material rings as long as it should: steel and glass long, wood and stone short, lead and rubber dead', () => {
    const ring = (preset: string) => ringTime(render(specOf(preset)), SR);
    expect(ring('steel')).toBeGreaterThan(0.4);
    expect(ring('glass')).toBeGreaterThan(0.3);
    expect(ring('aluminum')).toBeGreaterThan(0.2);
    expect(ring('wood')).toBeLessThan(0.15);
    expect(ring('concrete')).toBeLessThan(0.1);
    expect(ring('lead')).toBeLessThan(0.06);
    expect(ring('rubber')).toBeLessThan(0.08);
    expect(ring('foam')).toBeLessThan(0.08);
    expect(ring('steel')).toBeGreaterThan(ring('wood') * 4);
    expect(ring('aluminum')).toBeLessThan(ring('steel'));
  });

  it('classes have distinct timbres: glass is bright, rubber and the ground are dull thuds, wood sits between', () => {
    const centroid = (preset: string) => spectralCentroid(render(specOf(preset)), SR);
    expect(centroid('glass')).toBeGreaterThan(centroid('steel'));
    expect(centroid('steel')).toBeGreaterThan(centroid('wood'));
    expect(centroid('wood')).toBeGreaterThan(centroid('rubber'));
    expect(centroid('rubber')).toBeGreaterThan(centroid('ground') * 0.7);
    expect(centroid('ground')).toBeLessThan(500);
    expect(centroid('foam')).toBeLessThan(centroid('plastic'));
  });

  it('rubber thuds with a falling pitch', () => {
    const buf = render(specOf('rubber'));
    const head = buf.subarray(0, Math.floor(0.012 * SR));
    const tail = buf.subarray(Math.floor(0.03 * SR), Math.floor(0.07 * SR));
    expect(dominantFrequency(head, SR, 60, 800, 4096)).toBeGreaterThan(dominantFrequency(tail, SR, 60, 800, 4096));
  });

  it('harder, faster hits are brighter: the timbre level opens the upper modes and the click', () => {
    const soft = spectralCentroid(render(specOf('steel', { level: 0 })), SR);
    const hard = spectralCentroid(render(specOf('steel', { level: 3 })), SR);
    expect(hard).toBeGreaterThan(soft * 1.15);
    expect(levelBucket(0)).toBe(0);
    expect(levelBucket(1)).toBe(3);
    expect(levelBucket(0.5)).toBe(2);
  });

  it('a soft partner damps the ring: steel dropped on foam is shorter and duller than on a hard floor', () => {
    const hard = render(specOf('steel', { damp: 0 }));
    const soft = render(specOf('steel', { damp: 3 }));
    expect(ringTime(soft, SR)).toBeLessThan(ringTime(hard, SR) * 0.6);
    expect(spectralCentroid(soft, SR)).toBeLessThan(spectralCentroid(hard, SR));
    // The planner picks the damping from the partner's hardness.
    const onFoam = planImpact(hit({ matB: 'foam', sizeB: 1, massB: 10 }))[0];
    const onSteel = planImpact(hit({ matB: 'steel', sizeB: 1, massB: 10 }))[0];
    expect(onFoam.spec.damp).toBeGreaterThan(onSteel.spec.damp);
  });

  it('brittle materials burst into fragments when hit very hard, others do not', () => {
    const gentle = planImpact(hit({ matA: 'glass', speed: 2, impulse: 8 }))[0];
    const smash = planImpact(hit({ matA: 'glass', speed: 14, impulse: 9000 }))[0];
    expect(gentle.spec.shatter).toBe(false);
    expect(smash.spec.shatter).toBe(true);
    expect(planImpact(hit({ matA: 'steel', speed: 14, impulse: 9000 }))[0].spec.shatter).toBe(false);
    expect(planImpact(hit({ matA: 'rubber', speed: 14, impulse: 9000 }))[0].spec.shatter).toBe(false);
    expect(planImpact(hit({ matA: 'concrete', speed: 14, impulse: 9000 }))[0].spec.shatter).toBe(true);
    // The spray is audible in the tail, long after the strike: bright, scattered energy where the plain chime has faded.
    const plain = render({ ...smash.spec, shatter: false });
    const spray = render(smash.spec);
    const window = (b: Float32Array) => b.subarray(Math.floor(0.15 * SR), Math.floor(0.4 * SR));
    expect(spectralCentroid(window(spray), SR)).toBeGreaterThan(spectralCentroid(window(plain), SR) * 1.05);
    const highShare = (b: Float32Array) => {
      const m = spectrum(b, 16384);
      const cut = Math.round((4000 * 16384) / SR);
      let hi = 0;
      let all = 0;
      for (let i = 1; i < m.length; i++) {
        all += m[i] * m[i];
        if (i >= cut) hi += m[i] * m[i];
      }
      return hi / all;
    };
    expect(highShare(window(spray))).toBeGreaterThan(highShare(window(plain)));
    expect(spray.length).toBeGreaterThanOrEqual(Math.floor(0.45 * SR));
  });

  it('is deterministic: a spec always renders the same samples', () => {
    const s = specOf('wood');
    expect(Buffer.from(render(s).buffer).equals(Buffer.from(render(s).buffer))).toBe(true);
    expect(impactKey(s)).toBe(impactKey({ ...s }));
    expect(impactKey(s)).not.toBe(impactKey({ ...s, level: 3 }));
    expect(impactKey(s)).not.toBe(impactKey({ ...s, shatter: true }));
  });

  it('can be extended with a material profile, and the extension can be removed again', () => {
    const profile: SoundProfile = { ...soundProfileFor('steel'), cls: 'metal', pitch: 123 };
    const off = registerSoundMaterial('unobtainium', profile);
    expect(soundProfileFor('unobtainium')).toBe(profile);
    expect(planImpact(hit({ matA: 'unobtainium', sizeA: REF_SIZE }))[0].spec.pitch).toBe(pitchBucket(123));
    off();
    expect(soundProfileFor('unobtainium')).not.toBe(profile);
  });
});

// -- events -------------------------------------------------------------------------------------------------------------

describe('event sounds (FX-15)', () => {
  const ids = [
    'explosion',
    'spawn',
    'break',
    'snap',
    'trampoline',
    'launch',
    'ui.select',
    'ui.place',
    'ui.delete',
    'ui.error',
    'ui.success',
    'ui.toggle',
  ];
  const def = (id: string): SoundEventDef => {
    const d = soundEvent(id);
    if (!d) throw new Error(`no sound event ${id}`);
    return d;
  };
  const buf = (id: string, p = {}) => renderRecipe(def(id).recipe(p), SR, hashString(def(id).key(p)));

  it('registers explosion, spawn, break, joint snap, trampoline, launch and the interface sounds', () => {
    for (const id of ids) expect(soundEvent(id), id).toBeDefined();
    expect(listSoundEvents().length).toBeGreaterThanOrEqual(ids.length);
  });

  it('renders every event to a finite, audible buffer of sensible length', () => {
    for (const id of ids) {
      const d = def(id);
      const p = { level: 0.6, size: 3, material: 'glass', speed: 12 };
      const b = renderRecipe(d.recipe(p), SR, 1);
      expect(b.every(Number.isFinite), id).toBe(true);
      expect(rms(b), id).toBeGreaterThan(0.02);
      expect(b.length / SR, id).toBeGreaterThan(0.05);
      expect(b.length / SR, id).toBeLessThan(4);
      expect(d.gain(p), id).toBeGreaterThan(0);
      expect(d.gain(p), id).toBeLessThan(0.7);
    }
  });

  it('the interface sounds are quiet and not positioned; the physical ones are positioned', () => {
    for (const id of ids.filter((i) => i.startsWith('ui.'))) {
      expect(def(id).category).toBe('ui');
      expect(def(id).spatial).toBe(false);
      expect(def(id).gain({})).toBeLessThan(0.12);
    }
    for (const id of ['explosion', 'spawn', 'break', 'snap', 'trampoline', 'launch']) {
      expect(def(id).category).toBe('impacts');
      expect(def(id).spatial).toBe(true);
    }
  });

  it('a bigger blast is lower and longer, and a stronger one louder', () => {
    const small = buf('explosion', { size: 2, level: 0.8 });
    const big = buf('explosion', { size: 20, level: 0.8 });
    expect(big.length).toBeGreaterThanOrEqual(small.length);
    // More of the energy is deep rumble: the share of the spectrum below 120 Hz grows with the radius.
    const lowShare = (b: Float32Array) => {
      const m = spectrum(b, 65536);
      const cut = Math.round((120 * 65536) / SR);
      let lo = 0;
      let all = 0;
      for (let i = 1; i < m.length; i++) {
        all += m[i] * m[i];
        if (i < cut) lo += m[i] * m[i];
      }
      return lo / all;
    };
    expect(lowShare(big)).toBeGreaterThan(lowShare(small));
    expect(dominantFrequency(big.subarray(0, 8192), SR, 15, 300, 16384)).toBeLessThan(
      dominantFrequency(small.subarray(0, 8192), SR, 15, 300, 16384),
    );
    expect(def('explosion').gain({ level: 1 })).toBeGreaterThan(def('explosion').gain({ level: 0.1 }));
    // The loudest sound of the set.
    expect(def('explosion').gain({ level: 1 })).toBeGreaterThan(def('launch').gain({ level: 1 }));
    // A boom has deep low end and a long tail.
    expect(ringTime(big, SR)).toBeGreaterThan(1);
  });

  it('a harder launch is brighter; the spawn pop is higher for small bodies', () => {
    expect(spectralCentroid(buf('launch', { level: 1 }), SR)).toBeGreaterThan(
      spectralCentroid(buf('launch', { level: 0.05 }), SR),
    );
    const small = buf('spawn', { size: 0.1 });
    const large = buf('spawn', { size: 4 });
    expect(spectralCentroid(small, SR)).toBeGreaterThan(spectralCentroid(large, SR));
  });

  it('breaking sounds differ by material: glass shatters high, stone crumbles low, wood cracks in between', () => {
    const c = (material: string) => spectralCentroid(buf('break', { material, size: 0.5, level: 0.7 }), SR);
    expect(c('glass')).toBeGreaterThan(c('wood'));
    expect(c('wood')).toBeGreaterThan(c('stone'));
    // Fragments keep falling for a while: breaking lasts longer than a plain knock.
    expect(buf('break', { material: 'glass', level: 0.7 }).length / SR).toBeGreaterThan(0.6);
    // A more violent break throws more fragments.
    expect(rms(buf('break', { material: 'glass', level: 1 }))).toBeGreaterThan(0);
  });

  it('the joint snap is a metallic twang that drops in pitch; the trampoline boings with a wobble', () => {
    const snap = buf('snap', { level: 0.5 });
    const head = dominantFrequency(snap.subarray(0, Math.floor(0.02 * SR)), SR, 100, 1500, 4096);
    const tail = dominantFrequency(snap.subarray(Math.floor(0.2 * SR), Math.floor(0.45 * SR)), SR, 100, 1500, 16384);
    expect(head).toBeGreaterThan(tail);
    expect(ringTime(snap, SR)).toBeGreaterThan(0.2);
    const boing = buf('trampoline', { level: 0.5 });
    expect(boing.length / SR).toBeGreaterThan(0.5);
    // Stronger bounce, higher boing.
    expect(dominantFrequency(buf('trampoline', { level: 1 }), SR, 80, 600, 16384)).toBeGreaterThan(
      dominantFrequency(buf('trampoline', { level: 0 }), SR, 80, 600, 16384),
    );
  });

  it('error is lower than success; place rises, delete falls', () => {
    expect(dominantFrequency(buf('ui.error'), SR, 80, 3000, 16384)).toBeLessThan(
      dominantFrequency(buf('ui.success'), SR, 80, 3000, 16384),
    );
    const half = (b: Float32Array, i: number) =>
      b.subarray(i * Math.floor(b.length / 2), (i + 1) * Math.floor(b.length / 2));
    const place = buf('ui.place');
    const del = buf('ui.delete');
    // Notes: place climbs from 523 to 784 Hz, delete falls from 440 to 294 Hz.
    expect(dominantFrequency(place.subarray(Math.floor(0.08 * SR)), SR, 300, 1200, 16384)).toBeGreaterThan(
      dominantFrequency(place.subarray(0, Math.floor(0.045 * SR)), SR, 300, 1200, 4096),
    );
    expect(dominantFrequency(del.subarray(Math.floor(0.09 * SR)), SR, 150, 800, 16384)).toBeLessThan(
      dominantFrequency(del.subarray(0, Math.floor(0.05 * SR)), SR, 150, 800, 4096),
    );
    expect(half(place, 0).length).toBeGreaterThan(0);
  });

  it('quantises event parameters so a handful of buffers cover every request', () => {
    const d = def('explosion');
    expect(d.key({ size: 7, level: 0.52 })).toBe(d.key({ size: 7.3, level: 0.55 }));
    expect(d.key({ size: 7, level: 0.1 })).not.toBe(d.key({ size: 7, level: 0.9 }));
    expect(d.key({ size: 2 })).not.toBe(d.key({ size: 20 }));
    expect(def('break').key({ material: 'glass' })).not.toBe(def('break').key({ material: 'wood' }));
  });

  it('accepts new events and refuses malformed or duplicate ones', () => {
    const mk = (id: string): SoundEventDef => ({
      id,
      label: 'Beep',
      category: 'ui',
      spatial: false,
      key: () => `u|${id}`,
      gain: () => 0.1,
      recipe: () => ({ duration: 0.1, modes: [{ freq: 1000, gain: 1, t60: 0.05 }] }),
    });
    const off = registerSoundEvent(mk('test.beep'));
    expect(soundEvent('test.beep')).toBeDefined();
    expect(() => registerSoundEvent(mk('test.beep'))).toThrow(/already registered/);
    expect(() => registerSoundEvent(mk('Bad Id'))).toThrow(/malformed/);
    expect(() =>
      registerSoundEvent({ ...mk('test.nokey'), key: undefined as unknown as SoundEventDef['key'] }),
    ).toThrow(/needs key/);
    off();
    expect(soundEvent('test.beep')).toBeUndefined();
  });
});

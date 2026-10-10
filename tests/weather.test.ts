import { describe, expect, it } from 'vitest';
import { newDocument } from '../src/model/factory';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { sanitizeWeather } from '../src/model/sanitize/weather';
import { defaultWeather, effectiveWet, weatherWind } from '../src/model/weather';
import {
  FLASH_CAP,
  KIND_FACTOR,
  LightningScheduler,
  TIER_PARTICLES,
  mulberry32,
  nextStrike,
  particleCap,
  particleCount,
  streakTilt,
  strikeLevel,
  windDrift,
} from '../src/render/weatherLogic';
import { QUALITY_TIERS } from '../src/render/graphics';

describe('weather sanitiser (VZ-23)', () => {
  it('leaves a scene without weather without a weather block', () => {
    const doc = sanitizeDocument(newDocument());
    expect('weather' in doc.settings).toBe(false);
    expect(sanitizeWeather(undefined)).toBeUndefined();
    expect(sanitizeWeather('rain')).toBeUndefined();
    expect(sanitizeWeather([1, 2])).toBeUndefined();
  });

  it('repairs junk to clear weather and clamps ranges', () => {
    const w = sanitizeWeather({
      kind: 'hail',
      intensity: 9,
      lightning: 'yes',
      wet: -3,
      windSpeed: 1e9,
      windDir: -90,
    });
    expect(w).toEqual({ kind: 'none', intensity: 1, lightning: false, wet: 0, windSpeed: 40, windDir: 270 });
    expect(sanitizeWeather({ intensity: NaN, windDir: Infinity })).toEqual(defaultWeather());
  });

  it('round-trips through save and load', () => {
    const doc = newDocument();
    doc.settings.weather = { kind: 'snow', intensity: 0.7, lightning: true, wet: 0.25, windSpeed: 12, windDir: 135 };
    const back = parseDocument(serializeDocument(doc));
    expect(back.settings.weather).toEqual(doc.settings.weather);
  });

  it('repairs a hand-edited weather block in a loaded file', () => {
    const doc = newDocument();
    (doc.settings as unknown as Record<string, unknown>).weather = { kind: 'rain', intensity: 'lots' };
    const back = parseDocument(serializeDocument(doc));
    expect(back.settings.weather).toMatchObject({ kind: 'rain', intensity: 0.5, lightning: false });
  });
});

describe('weather helpers (VZ-23)', () => {
  it('turns speed and heading into one world wind vector', () => {
    const w = { ...defaultWeather(), windSpeed: 10, windDir: 0 };
    const v = weatherWind(w);
    expect(v[0]).toBeCloseTo(0);
    expect(v[2]).toBeCloseTo(-10);
    const e = weatherWind({ ...w, windDir: 90 });
    expect(e[0]).toBeCloseTo(10);
    expect(e[2]).toBeCloseTo(0);
    expect(weatherWind(undefined)).toEqual([0, 0, 0]);
  });

  it('rain wets the surfaces by itself, the slider can add more', () => {
    expect(effectiveWet(undefined)).toBe(0);
    expect(effectiveWet({ ...defaultWeather(), kind: 'snow' })).toBe(0);
    expect(effectiveWet({ ...defaultWeather(), kind: 'rain', intensity: 1 })).toBe(1);
    expect(effectiveWet({ ...defaultWeather(), kind: 'rain', intensity: 0 })).toBeCloseTo(0.3);
    expect(effectiveWet({ ...defaultWeather(), kind: 'snow', wet: 0.6 })).toBeCloseTo(0.6);
  });

  it('budgets particles per quality tier and scales them by intensity', () => {
    let prev = 0;
    for (const t of QUALITY_TIERS) {
      const cap = particleCap('rain', t);
      expect(cap).toBe(TIER_PARTICLES[t]);
      expect(cap).toBeGreaterThan(prev);
      prev = cap;
      for (const kind of ['rain', 'snow', 'leaves', 'dust'] as const) {
        expect(particleCount(kind, t, 1)).toBe(particleCap(kind, t));
        expect(particleCount(kind, t, 0.5)).toBeLessThanOrEqual(particleCap(kind, t));
        expect(particleCount(kind, t, 0)).toBe(0);
        expect(particleCount(kind, t, 7)).toBeLessThanOrEqual(particleCap(kind, t));
        expect(particleCount(kind, t, NaN)).toBe(0);
      }
    }
    expect(particleCount('none', 'ultra', 1)).toBe(0);
    expect(particleCap('rain', 'low')).toBeLessThanOrEqual(1500);
    expect(KIND_FACTOR.leaves).toBeLessThan(KIND_FACTOR.rain);
  });

  it('maps wind to drift: rain lags the air, snow follows it, clear sky has none', () => {
    const wind: [number, number, number] = [8, 0, -4];
    expect(windDrift('snow', wind)).toEqual([8, -4]);
    const r = windDrift('rain', wind);
    expect(r[0]).toBeCloseTo(5.6);
    expect(r[1]).toBeCloseTo(-2.8);
    expect(windDrift('none', wind)).toEqual([0, 0]);
    expect(streakTilt('rain', [0, 0, 0])).toBe(0);
    expect(streakTilt('rain', [20, 0, 0])).toBeGreaterThan(streakTilt('rain', [5, 0, 0]));
  });
});

describe('lightning scheduler (VZ-23)', () => {
  const run = (seed: number, intensity: number, seconds: number) => {
    const s = new LightningScheduler(seed, intensity);
    const trace: number[] = [];
    for (let t = 0; t < seconds; t += 1 / 30) trace.push(s.update(1 / 30));
    return { trace, strikes: s.strikes };
  };

  it('is deterministic for a seed and differs between seeds', () => {
    const a = run(7, 0.8, 120);
    const b = run(7, 0.8, 120);
    expect(b.trace).toEqual(a.trace);
    expect(a.strikes).toBeGreaterThan(0);
    expect(run(8, 0.8, 120).trace).not.toEqual(a.trace);
  });

  it('strikes more often in heavier weather and never flashes beyond the cap', () => {
    const light = run(3, 0.05, 600);
    const storm = run(3, 1, 600);
    expect(storm.strikes).toBeGreaterThan(light.strikes);
    for (const v of storm.trace) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(FLASH_CAP).toBeLessThanOrEqual(0.5);
  });

  it('a strike is a bright pulse that decays to nothing', () => {
    const strike = nextStrike(mulberry32(1), 0.5);
    expect(strikeLevel(strike, 0)).toBeGreaterThan(0.5);
    expect(strikeLevel(strike, 5)).toBeLessThan(0.01);
    const s = new LightningScheduler(1, 0.5);
    s.trigger();
    expect(s.update(0.01)).toBeGreaterThan(0.3);
    expect(s.strikes).toBe(1);
  });

  it('reseed replays the same sky', () => {
    const s = new LightningScheduler(5, 0.6);
    const first: number[] = [];
    for (let i = 0; i < 900; i++) first.push(s.update(1 / 30));
    s.reseed(5);
    const second: number[] = [];
    for (let i = 0; i < 900; i++) second.push(s.update(1 / 30));
    expect(second).toEqual(first);
  });
});

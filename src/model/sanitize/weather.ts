/** VZ-23: sanitiser for a scene's weather block. Anything unusable falls back to clear weather. */
import { clamp } from '../../core/math';
import type { SceneSettings, WeatherSettings } from '../types';
import { defaultWeather, MAX_WIND, WEATHER_KINDS } from '../weather';
import { bool, num, oneOf } from './primitives';

/** `undefined` when the scene has no weather block (it stays absent, so old documents round-trip unchanged). */
export function sanitizeWeather(raw: unknown): WeatherSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const d = defaultWeather();
  return {
    kind: oneOf(r.kind, WEATHER_KINDS, d.kind),
    intensity: clamp(num(r.intensity, d.intensity), 0, 1),
    lightning: bool(r.lightning, d.lightning),
    wet: clamp(num(r.wet, d.wet), 0, 1),
    windSpeed: clamp(num(r.windSpeed, d.windSpeed), 0, MAX_WIND),
    windDir: ((num(r.windDir, d.windDir) % 360) + 360) % 360,
  };
}

/** For spreading into the settings object. */
export function sanitizeWeatherField(raw: unknown): Pick<SceneSettings, 'weather'> | Record<string, never> {
  const w = sanitizeWeather(raw);
  return w ? { weather: w } : {};
}

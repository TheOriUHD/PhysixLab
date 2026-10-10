/** VZ-23: pure weather helpers shared by the model, the renderer and the UI (no three.js, no DOM). */
import type { Vec3 } from '../core/math';
import type { WeatherKind, WeatherSettings } from './types';

export const WEATHER_KINDS: readonly WeatherKind[] = ['none', 'rain', 'snow', 'leaves', 'dust'];
export const WEATHER_LABELS: Record<WeatherKind, string> = {
  none: 'Clear',
  rain: 'Rain',
  snow: 'Snow',
  leaves: 'Falling leaves',
  dust: 'Floating dust',
};
export const MAX_WIND = 40;

export function defaultWeather(): WeatherSettings {
  return { kind: 'none', intensity: 0.5, lightning: false, wet: 0, windSpeed: 0, windDir: 0 };
}

/** The scene wind, m/s, as a world vector (horizontal). Absent weather = no wind. */
export function weatherWind(w: WeatherSettings | undefined, out: Vec3 = [0, 0, 0]): Vec3 {
  if (!w || w.windSpeed <= 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const a = (w.windDir * Math.PI) / 180;
  out[0] = Math.sin(a) * w.windSpeed;
  out[1] = 0;
  out[2] = -Math.cos(a) * w.windSpeed;
  return out;
}

/** How wet surfaces look, 0–1: the wet slider, but rain wets at least as much as 0.3 + 0.7 × its intensity. */
export function effectiveWet(w: WeatherSettings | undefined): number {
  if (!w) return 0;
  const rain = w.kind === 'rain' ? 0.3 + 0.7 * w.intensity : 0;
  return Math.max(0, Math.min(1, Math.max(w.wet, rain)));
}

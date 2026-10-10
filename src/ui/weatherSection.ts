/**
 * The “Weather” section of the World tab (VZ-23): rain, snow, falling leaves or floating dust over the scene, with an
 * intensity slider, the scene wind they drift with, lightning and the wet look. Stored in the document
 * (`settings.weather`), so edits are undoable and saved with the scene.
 */
import type { App } from '../app/app';
import type { WeatherKind, WeatherSettings } from '../model/types';
import { defaultWeather, MAX_WIND, WEATHER_KINDS, WEATHER_LABELS } from '../model/weather';
import { button, row, section, selectField, sliderField, toggleField } from './controls';
import { h } from './dom';

export interface WeatherSection {
  el: HTMLElement;
  refresh: () => void;
}

export function buildWeatherSection(app: App): WeatherSection {
  const { store } = app;
  const cur = (): WeatherSettings => store.settings.weather ?? defaultWeather();
  const write = (patch: Partial<WeatherSettings>, label: string) =>
    store.updateSettings({ weather: { ...cur(), ...patch } }, label);
  const grouped = (label: string) => ({ onStart: () => store.begin(label), onEnd: () => store.end() });
  const upd: (() => void)[] = [];

  const kind = selectField<WeatherKind>({
    options: WEATHER_KINDS.map((k) => ({ value: k, label: WEATHER_LABELS[k] })),
    onChange: (v) => write({ kind: v }, `Weather: ${WEATHER_LABELS[v].toLowerCase()}`),
  });
  upd.push(() => kind.set(cur().kind));

  const intensity = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    ...grouped('Weather intensity'),
    onChange: (v) => write({ intensity: v }, 'Weather intensity'),
  });
  upd.push(() => intensity.set(cur().intensity));

  const windSpeed = sliderField({
    min: 0,
    max: MAX_WIND,
    step: 0.5,
    digits: 1,
    unit: 'm/s',
    ...grouped('Wind speed'),
    onChange: (v) => write({ windSpeed: v }, 'Wind speed'),
  });
  upd.push(() => windSpeed.set(cur().windSpeed));
  const windDir = sliderField({
    min: 0,
    max: 360,
    step: 5,
    digits: 0,
    unit: '°',
    ...grouped('Wind direction'),
    onChange: (v) => write({ windDir: v % 360 }, 'Wind direction'),
  });
  upd.push(() => windDir.set(cur().windDir));

  const lightning = toggleField({
    label: 'Lightning',
    title: 'Random flashes, more often in heavier weather (a dim single flash with “reduce motion”)',
    onChange: (v) => write({ lightning: v }, v ? 'Enable lightning' : 'Disable lightning'),
  });
  const strike = button('Strike', () => app.viewport.weather.triggerLightning(), {
    title: 'Preview a lightning flash now',
  });
  upd.push(() => {
    lightning.set(cur().lightning);
    strike.disabled = !cur().lightning || cur().kind === 'none';
  });

  const wet = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    ...grouped('Wet surfaces'),
    onChange: (v) => write({ wet: v }, 'Wet surfaces'),
  });
  upd.push(() => wet.set(cur().wet));

  const el = section(
    'Weather',
    [
      row('Kind', kind.el),
      row('Intensity', intensity.el, 'Particle count (capped by the graphics quality) and lightning rate'),
      row(
        'Wind speed',
        windSpeed.el,
        'The scene wind: weather particles and effect sparks, smoke and dust drift with it',
      ),
      row('Wind direction', windDir.el, '0° blows towards −Z, 90° towards +X'),
      row(
        'Wet surfaces',
        wet.el,
        'Lower roughness and a darker ground. Rain wets by itself, in proportion to its intensity',
      ),
      row('', [lightning.el, strike]),
      h(
        'p',
        { class: 'hint-text' },
        'Weather is part of the scene file. Particle counts follow the quality tier (Low draws far fewer). The wet look only changes how things are drawn, never the scene.',
      ),
    ],
    { id: 'world-weather' },
  );
  return { el, refresh: () => upd.forEach((u) => u()) };
}

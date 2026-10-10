// ── VZ-23: weather commands for the palette (the controls live in the World tab) ──
import { registerCommand } from '../../app/registry';
import type { App } from '../../app/app';
import type { WeatherKind } from '../../model/types';
import { defaultWeather, WEATHER_LABELS } from '../../model/weather';

const KINDS: WeatherKind[] = ['rain', 'snow', 'leaves', 'dust', 'none'];

function setKind(app: App, kind: WeatherKind): void {
  const cur = app.store.settings.weather ?? defaultWeather();
  app.store.updateSettings({ weather: { ...cur, kind } }, `Weather: ${WEATHER_LABELS[kind].toLowerCase()}`);
}

for (const kind of KINDS) {
  registerCommand({
    id: `weather.${kind}`,
    label: kind === 'none' ? 'Weather: clear' : `Weather: ${kind}`,
    category: 'View',
    setting: true,
    description:
      kind === 'none'
        ? 'Remove the weather from this scene'
        : `Make it ${kind === 'leaves' ? 'leaf-fall' : kind} in this scene (intensity, wind and lightning in the World tab)`,
    keywords: ['weather', 'rain', 'snow', 'leaves', 'dust', 'storm', 'wind', 'lightning', 'wet', 'clear'],
    checked: (app) => (app.store.settings.weather?.kind ?? 'none') === kind,
    run: ({ app }) => setKind(app, kind),
  });
}

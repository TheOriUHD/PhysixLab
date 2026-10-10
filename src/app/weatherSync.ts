/** VZ-23: scene weather → the weather renderer (particles, wet look, lightning) and the effects package's wind. */
import { weatherWind } from '../model/weather';
import type { App } from './app';
import { onReducedMotionChange, prefersReducedMotion } from './fx/motion';

const watched = new WeakSet<App>();

/** Push the document's weather into the viewport. Called when a scene loads and when its settings change. */
export function applyWeather(app: App): void {
  if (!watched.has(app)) {
    watched.add(app);
    watchWeatherMotion(app);
  }
  const s = app.store.settings;
  app.viewport.weather.setSettings(s.weather, s.seed);
  app.fx.setEnvironment({ wind: weatherWind(s.weather) }); // the one scene wind: sparks, smoke and dust drift with it
  app.viewport.needsRender = true;
}

/** Reduced-motion users get a dim, single-flash lightning overlay (the particles are unaffected). */
function watchWeatherMotion(app: App): void {
  const apply = () => app.viewport.weather.setFlashScale(prefersReducedMotion() ? 0.25 : 1);
  apply();
  onReducedMotionChange(apply);
}

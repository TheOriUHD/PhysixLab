/**
 * VZ-A wiring: connects the material builder to the document's assets and (later in this file) the environment
 * controller to the scene settings and the user's graphics preferences.
 */
import { isBody } from '../model/types';
import { materialContext } from '../render/materialBuild';
import type { App } from './app';

export class VisualsSync {
  constructor(app: App) {
    const { store } = app;
    materialContext.asset = (id) => {
      const a = store.getAsset(id);
      return a && a.kind === 'texture' ? a : undefined;
    };
    materialContext.invalidate = () => {
      app.invalidateColors();
      app.viewport.needsRender = true;
    };
    const env = app.viewport.env;
    env.assetLookup = (id) => {
      const a = store.getAsset(id);
      return a && a.kind === 'blob' ? a : undefined;
    };
    const applyEnv = () => env.apply(store.settings.environment, store.settings.ground);
    applyEnv();
    store.on('change', (c) => {
      if (c.type === 'reset' || (c.type === 'settings' && (c.keys.has('environment') || c.keys.has('ground')))) applyEnv();
      // A texture asset arrived / changed: bodies that use textures pick it up.
      if (c.type === 'assets') {
        for (const v of app.bodies.views.values()) if (isBody(v.def) && v.def.material.texture) v.applyMaterial(v.def);
        if (store.settings.environment.sky === 'hdri') applyEnv();
        app.viewport.needsRender = true;
      }
    });
  }
}

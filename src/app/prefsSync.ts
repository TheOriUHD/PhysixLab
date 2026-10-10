/** Preferences → renderer / simulation / gizmo: applies stored preferences and reacts to changes. */
import type { App } from './app';
import { hintForMode, toolModes } from './registry/tools';

export class PrefsSync {
  constructor(private app: App) {}

  applyAll(): void {
    const { app } = this;
    const p = app.prefs.value;
    app.viewport.setQuality(p.quality);
    app.bodies.mode = p.colorMode;
    app.joints.visible = p.showJoints;
    app.overlays.options = { ...p.overlays };
    app.sim.timeScale = p.timeScale;
    app.sim.wantContacts = p.overlays.contacts;
    app.gizmo.setSpace(p.space);
    this.applySnaps();
    app.gizmos.updateMode();
    app.viewport.dom.classList.toggle('tool-joint', p.tool === 'joint');
  }

  onChanged(keys: string[]): void {
    const { app } = this;
    const p = app.prefs.value;
    for (const k of keys) {
      switch (k) {
        case 'quality':
          app.viewport.setQuality(p.quality);
          break;
        case 'colorMode':
          app.bodies.mode = p.colorMode;
          break;
        case 'showJoints':
          app.joints.visible = p.showJoints;
          break;
        case 'overlays':
          app.overlays.options = { ...p.overlays };
          app.sim.wantContacts = p.overlays.contacts;
          if (p.overlays.trails === 'off') app.overlays.clearTrails();
          break;
        case 'timeScale':
          app.sim.timeScale = p.timeScale;
          break;
        case 'space':
          app.gizmo.setSpace(p.space);
          break;
        case 'snap':
        case 'snapGrid':
        case 'snapAngle':
          this.applySnaps();
          break;
        case 'tool':
          this.onToolChanged();
          break;
        case 'gizmo':
          app.gizmos.updateMode();
          break;
      }
    }
    app.invalidateColors();
  }

  private applySnaps(): void {
    const { app } = this;
    const p = app.prefs.value;
    app.gizmo.setSnaps(p.snap ? p.snapGrid : 0, p.snap ? p.snapAngle : 0, p.snap ? 0.05 : 0);
  }

  private onToolChanged(): void {
    const { app } = this;
    const t = app.prefs.value.tool;
    const cls = app.viewport.dom.classList;
    for (const c of toolModes()) cls.toggle(`tool-${c}`, c === t);
    app.cancelJointDraft();
    if (t !== 'measure') app.clearMeasure();
    app.gizmos.updateMode();
    this.updateToolHint();
  }

  /** Tool-specific hint line (from the tool registry); the input controller overrides it while a gesture is in progress. */
  updateToolHint(): void {
    const { app } = this;
    app.setHint(hintForMode(app.prefs.value.tool, app));
  }
}

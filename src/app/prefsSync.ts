/** Preferences → renderer / simulation / gizmo: applies stored preferences and reacts to changes. */
import { QUALITY_CHOICES } from '../render/graphics';
import type { App } from './app';

/** `?instancing=0`: every body gets its own mesh (the draw-call benchmark baseline). */
const URL_NO_INSTANCING = new URLSearchParams(location.search).get('instancing') === '0';
import { hintForMode, toolModes } from './registry/tools';
// -- ED-A arrange: pivot modes --
import { initCursorView } from './edit/cursorView';

export class PrefsSync {
  constructor(private app: App) {}

  applyAll(): void {
    const { app } = this;
    const p = app.prefs.value;
    // -- VZ-B: `?quality=auto|low|medium|high|ultra` overrides the stored tier for this session (fast headless tests) --
    const urlQ = new URLSearchParams(location.search).get('quality');
    const urlTier = QUALITY_CHOICES.find((q) => q === urlQ);
    app.viewport.setQuality(urlTier ?? p.quality);
    app.viewport.setGraphics(p.graphics); // -- VZ-B --
    app.viewport.setHighlightStyle(p.highlight);
    app.bodies.lodEnabled = p.graphics.lod;
    app.bodies.setInstancing(p.graphics.instancing && !URL_NO_INSTANCING);
    app.bodies.mode = p.colorMode;
    app.joints.visible = p.showJoints;
    app.overlays.options = { ...p.overlays };
    app.joints.stressOverlay = p.overlays.stress;
    app.sim.client.watchLoads(p.overlays.stress);
    app.sim.timeScale = p.timeScale;
    app.sim.wantContacts = p.overlays.contacts;
    app.gizmo.setSpace(p.space);
    initCursorView(app); // -- ED-A arrange: the 3D cursor marker --
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
        case 'highlight':
          app.viewport.setHighlightStyle(p.highlight);
          app.viewSync.refreshOutline();
          break;
        case 'graphics':
          app.bodies.lodEnabled = p.graphics.lod;
          app.viewport.setGraphics(p.graphics);
          app.bodies.setInstancing(p.graphics.instancing && !URL_NO_INSTANCING);
          app.invalidateColors();
          break;
        case 'colorMode':
          app.bodies.mode = p.colorMode;
          break;
        case 'showJoints':
          app.joints.visible = p.showJoints;
          break;
        case 'overlays':
          app.overlays.options = { ...p.overlays };
          app.joints.stressOverlay = p.overlays.stress;
          app.sim.client.watchLoads(p.overlays.stress);
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
        case 'pivotMode': // -- ED-A arrange --
          app.gizmos.refresh();
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

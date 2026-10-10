/**
 * Presentation / photo mode controller (UI-41): hides the whole interface and restores it, shows the caption and the
 * auto-fading exit hint, runs the turntable, applies camera / lens / depth-of-field / lighting presets through the viewport's real
 * parameters, and captures the viewport as a PNG at 1×, 2× or 4× its size.
 *
 * One instance per `App` (`getPresenter(app)`); the panel, the commands and the end-to-end tests all go through it.
 */
import { Box3, Vector3 } from 'three';
import { ENV_PRESET_BY_ID } from '../../render/envPresets';
import { cloneGraphics } from '../../render/graphics';
import type { App } from '../../app/app';
import { browserStorage, parseJson, type KeyValueStore } from '../qol/storage';
import {
  CAMERA_PRESETS,
  DOF_PRESETS,
  captionOpacity,
  captureFileName,
  DEFAULT_PRESENT,
  effectiveScale,
  fitDistance,
  fovForMm,
  presetPose,
  sanitizePresent,
  turntableStep,
  type CameraPresetId,
  type CaptionPos,
  type DofPresetId,
  type PresentOptions,
  type Vec3,
} from './model';

const STORAGE_KEY = 'physixlab:present:v1';
const HIDDEN = 'qol-hidden';

export interface CaptureResult {
  blob: Blob;
  width: number;
  height: number;
  /** Scale actually used (smaller than requested when the image would not fit the GPU). */
  scale: number;
  reduced: boolean;
  name: string;
}

// Keyed by the scene store: `window.physixlab` is a proxy of the App (src/api), but both share one store.
const instances = new WeakMap<object, Presenter>();

export function getPresenter(app: App, storage: KeyValueStore = browserStorage()): Presenter {
  let p = instances.get(app.store);
  if (!p) {
    p = new Presenter(app, storage);
    instances.set(app.store, p);
  }
  return p;
}

export class Presenter {
  options: PresentOptions;
  active = false;
  turning = false;
  lastCapture: CaptureResult | null = null;
  private listeners = new Set<() => void>();
  private hidden: Element[] = [];
  private hint: HTMLElement | null = null;
  private hintTimer = 0;
  private caption: HTMLElement | null = null;
  private startedAt = 0;
  private raf = 0;
  private readonly tmp = new Vector3();

  constructor(
    readonly app: App,
    private readonly storage: KeyValueStore,
  ) {
    this.options = sanitizePresent(parseJson(storage.getItem(STORAGE_KEY)));
    app.on('frame', ({ dt }) => this.turntable(dt));
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.active && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation(); // not also "cancel tool / deselect"
          this.exit();
        }
      },
      true,
    );
    // Re-apply a remembered lens (a real camera setting that persists like the options).
    if (this.options.fov !== DEFAULT_PRESENT.fov) app.viewport.setFov(this.options.fov);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ---- options -------------------------------------------------------------------------------------------------

  set(patch: Partial<PresentOptions>): void {
    const prev = this.options;
    this.options = sanitizePresent({ ...prev, ...patch });
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.options));
    if (this.options.fov !== prev.fov) this.app.viewport.setFov(this.options.fov);
    if (this.active) {
      this.renderCaption();
      this.toggleToasts();
      this.syncJoints();
    }
    this.emit();
  }

  /** Joint markers follow the View → Joints preference, except while presenting with "hide joints" on. */
  private syncJoints(): void {
    const { app } = this;
    app.joints.visible = app.prefs.value.showJoints && !(this.active && this.options.hideJoints);
    app.viewport.needsRender = true;
  }

  /**
   * Light the scene with one of the environment presets (sky, sun direction, image-based light). This is the scene's
   * own environment setting (package VZ), so it is saved with the scene and Undo works; fine tuning is in the
   * World tab.
   */
  setEnvironment(id: string): void {
    const preset = ENV_PRESET_BY_ID.get(id);
    if (!preset) return;
    const { store } = this.app;
    const env = store.settings.environment;
    store.updateSettings(
      {
        environment: {
          ...env,
          sky: preset.id,
          sun: { ...env.sun, azimuth: preset.sunAzimuth, elevation: preset.sunElevation },
        },
      },
      `Environment: ${preset.label}`,
    );
    this.emit();
  }

  /** Set the renderer's depth-of-field pass through the same graphics options the Graphics section edits. */
  setDof(id: DofPresetId): void {
    const preset = DOF_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const g = cloneGraphics(this.app.prefs.value.graphics);
    g.dof = { ...g.dof, on: preset.on, focusMode: 'target', aperture: preset.aperture, maxBlur: preset.maxBlur };
    this.app.prefs.set({ graphics: g });
    this.emit();
  }

  setLens(mm: number): void {
    this.set({ fov: Math.round(fovForMm(mm) * 10) / 10 });
  }

  // ---- presenting ----------------------------------------------------------------------------------------------

  toggle(): void {
    if (this.active) this.exit();
    else this.enter();
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.hideChrome();
    document.body.classList.add('qol-presenting');
    this.app.viewport.setPhotoMode(true);
    this.syncJoints();
    this.startedAt = performance.now();
    this.renderCaption();
    this.showHint();
    window.addEventListener('pointermove', this.onMove);
    this.loopCaption();
    if (this.options.turntableOnEnter) this.setTurntable(true);
    this.emit();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    for (const el of this.hidden) el.classList.remove(HIDDEN);
    this.hidden = [];
    document.body.classList.remove('qol-presenting');
    this.app.viewport.setPhotoMode(false);
    this.syncJoints();
    window.removeEventListener('pointermove', this.onMove);
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.hintTimer);
    this.hint?.remove();
    this.hint = null;
    this.caption?.remove();
    this.caption = null;
    if (this.options.turntableOnEnter) this.setTurntable(false);
    this.emit();
  }

  /**
   * Hide everything in the page that is not the viewport or one of its ancestors. Done generically (by walking up
   * from the viewport) so panels, docks and floating windows added later by other packages are hidden too.
   */
  private hideChrome(): void {
    const keep = new Set<Element>();
    for (let n: Element | null = this.app.viewport.container; n; n = n.parentElement) keep.add(n);
    const host = this.app.viewport.container;
    const hideChildren = (parent: Element) => {
      for (const child of Array.from(parent.children)) {
        if (keep.has(child)) {
          if (child !== host) hideChildren(child);
          continue;
        }
        if (child.hasAttribute('data-qol') || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
        if (child.classList.contains(HIDDEN)) continue;
        child.classList.add(HIDDEN);
        this.hidden.push(child);
      }
    };
    hideChildren(document.body);
    this.toggleToasts();
  }

  private toggleToasts(): void {
    const toasts = document.querySelector('.toasts');
    if (!toasts) return;
    const show = this.options.showToasts;
    if (show && this.hidden.includes(toasts)) {
      toasts.classList.remove(HIDDEN);
      this.hidden = this.hidden.filter((x) => x !== toasts);
    } else if (!show && !toasts.classList.contains(HIDDEN)) {
      toasts.classList.add(HIDDEN);
      this.hidden.push(toasts);
    }
  }

  private readonly onMove = (): void => this.showHint();

  private showHint(): void {
    if (!this.hint) {
      const hint = document.createElement('button');
      hint.type = 'button';
      hint.className = 'qol-exit-hint';
      hint.dataset.qol = 'exit-hint';
      hint.innerHTML = 'Exit presentation <kbd>Esc</kbd>';
      hint.addEventListener('click', () => this.exit());
      document.body.appendChild(hint);
      this.hint = hint;
      // Force a style flush so the fade-in transition runs.
      void hint.offsetWidth;
    }
    this.hint.classList.add('show');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hint?.classList.remove('show'), 2600);
  }

  // ---- caption -------------------------------------------------------------------------------------------------

  private renderCaption(): void {
    const o = this.options;
    if (!this.active || !o.captionOn || (!o.title && !o.subtitle)) {
      this.caption?.remove();
      this.caption = null;
      return;
    }
    if (!this.caption) {
      this.caption = document.createElement('div');
      this.caption.dataset.qol = 'caption';
      document.body.appendChild(this.caption);
    }
    const el = this.caption;
    el.className = `qol-caption pos-${o.captionPos}`;
    el.style.setProperty('--cap-size', `${o.captionSize}px`);
    el.replaceChildren();
    if (o.title) {
      const t = document.createElement('div');
      t.className = 'qol-cap-title';
      t.textContent = o.title;
      el.appendChild(t);
    }
    if (o.subtitle) {
      const s = document.createElement('div');
      s.className = 'qol-cap-sub';
      s.textContent = o.subtitle;
      el.appendChild(s);
    }
    el.style.opacity = String(captionOpacity((performance.now() - this.startedAt) / 1000, o.captionHold, 0.8));
  }

  private loopCaption(): void {
    const step = () => {
      if (!this.active) return;
      if (this.caption)
        this.caption.style.opacity = String(
          captionOpacity((performance.now() - this.startedAt) / 1000, this.options.captionHold, 0.8),
        );
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // ---- camera --------------------------------------------------------------------------------------------------

  /** Centre and bounding radius of the selection (or of the whole scene when nothing is selected). */
  subjectBounds(): { center: Vec3; radius: number } {
    const { app } = this;
    const box = new Box3();
    const ids = app.store.selection;
    const selected = new Set(ids);
    let any = false;
    for (const [id, v] of app.bodies.views) {
      if (selected.size ? !selected.has(id) : v.def.hidden) continue;
      box.expandByObject(v.mesh);
      any = true;
    }
    if (!any) return { center: [0, 1, 0], radius: 4 };
    const c = box.getCenter(this.tmp);
    const size = box.getSize(new Vector3());
    return { center: [c.x, c.y, c.z], radius: Math.max(0.5, size.length() / 2) };
  }

  cameraPreset(id: CameraPresetId): void {
    const preset = CAMERA_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const vp = this.app.viewport;
    const { center, radius } = this.subjectBounds();
    const pose = presetPose(preset, center, fitDistance(radius, vp.camera.fov));
    vp.flyTo(new Vector3(...pose.position), new Vector3(...pose.target), 0.6);
  }

  /** Turn the camera slowly around what the camera looks at (the orbit target). */
  setTurntable(on: boolean): void {
    this.turning = on;
    this.emit();
  }

  /** Fly to the selection (or the scene) and orbit around it. */
  orbitSelection(): void {
    const vp = this.app.viewport;
    const { center, radius } = this.subjectBounds();
    const dir = vp.camera.position.clone().sub(vp.controls.target);
    dir.y = Math.max(dir.y, 0.2 * dir.length());
    dir.setLength(fitDistance(radius, vp.camera.fov));
    vp.flyTo(new Vector3(...center).add(dir), new Vector3(...center), 0.6);
    this.setTurntable(true);
  }

  private turntable(dt: number): void {
    if (!this.turning) return;
    const vp = this.app.viewport;
    const t = vp.controls.target;
    const p = vp.camera.position;
    const next = turntableStep([p.x, p.y, p.z], [t.x, t.y, t.z], this.options.turntableSpeed, dt);
    p.x = next.x;
    p.z = next.z;
    vp.needsRender = true;
  }

  // ---- capture -------------------------------------------------------------------------------------------------

  /** Render the viewport at `scale` × its size and encode it as a PNG. Does not download; see `download`. */
  async capture(scale: number = this.options.captureScale): Promise<CaptureResult> {
    const vp = this.app.viewport;
    const { width: cw, height: ch } = vp.cssSize;
    const eff = effectiveScale(cw, ch, scale, vp.maxCaptureEdge);
    const prevQuality = vp.currentQuality;
    const boost = this.options.captureBest && prevQuality !== 'ultra';
    if (boost) vp.setQuality('ultra');
    const joints = this.app.joints.visible;
    if (this.options.hideJoints) this.app.joints.visible = false;
    let canvas: HTMLCanvasElement;
    try {
      canvas = vp.captureCanvas(eff.scale, true);
    } finally {
      this.app.joints.visible = joints;
      if (boost) vp.setQuality(prevQuality);
    }
    if (this.options.captionOn && this.options.captionInCapture) this.drawCaption(canvas, eff.scale);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('The browser could not encode the image.'))),
        'image/png',
      ),
    );
    const result: CaptureResult = {
      blob,
      width: canvas.width,
      height: canvas.height,
      scale: eff.scale,
      reduced: eff.reduced,
      name: captureFileName(this.app.store.name, eff.scale, canvas.width, canvas.height),
    };
    this.lastCapture = result;
    this.emit();
    return result;
  }

  private drawCaption(canvas: HTMLCanvasElement, scale: number): void {
    const ctx = canvas.getContext('2d');
    const o = this.options;
    if (!ctx || (!o.title && !o.subtitle)) return;
    const size = o.captionSize * scale;
    const subSize = size * 0.45;
    const margin = Math.min(canvas.width, canvas.height) * 0.05;
    const pos: CaptionPos = o.captionPos;
    const align = pos.endsWith('left') ? 'left' : pos.endsWith('right') ? 'right' : 'center';
    const x = align === 'left' ? margin : align === 'right' ? canvas.width - margin : canvas.width / 2;
    const lines: { text: string; px: number; weight: number }[] = [];
    if (o.title) lines.push({ text: o.title, px: size, weight: 700 });
    if (o.subtitle) lines.push({ text: o.subtitle, px: subSize, weight: 400 });
    const total = lines.reduce((s, l) => s + l.px * 1.25, 0);
    let y = pos.startsWith('top')
      ? margin
      : pos === 'center'
        ? (canvas.height - total) / 2
        : canvas.height - margin - total;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = size * 0.18;
    ctx.shadowOffsetY = size * 0.04;
    for (const l of lines) {
      ctx.font = `${l.weight} ${l.px}px Inter, system-ui, sans-serif`;
      ctx.fillText(l.text, x, y);
      y += l.px * 1.25;
    }
  }

  /** Capture and save the PNG through the browser's download. */
  async captureAndDownload(scale?: number): Promise<CaptureResult> {
    const r = await this.capture(scale);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(r.blob);
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    const note = r.reduced ? ` (reduced from ${scale ?? this.options.captureScale}× to fit your GPU)` : '';
    this.app.toast(`Saved ${r.name} — ${r.width}×${r.height}${note}`, 'success');
    return r;
  }
}

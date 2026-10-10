/**
 * Split screen and picture-in-picture. The main view keeps its own canvas, orbit controls, picking and gizmo — a
 * split only shrinks its host element, and the other panes are 2D canvases laid out beside it, filled each frame by
 * rendering the scene from their own cameras (`PaneRenderer`). Picture-in-picture windows are the same canvases,
 * floating, draggable and resizable. Both are described in the scene (`SceneCameras.panes` / `pips`).
 */
import { PerspectiveCamera } from 'three';
import { PaneRenderer } from '../../render/paneRenderer';
import type { ViewPane } from '../../model/types';
import { uid } from '../../model/factory';
import type { App } from '../app';
import { chasePose, mountPose, newFollow, newPose, topDownPose, type FollowState, type Pose } from './poses';
import type { CameraRig } from './rig';

export const defaultPane = (i: number): ViewPane => ({
  id: `pane_${i}`,
  mode: (['chase', 'topdown', 'mount'] as const)[i % 3],
  subject: null,
  ref: '',
  fov: 60,
  offset: [0, 1, 0],
  yaw: 0,
  pitch: 0,
  x: 0.68,
  y: 0.62,
  w: 0.28,
});

export const newPip = (subject: string | null, mode: ViewPane['mode'] = 'mount'): ViewPane => ({
  ...defaultPane(2),
  id: uid('pip'),
  mode,
  subject,
  offset: [0, 0.6, 0],
  x: 0.68,
  y: 0.62,
  w: 0.28,
});

interface View {
  spec: ViewPane;
  kind: 'pane' | 'pip';
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  camera: PerspectiveCamera;
  follow: FollowState;
  title: HTMLElement;
  /** Size in CSS pixels. */
  w: number;
  h: number;
}

const GAP = 2;

export class ViewManager {
  private layer: HTMLElement;
  private views = new Map<string, View>();
  private renderer: PaneRenderer;
  private frame = 0;
  private pose: Pose = newPose();
  private observer: ResizeObserver;
  private signature = '';

  constructor(
    private app: App,
    private rig: CameraRig,
  ) {
    this.renderer = new PaneRenderer(app.viewport);
    this.layer = document.createElement('div');
    this.layer.className = 'cm-views';
    app.shell.stage.appendChild(this.layer);
    app.store.on('meta', () => this.reconcile());
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(app.shell.stage);
    this.reconcile();
  }

  /** The split panes the scene calls for: stored specs, completed with defaults. */
  paneSpecs(): ViewPane[] {
    const n = this.app.store.cameras.split - 1;
    return Array.from({ length: n }, (_, i) => this.app.store.cameras.panes[i] ?? defaultPane(i));
  }

  // ---- DOM -------------------------------------------------------------------------------------

  private reconcile(): void {
    const cams = this.app.store.cameras;
    const wanted: { spec: ViewPane; kind: 'pane' | 'pip' }[] = [
      ...this.paneSpecs().map((spec) => ({ spec, kind: 'pane' as const })),
      ...cams.pips.map((spec) => ({ spec, kind: 'pip' as const })),
    ];
    const sig = JSON.stringify([cams.split, wanted.map((w) => w.spec.id + w.kind)]);
    const ids = new Set(wanted.map((w) => `${w.kind}:${w.spec.id}`));
    for (const [key, v] of this.views)
      if (!ids.has(key)) {
        v.el.remove();
        this.views.delete(key);
      }
    for (const w of wanted) {
      const key = `${w.kind}:${w.spec.id}`;
      const have = this.views.get(key);
      if (have) have.spec = w.spec;
      else this.views.set(key, this.make(w.spec, w.kind));
    }
    if (sig !== this.signature) {
      this.signature = sig;
      this.layer.replaceChildren(...[...this.views.values()].map((v) => v.el));
    }
    for (const v of this.views.values()) this.titleOf(v);
    this.layout();
  }

  private make(spec: ViewPane, kind: 'pane' | 'pip'): View {
    const el = document.createElement('div');
    el.className = `cm-view ${kind}`;
    el.dataset.view = spec.id;
    const canvas = document.createElement('canvas');
    canvas.className = 'cm-view-canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    const title = document.createElement('span');
    title.className = 'cm-view-title';
    const bar = document.createElement('div');
    bar.className = 'cm-view-bar';
    bar.append(title);
    el.append(canvas, bar);
    const view: View = {
      spec,
      kind,
      el,
      canvas,
      ctx,
      camera: new PerspectiveCamera(spec.fov, 16 / 9, 0.1, 2000),
      follow: newFollow(),
      title,
      w: 0,
      h: 0,
    };
    if (kind === 'pip') this.pipChrome(view, bar);
    return view;
  }

  private titleOf(v: View): void {
    const id = v.spec.subject ?? this.rig.subjectId();
    const name = id ? (this.app.store.body(id)?.name ?? '') : '';
    const mode = { chase: 'Chase', topdown: 'Top', mount: 'Camera', bookmark: 'View', shot: 'Shot' }[v.spec.mode];
    v.title.textContent = `${mode}${name ? ` · ${name}` : ''}`;
  }

  private pipChrome(v: View, bar: HTMLElement): void {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'cm-view-close';
    close.title = 'Close this picture-in-picture';
    close.setAttribute('aria-label', 'Close picture-in-picture');
    close.textContent = '×';
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', () => {
      const cams = this.app.store.cameras;
      this.app.store.setCameras(
        { ...cams, pips: cams.pips.filter((p) => p.id !== v.spec.id) },
        'Close picture-in-picture',
      );
    });
    bar.append(close);
    const grip = document.createElement('div');
    grip.className = 'cm-view-grip';
    grip.title = 'Drag to resize';
    v.el.append(grip);

    const commit = () => {
      const cams = this.app.store.cameras;
      const r = this.layer.getBoundingClientRect();
      const e = v.el.getBoundingClientRect();
      const spec: ViewPane = {
        ...v.spec,
        x: Math.min(0.95, Math.max(0, (e.left - r.left) / r.width)),
        y: Math.min(0.95, Math.max(0, (e.top - r.top) / r.height)),
        w: Math.min(0.9, Math.max(0.1, e.width / r.width)),
      };
      this.app.store.setCameras(
        { ...cams, pips: cams.pips.map((p) => (p.id === spec.id ? spec : p)) },
        'Move picture-in-picture',
      );
    };
    const drag = (target: HTMLElement, mode: 'move' | 'size') => {
      target.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        target.setPointerCapture(ev.pointerId);
        const r = this.layer.getBoundingClientRect();
        const start = v.el.getBoundingClientRect();
        const x0 = ev.clientX;
        const y0 = ev.clientY;
        const move = (m: PointerEvent) => {
          if (mode === 'move') {
            v.el.style.left = `${Math.max(0, Math.min(r.width - start.width, start.left - r.left + m.clientX - x0))}px`;
            v.el.style.top = `${Math.max(0, Math.min(r.height - start.height, start.top - r.top + m.clientY - y0))}px`;
          } else {
            const w = Math.max(140, Math.min(r.width * 0.9, start.width + m.clientX - x0));
            v.el.style.width = `${w}px`;
            v.el.style.height = `${(w * 9) / 16}px`;
          }
        };
        const up = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
          target.removeEventListener('pointercancel', up);
          commit();
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
        target.addEventListener('pointercancel', up);
      });
    };
    drag(bar, 'move');
    drag(grip, 'size');
  }

  // ---- layout ----------------------------------------------------------------------------------

  private layout(): void {
    const stage = this.app.shell.stage;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    const host = this.app.shell.viewportHost;
    const n = this.app.store.cameras.split;
    // main view rectangle and the pane rectangles beside it
    const rects: [number, number, number, number][] = [];
    const half = (v: number) => Math.floor((v - GAP) / 2);
    if (n === 2) rects.push([0, 0, half(W), H], [half(W) + GAP, 0, W - half(W) - GAP, H]);
    else if (n === 3)
      rects.push(
        [0, 0, half(W), H],
        [half(W) + GAP, 0, W - half(W) - GAP, half(H)],
        [half(W) + GAP, half(H) + GAP, W - half(W) - GAP, H - half(H) - GAP],
      );
    else if (n === 4)
      rects.push(
        [0, 0, half(W), half(H)],
        [half(W) + GAP, 0, W - half(W) - GAP, half(H)],
        [0, half(H) + GAP, half(W), H - half(H) - GAP],
        [half(W) + GAP, half(H) + GAP, W - half(W) - GAP, H - half(H) - GAP],
      );
    else rects.push([0, 0, W, H]);
    const [mx, my, mw, mh] = rects[0];
    if (n === 1) Object.assign(host.style, { inset: '0', left: '', top: '', width: '', height: '' });
    else
      Object.assign(host.style, {
        inset: 'auto',
        left: `${mx}px`,
        top: `${my}px`,
        width: `${mw}px`,
        height: `${mh}px`,
      });
    stage.classList.toggle('cm-split', n > 1);
    let i = 1;
    for (const v of this.views.values()) {
      if (v.kind === 'pane') {
        const r = rects[i++] ?? [0, 0, 0, 0];
        Object.assign(v.el.style, { left: `${r[0]}px`, top: `${r[1]}px`, width: `${r[2]}px`, height: `${r[3]}px` });
        v.w = r[2];
        v.h = r[3];
      } else {
        const w = Math.max(140, Math.min(W * 0.9, v.spec.w * W));
        const h = (w * 9) / 16;
        const left = Math.max(0, Math.min(W - w, v.spec.x * W));
        const top = Math.max(0, Math.min(H - h, v.spec.y * H));
        Object.assign(v.el.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
        v.w = w;
        v.h = h;
      }
    }
    this.app.viewport.resize();
  }

  // ---- frame -----------------------------------------------------------------------------------

  /** Pose of a view's camera for this frame; false when it has nothing to show (no subject, missing bookmark). */
  private poseOf(v: View, dt: number): boolean {
    const s = v.spec;
    const cfg = this.rig.settings;
    const out = this.pose;
    if (s.mode === 'bookmark') {
      const b = this.app.store.cameras.bookmarks.find((x) => x.id === s.ref);
      if (!b) return false;
      v.camera.position.set(...b.position);
      v.camera.lookAt(...b.target);
      v.camera.fov = b.fov;
      return true;
    }
    const id = s.subject && this.app.store.body(s.subject) ? s.subject : this.rig.subjectId();
    const subject = id ? this.rig.subjectState(id) : null;
    if (!subject) return false;
    if (s.mode === 'chase')
      chasePose(
        v.follow,
        subject,
        cfg.forwardAxis,
        { distance: cfg.chaseDistance, height: cfg.chaseHeight },
        false,
        s.fov,
        dt,
        out,
      );
    else if (s.mode === 'topdown') topDownPose(subject, Math.max(4, s.offset[1] * 12 || 20), s.fov, out);
    else mountPose(subject, cfg.forwardAxis, s.offset, s.yaw, s.pitch, s.fov, out);
    v.camera.position.copy(out.position);
    v.camera.quaternion.copy(out.quaternion);
    v.camera.fov = out.fov;
    return true;
  }

  update(dt: number): void {
    if (!this.views.size) return;
    this.frame++;
    const stride = this.views.size > 2 ? 2 : 1;
    let k = 0;
    for (const v of this.views.values()) {
      if (v.w < 40 || v.h < 30) continue;
      if (!this.poseOf(v, dt)) {
        v.el.classList.add('empty');
        continue;
      }
      v.el.classList.remove('empty');
      if ((this.frame + k++) % stride !== 0) continue;
      const q = v.kind === 'pip' ? 0.85 : 1;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * q;
      const w = Math.max(2, Math.min(1280, Math.round(v.w * dpr)));
      const h = Math.max(2, Math.min(1280, Math.round(v.h * dpr)));
      v.camera.aspect = w / h;
      v.camera.updateProjectionMatrix();
      v.camera.updateMatrixWorld();
      this.renderer.render(v.camera, v.canvas, v.ctx, w, h);
    }
  }

  dispose(): void {
    this.observer.disconnect();
    this.renderer.dispose();
    this.layer.remove();
  }
}

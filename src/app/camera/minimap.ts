/**
 * The minimap: a live top-down map of the scene in a corner of the viewport — bodies as their footprints, ghost
 * bodies (trigger zones) dashed, paths as lines, the camera as a wedge showing its field of view. Click or drag to
 * move the camera there, the wheel zooms, and it can turn with the camera so "up" on the map is "ahead" in the view.
 * The geometry (`MapView`) is pure and tested; this class only draws and listens.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import { pathCurveOf } from '../../model/path';
import type { MinimapSettings } from '../../model/types';
import type { App } from '../app';

/** World ↔ canvas mapping of a square map: the centre, the half extent shown (m), the size (px), the rotation (rad). */
export class MapView {
  constructor(
    public cx = 0,
    public cz = 0,
    public range = 40,
    public size = 200,
    /** Rotation of the world about the centre: the map turns by this so that heading `rotation` points up. */
    public rotation = 0,
  ) {}

  /** Canvas pixels per metre. */
  get scale(): number {
    return this.size / (2 * this.range);
  }

  toMap(x: number, z: number, out: [number, number] = [0, 0]): [number, number] {
    const dx = x - this.cx;
    const dz = z - this.cz;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    // Screen x grows with world x and screen y with world z (north, −Z, is up). With `rotation` ρ the world is turned
    // by ρ about the centre; ρ = ψ − π puts a camera heading ψ (pointing along (sinψ, cosψ)) at screen-up.
    out[0] = this.size / 2 + (dx * c - dz * s) * this.scale;
    out[1] = this.size / 2 + (dx * s + dz * c) * this.scale;
    return out;
  }

  toWorld(px: number, py: number, out: [number, number] = [0, 0]): [number, number] {
    const u = (px - this.size / 2) / this.scale;
    const v = (py - this.size / 2) / this.scale;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    out[0] = this.cx + u * c + v * s;
    out[1] = this.cz - u * s + v * c;
    return out;
  }
}

const _q = new Quaternion();
const _e = new Euler();

/** Yaw (rotation about +Y) of a quaternion given as x, y, z, w. */
export function yawOf(q: readonly [number, number, number, number]): number {
  _e.setFromQuaternion(_q.set(q[0], q[1], q[2], q[3]), 'YXZ');
  return _e.y;
}

const CORNER: Record<MinimapSettings['corner'], Partial<CSSStyleDeclaration>> = {
  tl: { left: '70px', top: '64px', right: '', bottom: '' },
  tr: { right: '12px', top: '64px', left: '', bottom: '' },
  bl: { left: '70px', bottom: '14px', right: '', top: '' },
  br: { right: '12px', bottom: '14px', left: '', top: '' },
};

export class Minimap {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view = new MapView();
  private px = 220;
  private frame = 0;
  private dragging = false;
  private persistTimer = 0;
  private tmp: [number, number] = [0, 0];
  private tmp2: [number, number] = [0, 0];
  private fwd = new Vector3();

  constructor(private app: App) {
    this.el = document.createElement('div');
    this.el.className = 'cm-minimap';
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', 'Minimap: top-down view of the scene. Click to move the camera.');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'cm-minimap-canvas';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.el.append(this.canvas);
    app.shell.stage.appendChild(this.el);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.dragging && this.moveTo(e));
    const end = (e: PointerEvent) => {
      this.dragging = false;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    app.store.on('meta', () => this.sync());
    this.sync();
  }

  private get cfg(): MinimapSettings {
    return this.app.store.cameras.minimap;
  }

  private sync(): void {
    const c = this.cfg;
    this.el.style.display = c.enabled ? '' : 'none';
    Object.assign(this.el.style, CORNER[c.corner]);
    this.view.range = c.range;
  }

  private set(patch: Partial<MinimapSettings>, label: string): void {
    const cams = this.app.store.cameras;
    this.app.store.setCameras({ ...cams, minimap: { ...cams.minimap, ...patch } }, label);
  }

  // ---- input -----------------------------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.dragging = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.moveTo(e);
  }

  /** Move the camera so that the clicked map point is what it looks at (keeping its height and direction). */
  private moveTo(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const [x, z] = this.view.toWorld(
      ((e.clientX - r.left) / r.width) * this.px,
      ((e.clientY - r.top) / r.height) * this.px,
      this.tmp,
    );
    const rig = this.app.cameraRig;
    if (rig.mode === 'fly') {
      rig.fly.position.set(x, rig.fly.position.y, z);
      return;
    }
    if (rig.driven) rig.setMode('orbit');
    const vp = this.app.viewport;
    const cam = this.app.camera;
    const target = vp.controls.target;
    const dx = x - target.x;
    const dz = z - target.z;
    vp.setView({
      position: [cam.position.x + dx, cam.position.y, cam.position.z + dz],
      target: [x, target.y, z],
    });
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const range = Math.max(2, Math.min(2000, this.view.range * Math.exp(e.deltaY * 0.0012)));
    this.view.range = range;
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.set({ range }, 'Zoom minimap'), 500);
  }

  // ---- drawing ---------------------------------------------------------------------------------

  update(): void {
    if (!this.cfg.enabled) return;
    if (++this.frame % 2 !== 0) return;
    const cam = this.app.camera;
    const v = this.view;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = this.px;
    if (this.canvas.width !== Math.round(px * dpr)) {
      this.canvas.width = this.canvas.height = Math.round(px * dpr);
      this.canvas.style.width = this.canvas.style.height = `${px}px`;
    }
    v.size = px;
    // centre on what the camera looks at; turn with the camera when asked
    const t = this.app.viewport.controls.target;
    v.cx = t.x;
    v.cz = t.z;
    this.fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const heading = Math.atan2(this.fwd.x, this.fwd.z);
    v.rotation = this.cfg.rotate ? heading - Math.PI : 0;
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, px, px);
    g.fillStyle = 'rgba(11, 14, 20, 0.86)';
    g.fillRect(0, 0, px, px);
    this.drawGrid(g);
    this.drawGround(g);
    this.drawPaths(g);
    this.drawBodies(g);
    this.drawCamera(g, heading);
    g.strokeStyle = 'rgba(93, 112, 140, 0.55)';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, px - 1, px - 1);
    // north marker, on the map's edge in the direction of −Z
    const n = v.toMap(v.cx, v.cz - v.range * 0.82, this.tmp);
    g.fillStyle = 'rgba(152, 165, 185, 0.9)';
    g.font = '600 10px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillText('N', n[0], n[1] + 3);
  }

  private drawGrid(g: CanvasRenderingContext2D): void {
    const v = this.view;
    // a line every 1, 5, 10, 50 … m: whichever is at least ~18 px apart
    const steps = [1, 5, 10, 50, 100, 500];
    const step = steps.find((s) => s * v.scale >= 18) ?? 1000;
    g.strokeStyle = 'rgba(120, 140, 170, 0.14)';
    g.lineWidth = 1;
    g.beginPath();
    const r = v.range * Math.SQRT2;
    const x0 = Math.floor((v.cx - r) / step) * step;
    const z0 = Math.floor((v.cz - r) / step) * step;
    for (let x = x0; x <= v.cx + r; x += step) {
      const a = v.toMap(x, v.cz - r, this.tmp);
      g.moveTo(a[0], a[1]);
      const b = v.toMap(x, v.cz + r, this.tmp2);
      g.lineTo(b[0], b[1]);
    }
    for (let z = z0; z <= v.cz + r; z += step) {
      const a = v.toMap(v.cx - r, z, this.tmp);
      g.moveTo(a[0], a[1]);
      const b = v.toMap(v.cx + r, z, this.tmp2);
      g.lineTo(b[0], b[1]);
    }
    g.stroke();
  }

  private drawGround(g: CanvasRenderingContext2D): void {
    const ground = this.app.store.settings.ground;
    if (!ground.enabled) return;
    const h = ground.halfSize;
    const v = this.view;
    g.strokeStyle = 'rgba(94, 200, 255, 0.35)';
    g.setLineDash([4, 3]);
    g.beginPath();
    [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ].forEach(([x, z], i) => {
      const p = v.toMap(x, z, this.tmp);
      if (i) g.lineTo(p[0], p[1]);
      else g.moveTo(p[0], p[1]);
    });
    g.closePath();
    g.stroke();
    g.setLineDash([]);
  }

  private drawPaths(g: CanvasRenderingContext2D): void {
    const v = this.view;
    for (const p of this.app.store.paths()) {
      if (p.hidden) continue;
      const poly = pathCurveOf(p).polyline(6);
      g.strokeStyle = 'rgba(94, 200, 255, 0.8)';
      g.lineWidth = 1.5;
      g.beginPath();
      poly.forEach((q, i) => {
        const m = v.toMap(q[0], q[2], this.tmp);
        if (i) g.lineTo(m[0], m[1]);
        else g.moveTo(m[0], m[1]);
      });
      g.stroke();
    }
  }

  private drawBodies(g: CanvasRenderingContext2D): void {
    const v = this.view;
    const sel = new Set(this.app.store.selection);
    const reach = v.range * 1.5;
    let drawn = 0;
    for (const [id, view] of this.app.bodies.views) {
      const def = view.def;
      if (def.hidden) continue;
      const p = view.position;
      if (Math.abs(p.x - v.cx) > reach + 20 || Math.abs(p.z - v.cz) > reach + 20) continue;
      if (++drawn > 4000) break;
      const size = def.shape.size;
      const yaw = yawOf([
        view.mesh.quaternion.x,
        view.mesh.quaternion.y,
        view.mesh.quaternion.z,
        view.mesh.quaternion.w,
      ]);
      const m = v.toMap(p.x, p.z, this.tmp);
      const sx = Math.max(2, size[0] * v.scale);
      const sz = Math.max(2, size[2] * v.scale);
      const round = def.shape.type === 'sphere' || def.shape.type === 'cylinder' || def.shape.type === 'capsule';
      g.save();
      g.translate(m[0], m[1]);
      g.rotate(-yaw + v.rotation);
      const selected = sel.has(id);
      if (def.ghost) {
        g.setLineDash([3, 2]);
        g.strokeStyle = 'rgba(255, 179, 71, 0.9)';
        g.lineWidth = 1.2;
        if (round) {
          g.beginPath();
          g.ellipse(0, 0, sx / 2, sz / 2, 0, 0, Math.PI * 2);
          g.stroke();
        } else g.strokeRect(-sx / 2, -sz / 2, sx, sz);
        g.setLineDash([]);
      } else {
        g.fillStyle = selected
          ? '#5ec8ff'
          : def.bodyType === 'static'
            ? 'rgba(130, 145, 170, 0.55)'
            : def.material.color;
        if (round) {
          g.beginPath();
          g.ellipse(0, 0, sx / 2, sz / 2, 0, 0, Math.PI * 2);
          g.fill();
        } else g.fillRect(-sx / 2, -sz / 2, sx, sz);
        if (selected) {
          g.strokeStyle = '#ffffff';
          g.lineWidth = 1;
          g.strokeRect(-sx / 2 - 1, -sz / 2 - 1, sx + 2, sz + 2);
        }
      }
      g.restore();
    }
  }

  private drawCamera(g: CanvasRenderingContext2D, heading: number): void {
    const v = this.view;
    const cam = this.app.camera;
    const m = v.toMap(cam.position.x, cam.position.z, this.tmp);
    const inView = m[0] > 0 && m[0] < v.size && m[1] > 0 && m[1] < v.size;
    g.save();
    g.fillStyle = 'rgba(255, 255, 255, 0.16)';
    g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    g.lineWidth = 1.2;
    if (cam.ortho) {
      // an orthographic camera sees a rectangle: draw it around the point it looks at
      const t = this.app.viewport.controls.target;
      const c = v.toMap(t.x, t.z, this.tmp2);
      const h = (cam.orthoSize / Math.max(1e-6, cam.zoom) / 2) * v.scale;
      g.strokeRect(c[0] - h * cam.aspect, c[1] - h, 2 * h * cam.aspect, 2 * h);
    } else {
      // field of view as a wedge of 40 % of the map
      const half = (Math.atan(Math.tan((cam.fov * Math.PI) / 360) * cam.aspect) * 180) / Math.PI;
      const a = ((half * Math.PI) / 180) * 1;
      const len = v.size * 0.45;
      // heading ψ on the map: screen angle of the forward vector
      const dirX = Math.sin(heading);
      const dirZ = Math.cos(heading);
      const ahead = v.toMap(cam.position.x + dirX, cam.position.z + dirZ, this.tmp2);
      const sa = Math.atan2(ahead[1] - m[1], ahead[0] - m[0]);
      g.beginPath();
      g.moveTo(m[0], m[1]);
      g.arc(m[0], m[1], len, sa - a, sa + a);
      g.closePath();
      g.fill();
      g.stroke();
    }
    if (inView || cam.ortho) {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(m[0], m[1], 3, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  dispose(): void {
    window.clearTimeout(this.persistTimer);
    this.el.remove();
  }
}

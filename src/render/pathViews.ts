/**
 * Path views: each `PathEntity` is drawn as a fat line along its spline (the exact curve `model/path.ts` evaluates, so
 * what you see is what a mover follows), round handles on the control points (the first is green, the last red, so the
 * direction of travel is clear) and small arrowheads spaced along the curve. The whole view lives in the path's own
 * frame: moving the entity moves the root group.
 */
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  Vector3,
  type Camera,
  type Object3D,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { PathCurve } from '../model/path';
import type { PathEntity } from '../model/types';

const MAX_ARROWS = 48;
const START = new Color('#5be3a1');
const END = new Color('#ff6b6b');
const SELECTED = new Color('#ffffff');

let dot: CanvasTexture | null = null;
/** Soft round sprite for the control-point handles. */
function dotTexture(): CanvasTexture {
  if (dot) return dot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.beginPath();
    g.arc(32, 32, 28, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.stroke();
  }
  dot = new CanvasTexture(c);
  return dot;
}

const UP = new Vector3(0, 1, 0);
const tmpQ = new Quaternion();
const tmpM = new Matrix4();
const tmpV = new Vector3();
const tmpS = new Vector3(1, 1, 1);

export class PathView {
  readonly root = new Group();
  readonly line: Line2;
  readonly lineMat: LineMaterial;
  private readonly handles: Points;
  private readonly handleMat: PointsMaterial;
  private readonly arrows: InstancedMesh;
  private readonly arrowMat: MeshBasicMaterial;
  selected = false;
  /** Index of the control point being edited with the gizmo, or -1. */
  activePoint = -1;
  /** Total length of the curve in metres (for the inspector). */
  length = 0;
  /** The definition the line, handles and arrows were last built from. */
  private built: PathEntity | null = null;

  constructor(
    public def: PathEntity,
    res: { w: number; h: number },
  ) {
    this.lineMat = new LineMaterial({ color: 0xffffff, linewidth: 3, worldUnits: false, transparent: true });
    this.lineMat.resolution.set(res.w, res.h);
    this.line = new Line2(new LineGeometry(), this.lineMat);
    this.line.frustumCulled = false;
    this.handleMat = new PointsMaterial({
      size: 10,
      sizeAttenuation: false,
      map: dotTexture(),
      alphaTest: 0.3,
      transparent: true,
      vertexColors: true,
      depthTest: false,
    });
    this.handles = new Points(new BufferGeometry(), this.handleMat);
    this.handles.renderOrder = 998;
    this.handles.frustumCulled = false;
    this.handles.raycast = () => undefined;
    this.arrowMat = new MeshBasicMaterial({ color: 0xffffff });
    this.arrows = new InstancedMesh(new ConeGeometry(0.07, 0.22, 10), this.arrowMat, MAX_ARROWS);
    this.arrows.frustumCulled = false;
    this.arrows.raycast = () => undefined;
    this.root.add(this.line, this.handles, this.arrows);
    this.apply(def);
  }

  apply(def: PathEntity): void {
    this.def = def;
    this.root.position.set(...def.position);
    this.root.quaternion.set(...def.rotation);
    this.root.visible = !def.hidden;
    this.line.userData.entityId = def.id;
    // Moving or recolouring a path leaves its points alone (entities are immutable, so the same array means the same
    // curve): only an edit of the shape rebuilds the line, the handles and the arrows.
    const prev = this.built;
    this.built = def;
    if (prev && prev.points === def.points && prev.closed === def.closed && prev.tension === def.tension) {
      this.refreshState();
      return;
    }
    const curve = new PathCurve({ points: def.points, closed: def.closed, tension: def.tension });
    this.length = curve.length;
    // the curve
    const poly = curve.polyline(14);
    const flat = new Float32Array(poly.length * 3);
    poly.forEach((p, i) => flat.set(p, i * 3));
    this.line.geometry.dispose();
    const lg = new LineGeometry();
    lg.setPositions(flat);
    this.line.geometry = lg;
    this.line.computeLineDistances();
    // the handles
    const n = def.points.length;
    const pos = new Float32Array(n * 3);
    def.points.forEach((p, i) => pos.set(p, i * 3));
    this.handles.geometry.dispose();
    const hg = new BufferGeometry();
    hg.setAttribute('position', new Float32BufferAttribute(pos, 3));
    hg.setAttribute('color', new Float32BufferAttribute(new Float32Array(n * 3), 3));
    this.handles.geometry = hg;
    // direction arrows, evenly spaced by arc length
    const count = curve.length > 1e-6 ? Math.min(MAX_ARROWS, Math.max(1, Math.round(curve.length / 2))) : 0;
    const p = new Vector3();
    const t = new Vector3();
    for (let i = 0; i < count; i++) {
      const s = ((i + 0.5) / count) * curve.length;
      const pp = curve.positionAtDistance(s);
      const tt = curve.tangentAtDistance(s);
      p.set(pp[0], pp[1], pp[2]);
      t.set(tt[0], tt[1], tt[2]);
      tmpQ.setFromUnitVectors(UP, t);
      tmpM.compose(p, tmpQ, tmpS);
      this.arrows.setMatrixAt(i, tmpM);
    }
    this.arrows.count = count;
    this.arrows.instanceMatrix.needsUpdate = true;
    this.refreshState();
  }

  /** Colours and sizes that depend on the selection and the active control point. */
  refreshState(): void {
    const base = new Color(this.def.color);
    const c = this.selected ? base.clone().lerp(SELECTED, 0.55) : base;
    this.lineMat.color.copy(c);
    this.lineMat.linewidth = this.selected ? 4.5 : 3;
    this.lineMat.opacity = this.def.locked ? 0.55 : 1;
    this.arrowMat.color.copy(c);
    this.handleMat.size = this.selected ? 12 : 8;
    const col = this.handles.geometry.getAttribute('color');
    const n = this.def.points.length;
    for (let i = 0; i < n; i++) {
      const k =
        i === this.activePoint ? new Color('#ffb347') : i === 0 ? START : i === n - 1 && !this.def.closed ? END : c;
      col.setXYZ(i, k.r, k.g, k.b);
    }
    col.needsUpdate = true;
  }

  /** World position of control point `i`. */
  pointWorld(i: number, out = new Vector3()): Vector3 {
    const p = this.def.points[i];
    this.root.updateWorldMatrix(true, false);
    return out.set(p[0], p[1], p[2]).applyMatrix4(this.root.matrixWorld);
  }

  dispose(): void {
    this.line.geometry.dispose();
    this.lineMat.dispose();
    this.handles.geometry.dispose();
    this.handleMat.dispose();
    this.arrows.geometry.dispose();
    this.arrows.dispose();
    this.arrowMat.dispose();
  }
}

export class PathViews {
  readonly views = new Map<string, PathView>();
  private res = { w: 1, h: 1 };

  constructor(readonly group: Group) {}

  get(id: string): PathView | undefined {
    return this.views.get(id);
  }

  setResolution(w: number, h: number): void {
    if (w === this.res.w && h === this.res.h) return;
    this.res = { w, h };
    for (const v of this.views.values()) v.lineMat.resolution.set(w, h);
  }

  add(def: PathEntity): PathView {
    this.remove(def.id);
    const v = new PathView(def, this.res);
    this.views.set(def.id, v);
    this.group.add(v.root);
    return v;
  }

  update(def: PathEntity): void {
    const v = this.views.get(def.id);
    if (!v) this.add(def);
    else v.apply(def);
  }

  remove(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.root);
    v.dispose();
    this.views.delete(id);
  }

  clear(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
  }

  setSelected(ids: Set<string>): void {
    for (const v of this.views.values()) {
      const s = ids.has(v.def.id);
      if (s !== v.selected) {
        v.selected = s;
        v.refreshState();
      }
    }
  }

  /** Mark control point `index` of path `id` as the one being edited (-1 = none). */
  setActivePoint(id: string | null, index: number): void {
    for (const v of this.views.values()) {
      const want = v.def.id === id ? index : -1;
      if (v.activePoint !== want) {
        v.activePoint = want;
        v.refreshState();
      }
    }
  }

  /** Click targets: the curve lines of visible paths. */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    for (const v of this.views.values()) if (!v.def.hidden) out.push(v.line);
    return out;
  }

  /**
   * The control point of a *selected* path under the pointer (within `radius` px), nearest first. Handles are screen-
   * sized sprites, so they are hit-tested in screen space rather than with a ray.
   */
  pickPoint(
    ev: { clientX: number; clientY: number },
    camera: Camera,
    rect: DOMRect,
    radius = 12,
  ): { id: string; index: number } | null {
    let best: { id: string; index: number } | null = null;
    let bestD = radius;
    for (const v of this.views.values()) {
      if (!v.selected || v.def.hidden) continue;
      for (let i = 0; i < v.def.points.length; i++) {
        const p = v.pointWorld(i, tmpV).project(camera);
        if (p.z > 1) continue;
        const sx = rect.left + ((p.x + 1) / 2) * rect.width;
        const sy = rect.top + ((1 - p.y) / 2) * rect.height;
        const d = Math.hypot(sx - ev.clientX, sy - ev.clientY);
        if (d < bestD) {
          bestD = d;
          best = { id: v.def.id, index: i };
        }
      }
    }
    return best;
  }
}

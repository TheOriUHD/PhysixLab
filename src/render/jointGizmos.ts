/**
 * Viewport gizmos of the joint types beyond hinge / slider / ball / fixed / spring / rope (JT-A), the hinge limit arc and
 * the live readout label (JT-20). `jointViews.ts` owns the pick spheres and the classic gizmos; a `Gizmo` here is a second
 * group per joint that is positioned at anchor A (world axes, no rotation) and draws the real mechanism: cone and twist
 * range, the six DOFs, pulley wheels and rope, gear discs, rack and belt, a helix, a drum.
 *
 * Everything is built once per joint (any change to the joint rebuilds the view). A frame only moves transforms and
 * overwrites the few polylines whose shape follows the bodies (rope, belt, rack teeth) in place, so it allocates nothing.
 */
import type { Object3D } from 'three';
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { InterleavedBuffer } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { JointEntity } from '../model/types';
import type { Vec3 } from '../core/math';

const WHITE = new Color('#ffffff');
const HOT = new Color('#ff3b3b');
const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const TAU = Math.PI * 2;

/** Per-frame input of a gizmo: world anchors / axes of the two ends and the live joint state (when simulating). */
export interface GizmoCtx {
  def: JointEntity;
  /** World anchors of end A and end B (B equals A for the types that derive it). */
  a: Vector3;
  b: Vector3;
  /** Unit world axis of A (`def.axis`) and of B (`params.axisB`, in B's frame). */
  axis: Vector3;
  axisB: Vector3;
  /** Body orientations (identity for the world). */
  qA: Quaternion;
  qB: Quaternion;
  /** Gizmo scale (grows with camera distance). */
  s: number;
  live: boolean;
  /** Live joint state (`J.value`, `J.speed`, `J.force`). */
  value: number;
  speed: number;
  force: number;
}

export function newGizmoCtx(): GizmoCtx {
  return {
    def: null as unknown as JointEntity,
    a: new Vector3(),
    b: new Vector3(),
    axis: new Vector3(0, 0, 1),
    axisB: new Vector3(0, 0, 1),
    qA: new Quaternion(),
    qB: new Quaternion(),
    s: 1,
    live: false,
    value: 0,
    speed: 0,
    force: 0,
  };
}

// ---- shared geometry --------------------------------------------------------------------------------------------------

const shared = {
  sphere: new SphereGeometry(0.5, 14, 10),
  box: new BoxGeometry(1, 1, 1),
  cone: new ConeGeometry(0.045, 0.12, 12),
  /** Unit disc (radius 1, thin), axis Y. */
  disc: new CylinderGeometry(1, 1, 0.012, 48),
  /** Unit drum (radius 1, length 1), axis Y. */
  drum: new CylinderGeometry(1, 1, 1, 32, 1, true),
};

// ---- fixed-size in-place polyline -------------------------------------------------------------------------------------

/** A Line2 with a fixed number of points that can be rewritten without touching the allocator. */
class Poly {
  readonly line: Line2;
  readonly mat: LineMaterial;
  private readonly pos: Float32Array;
  private readonly posBuf: InterleavedBuffer;
  private readonly distBuf: InterleavedBuffer | null;

  constructor(
    readonly n: number,
    res: { w: number; h: number },
    opacity: number,
    width: number,
    dashed: boolean,
  ) {
    const geo = new LineGeometry();
    geo.setPositions(new Float32Array(Math.max(2, n) * 3));
    this.mat = new LineMaterial({
      color: 0xffffff,
      linewidth: width,
      transparent: true,
      depthTest: false,
      worldUnits: false,
      opacity,
      toneMapped: false,
      dashed,
    });
    this.mat.resolution.set(res.w, res.h);
    this.line = new Line2(geo, this.mat);
    this.line.renderOrder = 998;
    this.line.frustumCulled = false;
    this.posBuf = (geo.getAttribute('instanceStart') as unknown as { data: InterleavedBuffer }).data;
    this.pos = this.posBuf.array as Float32Array;
    if (dashed) {
      this.line.computeLineDistances();
      this.distBuf = (geo.getAttribute('instanceDistanceStart') as unknown as { data: InterleavedBuffer }).data;
    } else this.distBuf = null;
  }

  set(i: number, x: number, y: number, z: number): void {
    const p = this.pos;
    if (i < this.n - 1) {
      const o = i * 6;
      p[o] = x;
      p[o + 1] = y;
      p[o + 2] = z;
    }
    if (i > 0) {
      const o = (i - 1) * 6 + 3;
      p[o] = x;
      p[o + 1] = y;
      p[o + 2] = z;
    }
  }

  setV(i: number, v: Vector3): void {
    this.set(i, v.x, v.y, v.z);
  }

  /** Upload the points; `dashed` lines also refresh their running distance. */
  commit(): void {
    this.posBuf.needsUpdate = true;
    const db = this.distBuf;
    if (!db) return;
    const p = this.pos;
    const d = db.array as Float32Array;
    let run = 0;
    for (let k = 0; k < this.n - 1; k++) {
      const o = k * 6;
      d[k * 2] = run;
      run += Math.hypot(p[o + 3] - p[o], p[o + 4] - p[o + 1], p[o + 5] - p[o + 2]);
      d[k * 2 + 1] = run;
    }
    db.needsUpdate = true;
  }

  dispose(): void {
    this.line.geometry.dispose();
    this.mat.dispose();
  }
}

// ---- scratch ----------------------------------------------------------------------------------------------------------

const tU = new Vector3();
const tV = new Vector3();
const tW = new Vector3();
const tP = new Vector3();
const tQ = new Quaternion();
const tQ2 = new Quaternion();
const tM = new Matrix4();
const tC = new Color();
const tO = new Vector3();
const tE1 = new Vector3();
const tE2 = new Vector3();

/** A unit vector perpendicular to `n` (stable for any direction). */
function perp(n: Vector3, out: Vector3): Vector3 {
  if (Math.abs(n.y) < 0.9) out.set(0, 1, 0);
  else out.set(1, 0, 0);
  return out.cross(n).normalize();
}

/** Reference direction attached to a body: a fixed perpendicular of its local axis, rotated into the world. */
function bodyRef(axisLocal: Vec3, q: Quaternion, out: Vector3): Vector3 {
  tP.set(axisLocal[0], axisLocal[1], axisLocal[2]);
  if (tP.lengthSq() < 1e-12) tP.set(0, 0, 1);
  tP.normalize();
  perp(tP, out);
  return out.applyQuaternion(q);
}

/** Orient `obj` so its local +Y is `n` and its local +X is `u` (u ⟂ n). */
function orient(obj: Object3D, u: Vector3, n: Vector3): void {
  tO.crossVectors(u, n);
  tM.makeBasis(u, n, tO);
  obj.quaternion.setFromRotationMatrix(tM);
}

/** Body-attached frame with local +Y along the (local) axis: `q · fromUnitVectors(Y, axisLocal)`. */
function axisFrameY(q: Quaternion, axisLocal: Vec3, out: Quaternion): Quaternion {
  tP.set(axisLocal[0], axisLocal[1], axisLocal[2]);
  if (tP.lengthSq() < 1e-12) tP.set(0, 0, 1);
  tQ2.setFromUnitVectors(Y, tP.normalize());
  return out.copy(q).multiply(tQ2);
}

/** Same with local +X along the axis (the 6-DOF joint frame). */
function axisFrameX(q: Quaternion, axisLocal: Vec3, out: Quaternion): Quaternion {
  tP.set(axisLocal[0], axisLocal[1], axisLocal[2]);
  if (tP.lengthSq() < 1e-12) tP.set(0, 0, 1);
  tQ2.setFromUnitVectors(X, tP.normalize());
  return out.copy(q).multiply(tQ2);
}

function lerpTension(out: Color, base: Color, force: number, ref: number): Color {
  const t = force / (Math.abs(force) + ref);
  return out.copy(base).lerp(HOT, Math.min(1, Math.max(0, t) * 1.4));
}

// ---- the readout label ------------------------------------------------------------------------------------------------

const enum LabelKind {
  Degrees,
  Metres,
  SwingTwist,
}

/** Small canvas sprite with the joint's current angle / position; the texture is redrawn only when the text changes. */
class Label {
  readonly sprite: Sprite;
  private readonly canvas: HTMLCanvasElement;
  private readonly tex: CanvasTexture;
  private key = Number.NaN;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 64;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    const mat = new SpriteMaterial({ map: this.tex, depthTest: false, transparent: true, toneMapped: false });
    this.sprite = new Sprite(mat);
    this.sprite.renderOrder = 1000;
    this.sprite.frustumCulled = false;
    this.sprite.visible = false;
  }

  show(kind: LabelKind, v1: number, v2 = 0): void {
    // Quantised to the displayed precision so unchanged values neither format a string nor re-upload the texture.
    const key =
      kind * 1e12 + Math.round(v1 * (kind === LabelKind.Metres ? 1000 : 10)) * 1e3 + Math.round(v2 * 10) / 1e3;
    if (key === this.key) return;
    this.key = key;
    const deg = (r: number) => `${((r * 180) / Math.PI).toFixed(1)}°`;
    const text =
      kind === LabelKind.Degrees
        ? deg(v1)
        : kind === LabelKind.Metres
          ? `${v1.toFixed(3)} m`
          : `swing ${deg(v1)} · twist ${deg(v2)}`;
    const c = this.canvas.getContext('2d');
    if (!c) return;
    const { width: w, height: h } = this.canvas;
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(14, 20, 30, 0.88)';
    c.beginPath();
    c.roundRect(2, 6, w - 4, h - 12, 16);
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    c.stroke();
    c.fillStyle = '#ffffff';
    let px = 30;
    c.font = `600 ${px}px system-ui, sans-serif`;
    const fit = c.measureText(text).width;
    if (fit > w - 28) {
      px = Math.floor((px * (w - 28)) / fit); // long texts shrink to fit the pill
      c.font = `600 ${px}px system-ui, sans-serif`;
    }
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 + 1);
    this.tex.needsUpdate = true;
  }

  dispose(): void {
    this.tex.dispose();
    this.sprite.material.dispose();
  }
}

// ---- the gizmo --------------------------------------------------------------------------------------------------------

type LabelSpec = 'angle' | 'position' | 'length' | 'swingTwist' | null;

export class Gizmo {
  readonly group = new Group();
  /** All polylines / meshes (for the colour and the disposal), and the geometries this gizmo owns. */
  readonly polys: Poly[] = [];
  readonly meshes: Mesh[] = [];
  private readonly mats: MeshBasicMaterial[] = [];
  private readonly geos: BufferGeometry[] = [];
  private label: Label | null = null;
  private selected = false;
  readonly base: Color;
  /** Per-frame update installed by the builder. */
  fn: ((c: GizmoCtx, g: Gizmo) => void) | null = null;
  labelSpec: LabelSpec = null;

  constructor(
    readonly def: JointEntity,
    color: string,
    readonly res: { w: number; h: number },
  ) {
    this.base = new Color(color);
    this.group.userData.entityId = def.id;
  }

  poly(n: number, opts: { parent?: Object3D; opacity?: number; width?: number; dashed?: boolean } = {}): Poly {
    const p = new Poly(n, this.res, opts.opacity ?? 0.95, opts.width ?? 2, opts.dashed ?? false);
    this.polys.push(p);
    (opts.parent ?? this.group).add(p.line);
    return p;
  }

  mesh(geo: BufferGeometry, opts: { parent?: Object3D; opacity?: number; double?: boolean; own?: boolean } = {}): Mesh {
    const m = new MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      transparent: true,
      opacity: opts.opacity ?? 0.95,
      toneMapped: false,
      side: opts.double ? DoubleSide : FrontSide,
      depthWrite: false,
    });
    const mesh = new Mesh(geo, m);
    mesh.renderOrder = 999;
    mesh.frustumCulled = false;
    this.mats.push(m);
    this.meshes.push(mesh);
    if (opts.own) {
      geo.userData.ownedByGizmo = true;
      this.geos.push(geo);
    }
    (opts.parent ?? this.group).add(mesh);
    return mesh;
  }

  setResolution(w: number, h: number): void {
    for (const p of this.polys) p.mat.resolution.set(w, h);
  }

  setSelected(sel: boolean): void {
    this.selected = sel;
    this.paint(sel ? WHITE : this.base);
  }

  get isSelected(): boolean {
    return this.selected;
  }

  paint(c: Color): void {
    for (const p of this.polys) p.mat.color.copy(c);
    for (const m of this.mats) m.color.copy(c);
  }

  update(c: GizmoCtx): void {
    this.fn?.(c, this);
    this.updateLabel(c);
  }

  private updateLabel(c: GizmoCtx): void {
    const spec = this.labelSpec;
    if (!spec || !this.selected || typeof document === 'undefined') {
      if (this.label) this.label.sprite.visible = false;
      return;
    }
    if (spec === 'swingTwist' && !c.live) {
      if (this.label) this.label.sprite.visible = false;
      return;
    }
    if (!this.label) {
      this.label = new Label();
      this.group.add(this.label.sprite);
    }
    const l = this.label;
    if (spec === 'angle') l.show(LabelKind.Degrees, c.live ? c.value : c.def.params.refOffset);
    else if (spec === 'position') l.show(LabelKind.Metres, c.live ? c.value : c.def.params.refOffset);
    else if (spec === 'length') l.show(LabelKind.Metres, c.live ? c.value : c.a.distanceTo(c.b));
    else l.show(LabelKind.SwingTwist, c.value, c.speed);
    l.sprite.visible = true;
    l.sprite.position.set(0, 0.75 * c.s, 0);
    l.sprite.scale.set(2.5 * c.s, 0.5 * c.s, 1);
  }

  dispose(): void {
    for (const p of this.polys) p.dispose();
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
    this.label?.dispose();
    this.group.clear();
  }
}

// ---- building blocks ---------------------------------------------------------------------------------------------------

/** Circle in the XZ plane (rotation about +Y by `t` maps X to (cos t, 0, −sin t)); optionally with a diameter as a spoke. */
function fillCircle(p: Poly, spoke: boolean): void {
  const seg = spoke ? p.n - 2 : p.n - 1;
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * TAU;
    p.set(i, Math.cos(t), 0, -Math.sin(t));
  }
  if (spoke) {
    p.set(p.n - 2, -1, 0, 0);
    p.set(p.n - 1, 1, 0, 0);
  }
  p.commit();
}

/** Circle with `teeth` square teeth; radius 1 at the tips, `1 − depth` at the roots. */
function fillToothed(p: Poly, teeth: number, depth: number): void {
  const prof = [
    [0, 1 - depth],
    [0.12, 1],
    [0.48, 1],
    [0.6, 1 - depth],
  ];
  let i = 0;
  for (let k = 0; k < teeth; k++)
    for (const [f, r] of prof) {
      const t = ((k + f) / teeth) * TAU;
      p.set(i++, r * Math.cos(t), 0, -r * Math.sin(t));
    }
  p.set(i, 1 - depth, 0, 0);
  p.commit();
}

const toothedPoints = (teeth: number) => teeth * 4 + 1;

/** Arc in the XZ plane from angle t0 to t1 (about +Y), unit radius. */
function fillArc(p: Poly, t0: number, t1: number, from = 0, count = p.n): void {
  for (let i = 0; i < count; i++) {
    const t = t0 + ((t1 - t0) * i) / (count - 1);
    p.set(from + i, Math.cos(t), 0, -Math.sin(t));
  }
}

/** Translucent sector (fan) in the XZ plane. */
function fanGeometry(t0: number, t1: number, segs: number): BufferGeometry {
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = t0 + ((t1 - t0) * i) / segs;
    pos.push(Math.cos(t), 0, -Math.sin(t));
    if (i > 0) idx.push(0, i, i + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

interface ArcArrow {
  grp: Group;
  poly: Poly;
  head: Mesh | null;
}

/** Unit-radius arc (about +Y) with an optional arrow head; `grp` is placed / scaled by the caller. */
function arcArrow(g: Gizmo, parent: Object3D, t0: number, t1: number, head: boolean, opacity = 0.95): ArcArrow {
  const grp = new Group();
  parent.add(grp);
  const poly = g.poly(24, { parent: grp, opacity });
  fillArc(poly, t0, t1);
  poly.commit();
  let h: Mesh | null = null;
  if (head) {
    h = g.mesh(shared.cone, { parent: grp, opacity });
    h.position.set(Math.cos(t1), 0, -Math.sin(t1));
    tV.set(-Math.sin(t1), 0, -Math.cos(t1)).multiplyScalar(Math.sign(t1 - t0) || 1); // tangent of the travel direction
    h.quaternion.setFromUnitVectors(Y, tV.normalize());
  }
  return { grp, poly, head: h };
}

/** Scale an arc arrow to a world radius, keeping its head a constant size. */
function setArc(a: ArcArrow, r: number, headSize: number): void {
  a.grp.scale.setScalar(r);
  a.head?.scale.setScalar(headSize / Math.max(r, 1e-6));
}

// ---- builders ---------------------------------------------------------------------------------------------------------

type Builder = (g: Gizmo) => void;

/** Hinge: limit arc (min..max about the axis) with a live pointer; shown in edit mode too. */
const buildHinge: Builder = (g) => {
  const d = g.def;
  g.labelSpec = 'angle';
  const fr = new Group();
  g.group.add(fr);
  if (d.limit.enabled) {
    const lo = Math.min(d.limit.min, d.limit.max);
    const hi = Math.max(d.limit.min, d.limit.max);
    const fan = g.mesh(fanGeometry(lo, hi, 32), { parent: fr, opacity: 0.13, double: true, own: true });
    fan.scale.setScalar(1);
    const edge = g.poly(32 + 4, { parent: fr });
    // radial tick, arc, radial tick
    edge.set(0, 0.86 * Math.cos(lo), 0, -0.86 * Math.sin(lo));
    fillArc(edge, lo, hi, 1, 34);
    edge.set(35, 0.86 * Math.cos(hi), 0, -0.86 * Math.sin(hi));
    edge.commit();
  }
  const zero = g.poly(2, { parent: fr, opacity: 0.45, width: 1.5 });
  zero.set(0, 0.82, 0, 0);
  zero.set(1, 1.0, 0, 0);
  zero.commit();
  const ptr = g.poly(2, { parent: fr });
  ptr.set(0, 0, 0, 0);
  ptr.set(1, 1.08, 0, 0);
  ptr.commit();
  const knob = g.mesh(shared.sphere, { parent: ptr.line });
  knob.position.set(1.08, 0, 0);
  knob.scale.setScalar(0.2);
  g.fn = (c) => {
    axisFrameY(c.qA, c.def.axis, tQ);
    fr.quaternion.copy(tQ);
    fr.scale.setScalar(0.36 * c.s);
    ptr.line.rotation.y = c.live ? c.value : c.def.params.refOffset;
  };
};

/** Slider: the classic gizmo draws the rail; this adds the readout. */
const buildSlider: Builder = (g) => {
  g.labelSpec = 'position';
};

const buildLengthLabel: Builder = (g) => {
  g.labelSpec = 'length';
};

/** Cone-twist: translucent swing cone about the axis, twist arc between twistMin..twistMax, live twist pointer. */
const buildConeTwist: Builder = (g) => {
  const p = g.def.params;
  g.labelSpec = 'swingTwist';
  const fr = new Group();
  g.group.add(fr);
  // cone surface: apex at the anchor, rim at the swing half angle (the rim lies on a unit sphere cap)
  const segs = 40;
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  const sw = p.swing;
  const rim = (t: number, out: number[]) =>
    out.push(Math.sin(sw) * Math.cos(t), Math.cos(sw), -Math.sin(sw) * Math.sin(t));
  for (let i = 0; i <= segs; i++) {
    rim((i / segs) * TAU, pos);
    if (i > 0) idx.push(0, i, i + 1);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  g.mesh(geo, { parent: fr, opacity: 0.16, double: true, own: true });
  const edge = g.poly(segs + 1 + 8, { parent: fr });
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * TAU;
    edge.set(i, Math.sin(sw) * Math.cos(t), Math.cos(sw), -Math.sin(sw) * Math.sin(t));
  }
  let k = segs + 1;
  for (let q = 1; q <= 4; q++) {
    const t = (q / 4) * TAU;
    edge.set(k++, 0, 0, 0);
    edge.set(k++, Math.sin(sw) * Math.cos(t), Math.cos(sw), -Math.sin(sw) * Math.sin(t));
  }
  edge.commit();
  // twist range: arc, end ticks, zero tick, live pointer (all at the anchor plane, 0.42 of the cone length)
  const R = 0.42;
  const lo = Math.min(p.twistMin, p.twistMax);
  const hi = Math.max(p.twistMin, p.twistMax);
  const twFan = g.mesh(fanGeometry(lo, hi, 24), { parent: fr, opacity: 0.2, double: true, own: true });
  twFan.scale.setScalar(R);
  const arc = g.poly(28, { parent: fr, width: 2.6 });
  arc.set(0, 0, 0, 0);
  fillArc(arc, lo, hi, 1, 26);
  arc.set(27, 0, 0, 0);
  arc.commit();
  arc.line.scale.setScalar(R);
  const zero = g.poly(2, { parent: fr, opacity: 0.45, width: 1.5 });
  zero.set(0, 0.8 * R, 0, 0);
  zero.set(1, 1.1 * R, 0, 0);
  zero.commit();
  const ptr = g.poly(2, { parent: fr });
  ptr.set(0, 0, 0, 0);
  ptr.set(1, 1.15 * R, 0, 0);
  ptr.commit();
  g.fn = (c) => {
    axisFrameY(c.qA, c.def.axis, tQ);
    fr.quaternion.copy(tQ);
    fr.scale.setScalar(1.25 * c.s);
    ptr.line.visible = c.live;
    ptr.line.rotation.y = c.speed; // conetwist reports the twist in `J.speed`, the swing in `J.value`
  };
};

/** 6-DOF: axis triad (joint frame, X along the axis); each DOF shows its limits, an open arrow when free, a dim stub when locked. */
const buildSixDof: Builder = (g) => {
  const dof = g.def.params.dof;
  const fr = new Group();
  g.group.add(fr);
  const E = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const lin: { line: Poly; a: Mesh | null; b: Mesh | null }[] = [];
  for (let i = 0; i < 3; i++) {
    const d = dof[i];
    const locked = d.mode === 'locked';
    const line = g.poly(2, { parent: fr, opacity: locked ? 0.3 : 0.95, width: locked ? 1.5 : 2.4 });
    line.set(0, 0, 0, 0);
    line.set(1, E[i].x, E[i].y, E[i].z);
    line.commit();
    let a: Mesh | null = null;
    let b: Mesh | null = null;
    if (d.mode === 'free') {
      a = g.mesh(shared.cone, { parent: fr });
      b = g.mesh(shared.cone, { parent: fr });
      a.quaternion.setFromUnitVectors(Y, E[i]);
      b.quaternion.setFromUnitVectors(Y, tV.copy(E[i]).negate());
    } else if (d.mode === 'limited') {
      a = g.mesh(shared.box, { parent: fr });
      b = g.mesh(shared.box, { parent: fr });
    }
    lin.push({ line, a, b });
  }
  const ang: { arc: ArcArrow; mode: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const d = dof[3 + i];
    const lo = Math.min(d.min, d.max);
    const hi = Math.max(d.min, d.max);
    const arc =
      d.mode === 'limited'
        ? arcArrow(g, fr, lo, hi, false)
        : d.mode === 'free'
          ? arcArrow(g, fr, 0.15, 0.15 + 1.55 * Math.PI, true)
          : arcArrow(g, fr, 0, TAU, false, 0.28);
    // rotation about frame axis i: local +Y -> E[i], local +X -> the next axis (X: Y, Y: Z, Z: X)
    orient(arc.grp, E[(i + 1) % 3], E[i]);
    ang.push({ arc, mode: d.mode });
  }
  g.fn = (c) => {
    axisFrameX(c.qA, c.def.axis, tQ);
    fr.quaternion.copy(tQ);
    const s = c.s;
    for (let i = 0; i < 3; i++) {
      const d = dof[i];
      const { line, a, b } = lin[i];
      let lo: number;
      let hi: number;
      if (d.mode === 'locked') {
        lo = -0.25 * s;
        hi = 0.25 * s;
      } else if (d.mode === 'free') {
        lo = -1.1 * s;
        hi = 1.1 * s;
      } else {
        lo = Math.min(d.min, d.max);
        hi = Math.max(d.min, d.max);
      }
      line.line.scale.set(1, 1, 1);
      line.line.scale.setComponent(i, hi - lo);
      line.line.position.set(0, 0, 0).setComponent(i, lo);
      if (a && b) {
        a.position.set(0, 0, 0).setComponent(i, hi);
        b.position.set(0, 0, 0).setComponent(i, lo);
        a.scale.setScalar(d.mode === 'free' ? s * 1.4 : 0.07 * s);
        b.scale.setScalar(d.mode === 'free' ? s * 1.4 : 0.07 * s);
      }
    }
    for (let i = 0; i < 3; i++) setArc(ang[i].arc, (0.34 + 0.07 * i) * s, 0.06 * s);
  };
};

/** Universal (cardan): shaft, a ring across it and a ring through it, pinned where they cross. */
const buildUniversal: Builder = (g) => {
  const fr = new Group();
  g.group.add(fr);
  const shaft = g.poly(2, { parent: fr });
  shaft.set(0, 0, -1, 0);
  shaft.set(1, 0, 1, 0);
  shaft.commit();
  const r1 = g.poly(49, { parent: fr });
  fillCircle(r1, false);
  const r2 = g.poly(49, { parent: fr });
  fillCircle(r2, false);
  r2.line.rotation.x = Math.PI / 2; // contains the shaft
  const t1 = g.mesh(shared.cone, { parent: fr });
  t1.position.y = 1.0;
  const t2 = g.mesh(shared.cone, { parent: fr });
  t2.position.y = -1.0;
  t2.rotation.x = Math.PI;
  const pinA = g.mesh(shared.sphere, { parent: fr });
  const pinB = g.mesh(shared.sphere, { parent: fr });
  g.fn = (c) => {
    axisFrameY(c.qA, c.def.axis, tQ);
    fr.quaternion.copy(tQ);
    const s = c.s;
    fr.scale.setScalar(1);
    shaft.line.scale.setScalar(1.1 * s);
    r1.line.scale.setScalar(0.34 * s);
    r2.line.scale.setScalar(0.34 * s);
    t1.position.y = 1.1 * s;
    t2.position.y = -1.1 * s;
    t1.scale.setScalar(s);
    t2.scale.setScalar(s);
    pinA.position.x = 0.34 * s;
    pinB.position.x = -0.34 * s;
    pinA.scale.setScalar(0.07 * s);
    pinB.scale.setScalar(0.07 * s);
  };
};

/** Soft weld: the weld cube with a spring wave through it along the axis (and across, in the other plane). */
const buildSoftWeld: Builder = (g) => {
  const fr = new Group();
  g.group.add(fr);
  const cube = g.mesh(shared.box, { parent: fr });
  cube.rotation.set(0.6, 0.6, 0);
  const N = 25;
  const waves = [g.poly(N, { parent: fr }), g.poly(N, { parent: fr })];
  for (let w = 0; w < 2; w++)
    for (let i = 0; i < N; i++) {
      const y = (i / (N - 1) - 0.5) * 1.6;
      const amp = i === 0 || i === N - 1 ? 0 : i % 2 ? 0.1 : -0.1;
      waves[w].set(i, w === 0 ? amp : 0, y, w === 1 ? amp : 0);
    }
  for (const w of waves) w.commit();
  g.fn = (c) => {
    axisFrameY(c.qA, c.def.axis, tQ);
    fr.quaternion.copy(tQ);
    fr.scale.setScalar(c.s);
    cube.scale.setScalar(0.17);
  };
};

/** Screw: a helix along the shaft whose pitch is the joint's pitch (right-handed for a positive pitch). */
const buildScrew: Builder = (g) => {
  const pitch = g.def.params.pitch;
  const TURNS = 4;
  const per = 24;
  const fr = new Group();
  g.group.add(fr);
  const helix = g.poly(TURNS * per + 1, { parent: fr, width: 2.6 });
  const len = Math.abs(pitch) * TURNS;
  for (let i = 0; i <= TURNS * per; i++) {
    const t = (i / per) * TAU;
    helix.set(i, Math.cos(t), (pitch * t) / TAU - (len / 2) * Math.sign(pitch), -Math.sin(t));
  }
  helix.commit();
  const shaft = g.poly(2, { parent: fr, opacity: 0.55, width: 1.5 });
  shaft.set(0, 0, -1, 0);
  shaft.set(1, 0, 1, 0);
  shaft.commit();
  const t1 = g.mesh(shared.cone, { parent: fr });
  const t2 = g.mesh(shared.cone, { parent: fr });
  t2.rotation.x = Math.PI;
  g.fn = (c) => {
    axisFrameY(c.qA, c.def.axis, tQ);
    fr.quaternion.copy(tQ);
    helix.line.scale.set(0.14 * c.s, 1, 0.14 * c.s);
    const ext = len / 2 + 0.25 * c.s;
    shaft.line.scale.setScalar(ext);
    t1.position.y = ext;
    t2.position.y = -ext;
    t1.scale.setScalar(c.s);
    t2.scale.setScalar(c.s);
  };
};

/** Point at angle `ang` on a circle of radius `r` around `o` in the plane spanned by the scratch vectors tE1 / tE2. */
function polar(p: Poly, i: number, o: Vector3, r: number, ang: number): void {
  const ca = r * Math.cos(ang);
  const sa = r * Math.sin(ang);
  p.set(i, o.x + ca * tE1.x + sa * tE2.x, o.y + ca * tE1.y + sa * tE2.y, o.z + ca * tE1.z + sa * tE2.z);
}

function toothCount(r: number, minR: number, base = 14): number {
  const pitch = (TAU * minR) / base;
  return Math.max(6, Math.min(60, Math.round((TAU * r) / pitch)));
}

interface Wheel {
  ring: Poly;
  disc: Mesh;
  teeth: number;
}

/** A disc + toothed (or plain) ring that rotates with its body. */
function wheel(g: Gizmo, teeth: number, depthFrac: number): Wheel {
  const ring = g.poly(teeth > 0 ? toothedPoints(teeth) : 50, { width: 2.4 });
  if (teeth > 0) fillToothed(ring, teeth, depthFrac);
  else fillCircle(ring, true);
  const disc = g.mesh(shared.disc, { opacity: 0.08, double: true });
  return { ring, disc, teeth };
}

/** Place a wheel: centre relative to the group (anchor A), world axis, body-attached reference and radius. */
function placeWheel(w: Wheel, centre: Vector3, n: Vector3, ref: Vector3, r: number): void {
  w.ring.line.position.copy(centre);
  w.disc.position.copy(centre);
  orient(w.ring.line, ref, n);
  w.disc.quaternion.copy(w.ring.line.quaternion);
  w.ring.line.scale.setScalar(r);
  w.disc.scale.set(r, 1, r);
}

/** Gear pair: two toothed discs at the anchors (radii radiusA / radiusB), a mesh marker and one turning arrow per disc. */
const buildGear: Builder = (g) => {
  const p = g.def.params;
  const minR = Math.min(p.radiusA, p.radiusB);
  const nA = toothCount(p.radiusA, minR);
  const nB = toothCount(p.radiusB, minR);
  const wa = wheel(g, nA, (0.28 * TAU) / nA);
  const wb = wheel(g, nB, (0.28 * TAU) / nB);
  const link = g.poly(2, { opacity: 0.4, width: 1.5 });
  const mark = g.mesh(shared.sphere);
  const arrA = arcArrow(g, g.group, 0.2, 0.2 + 0.6 * Math.PI, true);
  const arrB = arcArrow(g, g.group, 0.2, 0.2 + 0.6 * Math.PI, true);
  g.fn = (c) => {
    const s = c.s;
    tV.copy(c.b).sub(c.a); // centre line (relative to A)
    bodyRef(c.def.axis, c.qA, tU);
    placeWheel(wa, tW.set(0, 0, 0), c.axis, tU, p.radiusA);
    bodyRef(p.axisB, c.qB, tU);
    placeWheel(wb, tV, c.axisB, tU, p.radiusB);
    // mesh marker on the centre line at the pitch contact
    const D = tV.length();
    const k = D > 1e-6 ? p.radiusA / (p.radiusA + p.radiusB) : 0;
    tP.copy(tV).multiplyScalar(k);
    mark.position.copy(tP);
    mark.scale.setScalar(0.12 * s);
    link.set(0, 0, 0, 0);
    link.setV(1, tV);
    link.commit();
    // turning arrows: B's follows the coupling sign (opposite about its own axis when reversing)
    const ra = 0.62 * p.radiusA;
    const rb = 0.62 * p.radiusB;
    arrA.grp.position.set(0, 0, 0);
    bodyRef(c.def.axis, c.qA, tU);
    orient(arrA.grp, tU, c.axis);
    setArc(arrA, ra, 0.9 * s);
    arrB.grp.position.copy(tV);
    bodyRef(p.axisB, c.qB, tU);
    if (p.reverse) tW.copy(c.axisB).negate();
    else tW.copy(c.axisB);
    orient(arrB.grp, tU.sub(tP.copy(tW).multiplyScalar(tU.dot(tW))).normalize(), tW);
    setArc(arrB, rb, 0.9 * s);
  };
};

/** Rack and pinion: a pinion at A (radiusA) and a toothed bar through B along `params.axisB`. */
const buildRack: Builder = (g) => {
  const p = g.def.params;
  const nT = Math.max(10, Math.min(28, Math.round(p.radiusA * 30)));
  const pitch = (TAU * p.radiusA) / nT;
  const depth = 0.28 * pitch;
  const nb = Math.min(48, Math.round(1.5 * nT));
  const barLen = nb * pitch;
  const pin = wheel(g, nT, (0.28 * TAU) / nT);
  const teeth = g.poly(nb * 4 + 1, { width: 2.4 });
  const back = g.poly(2, { width: 2 });
  const body = g.mesh(shared.box, { opacity: 0.14 });
  const mark = g.mesh(shared.sphere);
  const arr = arcArrow(g, g.group, 0.2, 0.2 + 0.6 * Math.PI, true);
  g.fn = (c) => {
    const s = c.s;
    bodyRef(c.def.axis, c.qA, tU);
    placeWheel(pin, tW.set(0, 0, 0), c.axis, tU, p.radiusA);
    // bar frame: dir along the travel axis, w from the bar toward the pinion
    tV.copy(c.axisB); // dir
    tW.copy(c.a).sub(c.b);
    tW.addScaledVector(tV, -tW.dot(tV));
    if (tW.lengthSq() < 1e-8) perp(tV, tW);
    else tW.normalize();
    tU.copy(c.b).sub(c.a); // bar anchor relative to A
    // teeth profile: root on the anchor line, tips `depth` toward the pinion; the phase is fixed to the bar
    let i = 0;
    for (let k = 0; k < nb; k++)
      for (let q = 0; q < 4; q++) {
        const f = q === 0 ? 0 : q === 1 ? 0.12 : q === 2 ? 0.48 : 0.6;
        const up = q === 1 || q === 2 ? depth : 0;
        const along = (k + f - nb / 2) * pitch;
        teeth.set(
          i++,
          tU.x + tV.x * along + tW.x * up,
          tU.y + tV.y * along + tW.y * up,
          tU.z + tV.z * along + tW.z * up,
        );
      }
    teeth.set(i, tU.x + tV.x * (nb / 2) * pitch, tU.y + tV.y * (nb / 2) * pitch, tU.z + tV.z * (nb / 2) * pitch);
    teeth.commit();
    const th = 0.5 * pitch + depth;
    back.set(
      0,
      tU.x - (tV.x * barLen) / 2 - tW.x * th,
      tU.y - (tV.y * barLen) / 2 - tW.y * th,
      tU.z - (tV.z * barLen) / 2 - tW.z * th,
    );
    back.set(
      1,
      tU.x + (tV.x * barLen) / 2 - tW.x * th,
      tU.y + (tV.y * barLen) / 2 - tW.y * th,
      tU.z + (tV.z * barLen) / 2 - tW.z * th,
    );
    back.commit();
    // translucent bar body
    tP.crossVectors(tV, tW);
    tM.makeBasis(tV, tW, tP);
    body.quaternion.setFromRotationMatrix(tM);
    body.position.copy(tU).addScaledVector(tW, (depth - th) / 2);
    body.scale.set(barLen, th + depth, 0.5 * pitch + 0.02);
    // mesh marker: where the pinion touches the bar line
    mark.position.copy(tU);
    mark.scale.setScalar(0.12 * s);
    // direction of travel when the pinion turns positively
    arr.grp.position.set(0, 0, 0);
    bodyRef(c.def.axis, c.qA, tU);
    orient(arr.grp, tU, c.axis);
    setArc(arr, 0.62 * p.radiusA, 0.9 * s);
  };
};

/** Belt / chain: two pulley rings and the open (or crossed, when reversing) tangent belt as one closed loop. */
const buildBelt: Builder = (g) => {
  const p = g.def.params;
  const ARC = 14;
  const N = (ARC + 1) * 2 + 1;
  const loop = g.poly(N, { width: 2.6, dashed: p.chain });
  const ra = wheel(g, 0, 0);
  const rb = wheel(g, 0, 0);
  const link = g.poly(2, { opacity: 0.3, width: 1.2 });
  g.fn = (c) => {
    const s = c.s;
    tV.copy(c.b).sub(c.a);
    bodyRef(c.def.axis, c.qA, tU);
    placeWheel(ra, tW.set(0, 0, 0), c.axis, tU, p.radiusA);
    bodyRef(p.axisB, c.qB, tU);
    placeWheel(rb, tV, c.axisB, tU, p.radiusB);
    link.set(0, 0, 0, 0);
    link.setV(1, tV);
    link.commit();
    // belt plane: perpendicular to A's axis, e1 along the (projected) centre line
    const nA = c.axis;
    tP.copy(tV).addScaledVector(nA, -tV.dot(nA));
    const D = tP.length();
    if (D < 1e-6) {
      loop.line.visible = false;
      return;
    }
    loop.line.visible = true;
    const e1x = tP.x / D;
    const e1y = tP.y / D;
    const e1z = tP.z / D;
    tE1.set(e1x, e1y, e1z);
    tE2.crossVectors(nA, tE1);
    const rA = p.radiusA;
    const rB = p.radiusB;
    const cross = p.reverse;
    const th = Math.acos(Math.max(-1, Math.min(1, (cross ? rA + rB : rA - rB) / D)));
    let k = 0;
    // arc on B (the side away from A), from the +θ contact to the −θ contact
    const b0 = cross ? Math.PI + th : th;
    const b1 = cross ? 3 * Math.PI - th : -th;
    for (let i = 0; i <= ARC; i++) polar(loop, k++, tP, rB, b0 + ((b1 - b0) * i) / ARC);
    // arc on A (the side away from B), from the −θ contact round the back to the +θ contact
    const a0 = -th;
    const a1 = th - TAU;
    for (let i = 0; i <= ARC; i++) polar(loop, k++, tO.set(0, 0, 0), rA, a0 + ((a1 - a0) * i) / ARC);
    polar(loop, k, tP, rB, b0); // closes the loop on the first B point
    if (p.chain) {
      loop.mat.dashSize = 0.06 * s;
      loop.mat.gapSize = 0.05 * s;
    }
    loop.commit();
  };
};

/** Pulley: the two fixed wheels, the rope from each body anchor over them, tinted by tension. */
const buildPulley: Builder = (g) => {
  const wA = g.poly(49, { width: 2 });
  const wB = g.poly(49, { width: 2 });
  fillCircle(wA, true);
  fillCircle(wB, true);
  const hubA = g.mesh(shared.sphere);
  const hubB = g.mesh(shared.sphere);
  const rope = g.poly(4, { width: 2.6 });
  g.fn = (c) => {
    const s = c.s;
    const pr = c.def.params;
    // wheel plane: contains the line between the wheels and the world up (or X when they are stacked vertically)
    tV.set(pr.pulleyB[0] - pr.pulleyA[0], pr.pulleyB[1] - pr.pulleyA[1], pr.pulleyB[2] - pr.pulleyA[2]);
    if (tV.lengthSq() < 1e-10) tV.set(1, 0, 0);
    tV.normalize();
    tW.copy(Y);
    if (Math.abs(tV.y) > 0.95) tW.copy(X);
    tU.crossVectors(tV, tW).normalize(); // wheel axis
    for (let w = 0; w < 2; w++) {
      const P = w === 0 ? pr.pulleyA : pr.pulleyB;
      const poly = w === 0 ? wA : wB;
      const hub = w === 0 ? hubA : hubB;
      tP.set(P[0] - c.a.x, P[1] - c.a.y, P[2] - c.a.z);
      poly.line.position.copy(tP);
      hub.position.copy(tP);
      orient(poly.line, tV, tU);
      poly.line.scale.setScalar(0.13 * s);
      hub.scale.setScalar(0.07 * s);
    }
    rope.set(0, 0, 0, 0);
    rope.set(1, pr.pulleyA[0] - c.a.x, pr.pulleyA[1] - c.a.y, pr.pulleyA[2] - c.a.z);
    rope.set(2, pr.pulleyB[0] - c.a.x, pr.pulleyB[1] - c.a.y, pr.pulleyB[2] - c.a.z);
    rope.set(3, c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z);
    rope.commit();
    if (c.live)
      rope.mat.color.copy(
        lerpTension(tC, g.isSelected ? WHITE : g.base, c.force, pr.loadRating > 0 ? pr.loadRating : 100),
      );
    else rope.mat.color.copy(g.isSelected ? WHITE : g.base);
  };
};

/** Winch: a spool (radiusA) at the anchor with its rope to anchor B, tinted by tension. */
const buildWinch: Builder = (g) => {
  g.labelSpec = 'length';
  const drum = g.mesh(shared.drum, { opacity: 0.2, double: true });
  const fl1 = g.poly(49, { width: 2.4 });
  const fl2 = g.poly(49, { width: 2.4 });
  fillCircle(fl1, true);
  fillCircle(fl2, false);
  const rope = g.poly(2, { width: 2.6 });
  const end = g.mesh(shared.sphere);
  g.fn = (c) => {
    const s = c.s;
    const r = c.def.params.radiusA;
    const len = Math.max(0.25 * r, 0.12 * s);
    bodyRef(c.def.axis, c.qA, tU);
    orient(drum, tU, c.axis);
    drum.scale.set(r, len, r);
    for (let f = 0; f < 2; f++) {
      const fl = f === 0 ? fl1 : fl2;
      orient(fl.line, tU, c.axis);
      fl.line.position.copy(c.axis).multiplyScalar(f === 0 ? len / 2 : -len / 2);
      fl.line.scale.setScalar(r);
    }
    rope.set(0, 0, 0, 0);
    rope.set(1, c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z);
    rope.commit();
    end.position.set(c.b.x - c.a.x, c.b.y - c.a.y, c.b.z - c.a.z);
    end.scale.setScalar(0.1 * s);
    const lr = c.def.params.loadRating;
    if (c.live) rope.mat.color.copy(lerpTension(tC, g.isSelected ? WHITE : g.base, c.force, lr > 0 ? lr : 100));
    else rope.mat.color.copy(g.isSelected ? WHITE : g.base);
  };
};

const BUILDERS: Partial<Record<JointEntity['type'], Builder>> = {
  hinge: buildHinge,
  slider: buildSlider,
  spring: buildLengthLabel,
  rope: buildLengthLabel,
  conetwist: buildConeTwist,
  sixdof: buildSixDof,
  universal: buildUniversal,
  softweld: buildSoftWeld,
  screw: buildScrew,
  gear: buildGear,
  rack: buildRack,
  belt: buildBelt,
  pulley: buildPulley,
  winch: buildWinch,
};

/** The extra gizmo of a joint (limit arc, readout, new types), or null when the classic gizmo is everything. */
export function makeGizmo(def: JointEntity, color: string, res: { w: number; h: number }): Gizmo | null {
  const build = BUILDERS[def.type];
  if (!build) return null;
  const g = new Gizmo(def, color, res);
  build(g);
  g.setSelected(false);
  return g;
}

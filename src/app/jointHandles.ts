/**
 * Draggable handles of the selected joint (JT-20), shown in the viewport in edit mode: one for each anchor
 * (A, and B for the types with independent anchors), one for each fixed point of a pulley, and one at the tip of the
 * axis. Dragging an anchor slides it over the body's surface (snapping to centre / face / edge / corner like the
 * joint tool); dragging the axis tip swings the axis (snapping to the world axes when close, Shift for free).
 * A drag is one undo step. The handles are hit-tested in screen space, before the transform gizmo and the orbit
 * controls see the press, so normal selection is untouched when the pointer is not on a handle.
 */
import {
  Group,
  Line,
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  OctahedronGeometry,
  ConeGeometry,
  Vector3,
} from 'three';
import { qrot, qrotInv, vsub, type Quat, type Vec3 } from '../core/math';
import { findSnap, snapCandidates, type SnapHit } from '../model/jointDefaults';
import { AXIS_TYPES, hasIndependentAnchors } from '../model/jointParams';
import type { JointEntity } from '../model/types';
import type { App } from './app';

export type HandleKind = 'anchorA' | 'anchorB' | 'pulleyA' | 'pulleyB' | 'axis';

/** Screen radius (px) within which the pointer grabs a handle. */
const GRAB_PX = 12;
/** Drawn size of a handle (px diameter). */
const HANDLE_PX = 13;
/** Length of the axis arm (px). */
const AXIS_ARM_PX = 96;
/** The axis snaps to a world axis within this angle (radians). */
const AXIS_SNAP = (8 * Math.PI) / 180;

const COLORS: Record<HandleKind, number> = {
  anchorA: 0xffb347,
  anchorB: 0x5be3a1,
  pulleyA: 0xc79bff,
  pulleyB: 0xc79bff,
  axis: 0x3ddcff,
};

const TITLES: Record<HandleKind, string> = {
  anchorA: 'Anchor A',
  anchorB: 'Anchor B',
  pulleyA: 'Fixed point A',
  pulleyB: 'Fixed point B',
  axis: 'Axis',
};

export interface JointWorldFrame {
  a: Vector3;
  b: Vector3;
  axis: Vector3;
}

const _p: Vec3 = [0, 0, 0];

/** World anchors and axis of a joint from the current poses (live in a simulation, the document in the editor). */
export function jointWorldFrame(app: App, j: JointEntity, out: JointWorldFrame): JointWorldFrame | null {
  const pa = j.bodyA ? app.sim.poseOf(j.bodyA) : null;
  const pb = j.bodyB ? app.sim.poseOf(j.bodyB) : null;
  if ((j.bodyA && !pa) || (j.bodyB && !pb)) return null;
  const toWorld = (pose: { position: Vec3; rotation: Quat } | null, local: Vec3, into: Vector3): void => {
    if (!pose) {
      into.set(local[0], local[1], local[2]);
      return;
    }
    const w = qrot(pose.rotation, local);
    into.set(w[0] + pose.position[0], w[1] + pose.position[1], w[2] + pose.position[2]);
  };
  toWorld(pa, j.anchorA, out.a);
  if (hasIndependentAnchors(j.type)) toWorld(pb, j.anchorB, out.b);
  else out.b.copy(out.a);
  if (pa) {
    const ax = qrot(pa.rotation, j.axis);
    out.axis.set(ax[0], ax[1], ax[2]);
  } else out.axis.set(j.axis[0], j.axis[1], j.axis[2]);
  if (out.axis.lengthSq() < 1e-12) out.axis.set(0, 0, 1);
  out.axis.normalize();
  return out;
}

interface Handle {
  kind: HandleKind;
  mesh: Mesh;
  world: Vector3;
  active: boolean;
}

type Drag = { kind: HandleKind; jointId: string; pointerId: number };

export class JointHandles {
  readonly group = new Group();
  private readonly handles: Handle[] = [];
  private readonly arm: Line;
  private readonly armAttr: Float32BufferAttribute;
  private readonly geoms: BufferGeometry[] = [];
  private readonly mats: (MeshBasicMaterial | LineBasicMaterial)[] = [];
  private readonly frame: JointWorldFrame = { a: new Vector3(), b: new Vector3(), axis: new Vector3() };
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly snapOut: SnapHit = { kind: 'center', world: [0, 0, 0], normal: null };
  private drag: Drag | null = null;
  private hover: HandleKind | null = null;
  private joint: JointEntity | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(private app: App) {
    const sphere = new SphereGeometry(0.5, 14, 10);
    const diamond = new OctahedronGeometry(0.55);
    const cone = new ConeGeometry(0.5, 1.2, 14);
    this.geoms.push(sphere, diamond, cone);
    const make = (kind: HandleKind, g: BufferGeometry): Handle => {
      const mat = new MeshBasicMaterial({
        color: COLORS[kind],
        depthTest: false,
        transparent: true,
        toneMapped: false,
      });
      this.mats.push(mat);
      const mesh = new Mesh(g, mat);
      mesh.renderOrder = 999;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.raycast = () => undefined; // handles are hit-tested on screen, never by the scene picker
      this.group.add(mesh);
      return { kind, mesh, world: new Vector3(), active: false };
    };
    this.handles.push(
      make('anchorA', sphere),
      make('anchorB', sphere),
      make('pulleyA', diamond),
      make('pulleyB', diamond),
      make('axis', cone),
    );
    const armGeo = new BufferGeometry();
    this.armAttr = new Float32BufferAttribute(new Float32Array(6), 3);
    armGeo.setAttribute('position', this.armAttr);
    this.geoms.push(armGeo);
    const armMat = new LineBasicMaterial({
      color: COLORS.axis,
      depthTest: false,
      transparent: true,
      opacity: 0.8,
      toneMapped: false,
    });
    this.mats.push(armMat);
    this.arm = new Line(armGeo, armMat);
    this.arm.renderOrder = 998;
    this.arm.frustumCulled = false;
    this.arm.visible = false;
    this.arm.raycast = () => undefined;
    this.group.add(this.arm);
    this.group.visible = false;
    app.viewport.helpers.add(this.group);

    const dom = app.viewport.dom;
    // Capture phase: a press on a handle must not reach the gizmo, the orbit controls or the selection code.
    const down = (e: PointerEvent) => this.onDown(e);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = (e: PointerEvent) => this.onUp(e);
    dom.addEventListener('pointerdown', down, true);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    this.offs.push(
      () => dom.removeEventListener('pointerdown', down, true),
      () => dom.removeEventListener('pointermove', move),
      () => dom.removeEventListener('pointerup', up),
      () => dom.removeEventListener('pointercancel', up),
      app.on('frame', () => this.update()),
      app.store.on('selection', () => this.update()),
      app.store.on('change', () => this.update()),
      app.prefs.on('change', () => this.update()),
      app.sim.on('mode', () => this.update()),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.app.viewport.helpers.remove(this.group);
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
  }

  /** The joint whose handles are shown: exactly one joint selected, in edit mode, visible, not locked out by a tool. */
  private target(): JointEntity | null {
    const { app } = this;
    if (app.sim.active || app.prefs.value.tool !== 'select') return null;
    const sel = app.store.selection;
    if (sel.length !== 1) return null;
    const j = app.store.joint(sel[0]);
    if (!j || j.hidden || !app.prefs.value.showJoints) return null;
    return j;
  }

  private metresPerPixel(at: Vector3): number {
    const cam = this.app.camera;
    const h = Math.max(1, this.app.viewport.dom.clientHeight);
    return (2 * cam.position.distanceTo(at) * Math.tan((cam.fov * Math.PI) / 360)) / h;
  }

  /** Position and show / hide the handles (every frame while visible, and on selection / document changes). */
  update(): void {
    const j = this.target();
    this.joint = j;
    const f = j ? jointWorldFrame(this.app, j, this.frame) : null;
    if (!j || !f) {
      if (this.group.visible) {
        this.group.visible = false;
        this.setHover(null);
      }
      return;
    }
    this.group.visible = true;
    const independent = hasIndependentAnchors(j.type);
    const pulley = j.type === 'pulley';
    for (const h of this.handles) {
      switch (h.kind) {
        case 'anchorA':
          h.world.copy(f.a);
          h.active = true;
          break;
        case 'anchorB':
          h.world.copy(f.b);
          h.active = independent;
          break;
        case 'pulleyA':
          h.world.set(...j.params.pulleyA);
          h.active = pulley;
          break;
        case 'pulleyB':
          h.world.set(...j.params.pulleyB);
          h.active = pulley;
          break;
        case 'axis': {
          h.active = this.hasAxis(j);
          const len = AXIS_ARM_PX * this.metresPerPixel(f.a);
          h.world.copy(f.axis).multiplyScalar(len).add(f.a);
          break;
        }
      }
      h.mesh.visible = h.active;
      if (!h.active) continue;
      h.mesh.position.copy(h.world);
      const on = this.hover === h.kind || this.drag?.kind === h.kind;
      h.mesh.scale.setScalar(this.metresPerPixel(h.world) * HANDLE_PX * (on ? 1.4 : 1));
      if (h.kind === 'axis') h.mesh.quaternion.setFromUnitVectors(this.tmp.set(0, 1, 0), f.axis);
    }
    const axisHandle = this.handles[4];
    this.arm.visible = axisHandle.active;
    if (axisHandle.active) {
      const a = this.armAttr.array as Float32Array;
      a[0] = f.a.x;
      a[1] = f.a.y;
      a[2] = f.a.z;
      a[3] = axisHandle.world.x;
      a[4] = axisHandle.world.y;
      a[5] = axisHandle.world.z;
      this.armAttr.needsUpdate = true;
    }
  }

  private hasAxis(j: JointEntity): boolean {
    return AXIS_TYPES.includes(j.type);
  }

  // ---- hit testing ---------------------------------------------------------------------------

  /** The handle under the pointer, nearest first, or null. Allocation-free. */
  pick(e: { clientX: number; clientY: number }): HandleKind | null {
    if (!this.group.visible) return null;
    const dom = this.app.viewport.dom;
    const r = dom.getBoundingClientRect();
    const cam = this.app.camera;
    let best: HandleKind | null = null;
    let bestD = GRAB_PX;
    for (const h of this.handles) {
      if (!h.active) continue;
      this.tmp2.copy(h.world).project(cam);
      if (this.tmp2.z > 1 || this.tmp2.z < -1) continue;
      const sx = r.left + ((this.tmp2.x + 1) / 2) * r.width;
      const sy = r.top + ((1 - this.tmp2.y) / 2) * r.height;
      const d = Math.hypot(sx - e.clientX, sy - e.clientY);
      if (d < bestD) {
        bestD = d;
        best = h.kind;
      }
    }
    return best;
  }

  private setHover(k: HandleKind | null): void {
    if (k === this.hover) return;
    this.hover = k;
    const dom = this.app.viewport.dom;
    dom.classList.toggle('joint-handle-hover', k !== null);
    dom.title = k ? `${TITLES[k]} — drag to ${k === 'axis' ? 'turn the axis (Shift: free)' : 'move'}` : '';
    this.update();
  }

  // ---- drag ----------------------------------------------------------------------------------

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || e.altKey || this.drag) return;
    const kind = this.pick(e);
    const j = this.joint;
    if (!kind || !j) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const app = this.app;
    app.viewport.dom.focus({ preventScroll: true });
    app.viewport.dom.setPointerCapture(e.pointerId);
    app.viewport.controls.enabled = false;
    app.store.begin(kind === 'axis' ? 'Turn joint axis' : 'Move joint anchor');
    this.drag = { kind, jointId: j.id, pointerId: e.pointerId };
    app.viewport.dom.classList.add('grabbing');
    this.update();
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) {
      this.setHover(this.pick(e));
      return;
    }
    const app = this.app;
    const j = app.store.joint(d.jointId);
    if (!j) return;
    const f = jointWorldFrame(app, j, this.frame);
    if (!f) return;
    if (d.kind === 'axis') this.dragAxis(e, j, f);
    else this.dragPoint(e, j, d.kind);
    app.refreshGizmo();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    const app = this.app;
    app.store.end();
    app.viewport.controls.enabled = true;
    app.viewport.dom.classList.remove('grabbing');
    if (app.viewport.dom.hasPointerCapture(e.pointerId)) app.viewport.dom.releasePointerCapture(e.pointerId);
    this.setHover(this.pick(e));
    app.refreshGizmo();
  }

  /** Move an anchor or pulley point: over the body's surface (snapped) when the pointer is on its body, else on the view plane. */
  private dragPoint(e: PointerEvent, j: JointEntity, kind: HandleKind): void {
    const app = this.app;
    const handle = this.handles.find((h) => h.kind === kind)!;
    let target: Vec3 | null = null;
    const bodyId = kind === 'anchorA' ? j.bodyA : kind === 'anchorB' ? j.bodyB : null;
    if (bodyId) {
      const hit = app.pickEntity(e, { joints: false, bodies: true });
      const body = hit && hit.entityId === bodyId ? app.store.body(bodyId) : undefined;
      if (hit && body) {
        target = [hit.point.x, hit.point.y, hit.point.z];
        const pose = app.sim.poseOf(bodyId);
        if (pose && app.prefs.value.jointSnap) {
          const tol = 14 * this.metresPerPixel(hit.point);
          const s = findSnap(snapCandidates(body.shape), pose.position, pose.rotation, target, tol, this.snapOut);
          if (s) target = [s.world[0], s.world[1], s.world[2]];
        }
      }
    }
    if (!target) {
      const p = app.picker.cameraPlanePoint(e, handle.world);
      if (!p) return;
      target = [p.x, p.y, p.z];
      if (!bodyId && app.prefs.value.snap) {
        const s = app.prefs.value.snapGrid;
        target = [Math.round(target[0] / s) * s, Math.round(target[1] / s) * s, Math.round(target[2] / s) * s];
      }
    }
    const toLocal = (id: string | null, w: Vec3): Vec3 => {
      const pose = id ? app.sim.poseOf(id) : null;
      return pose ? qrotInv(pose.rotation, vsub(w, pose.position)) : w;
    };
    switch (kind) {
      case 'anchorA': {
        const patch: Partial<JointEntity> = { anchorA: toLocal(j.bodyA, target) };
        // Types that derive B from A keep the stored B anchor on the same world point.
        if (!hasIndependentAnchors(j.type)) patch.anchorB = toLocal(j.bodyB, target);
        app.store.update(j.id, patch, 'Move joint anchor');
        break;
      }
      case 'anchorB':
        app.store.update(j.id, { anchorB: toLocal(j.bodyB, target) }, 'Move joint anchor');
        break;
      case 'pulleyA':
        app.store.update(j.id, { params: { ...j.params, pulleyA: target } }, 'Move pulley point');
        break;
      case 'pulleyB':
        app.store.update(j.id, { params: { ...j.params, pulleyB: target } }, 'Move pulley point');
        break;
      default:
        break;
    }
  }

  /** Swing the axis toward the pointer (on the view plane through the handle); near a world axis it snaps unless Shift is held. */
  private dragAxis(e: PointerEvent, j: JointEntity, f: JointWorldFrame): void {
    const app = this.app;
    const handle = this.handles[4];
    // The tip rides on a sphere around the anchor (radius = arm length): intersect the pointer ray with it, or take the
    // ray's closest approach when it misses, so the axis can swing anywhere, also toward or away from the camera.
    const radius = handle.world.distanceTo(f.a);
    const o = app.picker.rayOrigin(e);
    const d = app.picker.rayDirection(e);
    const oc = this.tmp.copy(o).sub(f.a);
    const b = oc.dot(d);
    const disc = b * b - (oc.lengthSq() - radius * radius);
    const t = disc >= 0 ? -b - Math.sqrt(disc) : -b;
    const dir = this.tmp2.copy(d).multiplyScalar(t).add(o).sub(f.a);
    if (dir.lengthSq() < 1e-8) return;
    dir.normalize();
    if (!e.shiftKey) {
      const axes: Vec3[] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      let best: Vec3 | null = null;
      let bestAngle = AXIS_SNAP;
      for (const a of axes) {
        const dot = dir.x * a[0] + dir.y * a[1] + dir.z * a[2];
        const ang = Math.acos(Math.min(1, Math.abs(dot)));
        if (ang < bestAngle) {
          bestAngle = ang;
          best = dot < 0 ? [-a[0], -a[1], -a[2]] : a;
        }
      }
      if (best) dir.set(best[0], best[1], best[2]);
    }
    const pose = j.bodyA ? app.sim.poseOf(j.bodyA) : null;
    _p[0] = dir.x;
    _p[1] = dir.y;
    _p[2] = dir.z;
    const local = pose ? qrotInv(pose.rotation, _p) : ([dir.x, dir.y, dir.z] as Vec3);
    app.store.update(j.id, { axis: [local[0], local[1], local[2]] }, 'Turn joint axis');
  }
}

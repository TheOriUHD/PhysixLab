/**
 * Joint gizmos: hinge rings, slider rails, ball spheres, weld cubes, spring coils and ropes.
 * They render on top of the bodies (no depth test) so mechanisms stay readable inside
 * assemblies, scale with camera distance and react to the live simulation (spring tension,
 * broken joints).
 */
import {
  BufferGeometry, Color, ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera,
  Quaternion, SphereGeometry, TorusGeometry, Vector3, BoxGeometry,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { JointEntity, JointType } from '../model/types';
import { J, JOINT_STRIDE } from '../physics/protocol';
import type { BodyViews } from './bodyViews';

export const JOINT_COLORS: Record<JointType, string> = {
  fixed: '#ff6b8b',
  hinge: '#ffb347',
  slider: '#5be3a1',
  ball: '#c792ff',
  spring: '#4fd1ff',
  rope: '#d7a86e',
};
const MOTOR_COLOR = '#19e6c1';
const SELECTED = '#ffffff';
const Y = new Vector3(0, 1, 0);

const shared = {
  ring: new TorusGeometry(0.22, 0.014, 8, 48).rotateX(Math.PI / 2),
  ring2: new TorusGeometry(0.29, 0.01, 8, 48).rotateX(Math.PI / 2),
  shaft: new CylinderGeometry(0.012, 0.012, 1, 8),
  cone: new ConeGeometry(0.045, 0.12, 12),
  sphere: new SphereGeometry(0.5, 16, 12),
  box: new BoxGeometry(1, 1, 1),
  disc: new CylinderGeometry(0.12, 0.12, 0.012, 24),
};

function basic(color: string, opacity = 0.95): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity, toneMapped: false });
}

class JointView {
  readonly root = new Group();
  readonly hit: Mesh;
  readonly hitB: Mesh | null;
  readonly parts: Mesh[] = [];
  readonly mats: MeshBasicMaterial[] = [];
  line: Line2 | null = null;
  lineMat: LineMaterial | null = null;
  limitDiscs: Mesh[] = [];
  motorRing: Mesh | null = null;
  rail: Mesh | null = null;
  selected = false;
  broken = false;
  scale = 1;
  def: JointEntity;
  private colorBase: Color;

  constructor(def: JointEntity, resolution: { w: number; h: number }) {
    this.def = def;
    this.colorBase = new Color(JOINT_COLORS[def.type]);
    this.root.userData.entityId = def.id;
    this.build(resolution);
    const hitMat = new MeshBasicMaterial({ visible: false });
    this.hit = new Mesh(shared.sphere, hitMat);
    this.hit.scale.setScalar(0.5);
    this.hit.userData.entityId = def.id;
    this.hit.userData.end = 'A';
    this.root.add(this.hit);
    if (def.type === 'spring' || def.type === 'rope') {
      this.hitB = new Mesh(shared.sphere, hitMat);
      this.hitB.scale.setScalar(0.5);
      this.hitB.userData.entityId = def.id;
      this.hitB.userData.end = 'B';
      this.root.add(this.hitB);
    } else this.hitB = null;
  }

  private add(geo: BufferGeometry, color = JOINT_COLORS[this.def.type], opacity = 0.95): Mesh {
    const m = basic(color, opacity);
    const mesh = new Mesh(geo, m);
    mesh.renderOrder = 999;
    mesh.frustumCulled = false;
    this.mats.push(m);
    this.parts.push(mesh);
    this.root.add(mesh);
    return mesh;
  }

  private build(res: { w: number; h: number }): void {
    const d = this.def;
    switch (d.type) {
      case 'hinge': {
        this.add(shared.ring);
        const shaft = this.add(shared.shaft);
        shaft.scale.set(1, 0.8, 1);
        const tip = this.add(shared.cone);
        tip.position.y = 0.4;
        const tip2 = this.add(shared.cone);
        tip2.position.y = -0.4;
        tip2.rotation.x = Math.PI;
        this.motorRing = this.add(shared.ring2, MOTOR_COLOR);
        break;
      }
      case 'slider': {
        this.rail = this.add(shared.shaft);
        const t1 = this.add(shared.cone); t1.position.y = 0.46;
        const t2 = this.add(shared.cone); t2.position.y = -0.46; t2.rotation.x = Math.PI;
        const knob = this.add(shared.box);
        knob.scale.set(0.12, 0.12, 0.12);
        this.motorRing = this.add(shared.ring2, MOTOR_COLOR);
        const dmin = this.add(shared.disc, '#ffffff', 0.7);
        const dmax = this.add(shared.disc, '#ffffff', 0.7);
        this.limitDiscs = [dmin, dmax];
        break;
      }
      case 'ball': {
        const s = this.add(shared.sphere);
        s.scale.setScalar(0.2);
        const halo = this.add(shared.sphere, JOINT_COLORS.ball, 0.2);
        halo.scale.setScalar(0.34);
        break;
      }
      case 'fixed': {
        const b = this.add(shared.box);
        b.scale.setScalar(0.17);
        b.rotation.set(0.6, 0.6, 0);
        break;
      }
      case 'spring':
      case 'rope': {
        const a = this.add(shared.sphere);
        a.scale.setScalar(0.14);
        const b = this.add(shared.sphere);
        b.scale.setScalar(0.14);
        const lm = new LineMaterial({
          color: 0xffffff, linewidth: d.type === 'spring' ? 2.4 : 2.0, transparent: true, depthTest: false, worldUnits: false,
          opacity: 0.95, toneMapped: false,
        });
        lm.resolution.set(res.w, res.h);
        this.lineMat = lm;
        const line = new Line2(new LineGeometry(), lm);
        line.renderOrder = 998;
        line.frustumCulled = false;
        this.line = line;
        this.root.add(line);
        break;
      }
    }
  }

  setColor(): void {
    const c = this.selected ? new Color(SELECTED) : this.colorBase;
    const motorOn = this.def.motor.mode !== 'off' && (this.def.type === 'hinge' || this.def.type === 'slider');
    for (let i = 0; i < this.mats.length; i++) {
      const m = this.mats[i];
      if (this.parts[i] === this.motorRing) {
        m.color.set(MOTOR_COLOR);
        this.parts[i].visible = motorOn;
      } else if (this.parts[i] === this.limitDiscs[0] || this.parts[i] === this.limitDiscs[1]) {
        m.color.set(this.selected ? SELECTED : '#e8eefc');
      } else if (!(this.def.type === 'ball' && i === 1)) {
        m.color.copy(c);
      }
    }
  }

  dispose(): void {
    for (const m of this.mats) m.dispose();
    this.line?.geometry.dispose();
    this.lineMat?.dispose();
  }
}

export interface JointFrame { a: Vector3; b: Vector3; axis: Vector3 }

const tmpQ = new Quaternion();
const tmpV = new Vector3();

export class JointViews {
  readonly views = new Map<string, JointView>();
  private res = { w: 1, h: 1 };
  visible = true;

  constructor(readonly group: Group, private bodies: BodyViews) {}

  setResolution(w: number, h: number): void {
    this.res = { w, h };
    for (const v of this.views.values()) v.lineMat?.resolution.set(w, h);
  }

  add(def: JointEntity): void {
    this.remove(def.id);
    const v = new JointView(def, this.res);
    v.setColor();
    this.views.set(def.id, v);
    this.group.add(v.root);
  }

  update(def: JointEntity): void {
    // Joint visuals depend on type & geometry — rebuild (cheap).
    const old = this.views.get(def.id);
    const sel = old?.selected ?? false;
    this.add(def);
    this.views.get(def.id)!.selected = sel;
    this.views.get(def.id)!.setColor();
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
      if (s !== v.selected) { v.selected = s; v.setColor(); }
    }
  }

  /** Meshes that can be picked with the pointer. */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    if (!this.visible) return out;
    for (const v of this.views.values()) {
      if (v.def.hidden || v.broken) continue;
      out.push(v.hit);
      if (v.hitB) out.push(v.hitB);
    }
    return out;
  }

  /** World-space anchors + axis for a joint, using the current body view transforms. */
  frameOf(def: JointEntity, out: JointFrame): JointFrame | null {
    const A = def.bodyA ? this.bodies.get(def.bodyA) : null;
    const Bv = def.bodyB ? this.bodies.get(def.bodyB) : null;
    if ((def.bodyA && !A) || (def.bodyB && !Bv)) return null;
    if (A) {
      A.mesh.updateMatrix();
      out.a.set(...def.anchorA).applyQuaternion(A.mesh.quaternion).add(A.mesh.position);
      out.axis.set(...def.axis).applyQuaternion(A.mesh.quaternion);
    } else {
      out.a.set(...def.anchorA);
      out.axis.set(...def.axis);
    }
    out.axis.normalize();
    if (def.type === 'spring' || def.type === 'rope') {
      if (Bv) out.b.set(...def.anchorB).applyQuaternion(Bv.mesh.quaternion).add(Bv.mesh.position);
      else out.b.set(...def.anchorB);
    } else out.b.copy(out.a);
    return out;
  }

  private frame: JointFrame = { a: new Vector3(), b: new Vector3(), axis: new Vector3() };

  /**
   * Per-frame update. `state` is the live joint buffer (or null in edit mode) and `indexOf`
   * maps joint ids into it.
   */
  updateFrame(camera: PerspectiveCamera, state: Float32Array | null, indexOf: (id: string) => number | undefined, broken: Set<string>): void {
    for (const v of this.views.values()) {
      const def = v.def;
      const isBroken = broken.has(def.id);
      v.broken = isBroken;
      const f = this.frameOf(def, this.frame);
      v.root.visible = this.visible && !def.hidden && !isBroken && !!f;
      if (!f || !v.root.visible) continue;
      v.root.position.copy(f.a);
      const dist = camera.position.distanceTo(f.a);
      const s = Math.min(4, Math.max(0.22, dist * 0.05)) * (v.selected ? 1.2 : 1);
      v.scale = s;

      if (def.type === 'hinge' || def.type === 'slider') {
        tmpQ.setFromUnitVectors(Y, f.axis);
        v.root.quaternion.copy(tmpQ);
        v.root.scale.setScalar(s);
        if (def.type === 'slider' && v.rail) {
          // Rail spans the limit range when limits are on.
          const lo = def.limit.enabled ? Math.min(def.limit.min, def.limit.max) / s : -0.45;
          const hi = def.limit.enabled ? Math.max(def.limit.min, def.limit.max) / s : 0.45;
          v.rail.scale.set(1, hi - lo + 0.0001, 1);
          v.rail.position.y = (hi + lo) / 2;
          v.limitDiscs[0].visible = v.limitDiscs[1].visible = def.limit.enabled;
          v.limitDiscs[0].position.y = lo;
          v.limitDiscs[1].position.y = hi;
          // moving carriage knob
          const knob = v.parts[3];
          const idx = state ? indexOf(def.id) : undefined;
          const val = state && idx !== undefined ? state[idx * JOINT_STRIDE + J.value] : 0;
          knob.position.y = val / s;
        }
      } else if (def.type === 'ball' || def.type === 'fixed') {
        v.root.quaternion.identity();
        v.root.scale.setScalar(s);
      } else if (v.line) {
        v.root.quaternion.identity();
        v.root.scale.setScalar(1);
        tmpV.copy(f.b).sub(f.a);
        const len = tmpV.length();
        // end spheres scale with distance
        v.parts[0].position.set(0, 0, 0);
        v.parts[0].scale.setScalar(0.1 * s);
        v.parts[1].position.copy(tmpV);
        v.parts[1].scale.setScalar(0.1 * s);
        v.hit.scale.setScalar(0.4 * s);
        if (v.hitB) { v.hitB.position.copy(tmpV); v.hitB.scale.setScalar(0.4 * s); }
        const pts = def.type === 'spring' ? this.coil(len, tmpV, def, s) : this.rope(len, tmpV, def);
        v.line.geometry.setPositions(pts);
        v.line.computeLineDistances();
        // colour by tension (live) — blue compression ↔ white relaxed ↔ red tension
        let col = v.selected ? new Color(SELECTED) : new Color(JOINT_COLORS[def.type]);
        if (state && def.type === 'spring') {
          const idx = indexOf(def.id);
          if (idx !== undefined) {
            const force = state[idx * JOINT_STRIDE + J.force];
            const ref = def.spring.breakForce > 0 ? def.spring.breakForce : Math.max(1, def.spring.stiffness * Math.max(0.2, def.spring.restLength));
            const t = Math.max(-1, Math.min(1, force / ref));
            col = t >= 0 ? col.lerp(new Color('#ff3b3b'), Math.min(1, t * 1.4)) : col.lerp(new Color('#3b6bff'), Math.min(1, -t * 1.4));
          }
        }
        v.lineMat!.color.copy(col);
        for (const m of v.mats) m.color.copy(col);
      }
    }
  }

  private coil(len: number, d: Vector3, def: JointEntity, s: number): number[] {
    const out: number[] = [];
    if (len < 1e-4) return [0, 0, 0, 0, 0, 0];
    const dir = d.clone().normalize();
    const side = Math.abs(dir.y) < 0.95 ? new Vector3(0, 1, 0).cross(dir).normalize() : new Vector3(1, 0, 0).cross(dir).normalize();
    const up = dir.clone().cross(side).normalize();
    const turns = Math.max(4, Math.min(16, Math.round(def.spring.restLength * 4 + 4)));
    const segs = turns * 14;
    const lead = Math.min(0.12 * s, len * 0.15);
    const r = Math.min(0.1 * s * 0.8, 0.12) * Math.min(1, len / Math.max(0.3, def.spring.restLength) + 0.4);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      let axial = t * len;
      let rad = r;
      if (axial < lead) { rad *= axial / lead; }
      if (axial > len - lead) { rad *= (len - axial) / lead; }
      axial = Math.max(0, Math.min(len, axial));
      const ang = t * turns * Math.PI * 2;
      out.push(
        dir.x * axial + (side.x * Math.cos(ang) + up.x * Math.sin(ang)) * rad,
        dir.y * axial + (side.y * Math.cos(ang) + up.y * Math.sin(ang)) * rad,
        dir.z * axial + (side.z * Math.cos(ang) + up.z * Math.sin(ang)) * rad,
      );
    }
    return out;
  }

  private rope(len: number, d: Vector3, def: JointEntity): number[] {
    // A taut rope is straight; slack is drawn as a catenary-like sag so it looks like a rope.
    const out: number[] = [];
    const slack = Math.max(0, def.ropeLength - len);
    const n = 24;
    const sag = Math.min(def.ropeLength * 0.45, Math.sqrt(slack * def.ropeLength) * 0.5);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push(d.x * t, d.y * t - 4 * sag * t * (1 - t), d.z * t);
    }
    return out;
  }
}

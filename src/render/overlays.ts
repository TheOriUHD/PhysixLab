/**
 * Diagnostic overlays: velocity / net-force vectors, contact points, centres of mass and
 * motion trails. All of them read the live simulation frame — nothing here is decorative.
 */
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, Group, Line, LineBasicMaterial,
  LineSegments, PerspectiveCamera, Points, PointsMaterial, Vector3,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { B, BODY_STRIDE, CONTACT_STRIDE } from '../physics/protocol';
import type { BodyViews } from './bodyViews';
import { heatColor } from './bodyViews';

export type TrailMode = 'off' | 'selected' | 'all';

export interface OverlayOptions {
  velocity: boolean;
  force: boolean;
  contacts: boolean;
  com: boolean;
  trails: TrailMode;
}

export const DEFAULT_OVERLAYS: OverlayOptions = { velocity: false, force: false, contacts: false, com: false, trails: 'off' };

const TRAIL_LEN = 320;
const MAX_VECTORS = 600;

interface Trail {
  line: Line;
  pos: Float32Array;
  col: Float32Array;
  count: number;
  last: Vector3;
}

export class Overlays {
  readonly group: Group;
  private vel: LineSegments2;
  private frc: LineSegments2;
  private velMat: LineMaterial;
  private frcMat: LineMaterial;
  private contactPts: Points;
  private contactLines: LineSegments;
  private comPts: Points;
  private trails = new Map<string, Trail>();
  private lastFrame = -1;
  private tmp = new Vector3();
  private tmpC = new Color();
  options: OverlayOptions = { ...DEFAULT_OVERLAYS };

  constructor(group: Group) {
    this.group = group;
    this.velMat = new LineMaterial({ color: 0x35e0ff, linewidth: 2.2, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
    this.frcMat = new LineMaterial({ color: 0xff4fd8, linewidth: 2.2, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
    this.vel = new LineSegments2(new LineSegmentsGeometry(), this.velMat);
    this.frc = new LineSegments2(new LineSegmentsGeometry(), this.frcMat);
    for (const l of [this.vel, this.frc]) { l.frustumCulled = false; l.renderOrder = 990; l.visible = false; group.add(l); }

    this.contactPts = new Points(new BufferGeometry(), new PointsMaterial({
      size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true, toneMapped: false,
    }));
    this.contactLines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false }));
    this.comPts = new Points(new BufferGeometry(), new PointsMaterial({ size: 8, sizeAttenuation: false, color: 0xffffff, depthTest: false, transparent: true, toneMapped: false }));
    for (const o of [this.contactPts, this.contactLines, this.comPts]) { o.frustumCulled = false; o.renderOrder = 991; o.visible = false; group.add(o); }
  }

  setResolution(w: number, h: number): void {
    this.velMat.resolution.set(w, h);
    this.frcMat.resolution.set(w, h);
    for (const t of this.trails.values()) void t;
  }

  clearTrails(): void {
    for (const t of this.trails.values()) {
      this.group.remove(t.line);
      t.line.geometry.dispose();
      (t.line.material as LineBasicMaterial).dispose();
    }
    this.trails.clear();
  }

  hideAll(): void {
    this.vel.visible = this.frc.visible = this.contactPts.visible = this.contactLines.visible = this.comPts.visible = false;
    for (const t of this.trails.values()) t.line.visible = false;
  }

  /**
   * @param poses live body buffer; null in edit mode (overlays are hidden)
   */
  update(
    camera: PerspectiveCamera, bodies: BodyViews, poses: Float32Array | null, indexOf: (id: string) => number | undefined,
    contacts: Float32Array, frameNo: number, selected: Set<string>, mass: Record<string, number>,
    com: Record<string, [number, number, number]>, gravity: number,
  ): void {
    if (!poses) { this.hideAll(); return; }
    const o = this.options;
    const camDir = camera.getWorldDirection(new Vector3());

    // ---- vectors ----------------------------------------------------------------------------
    const makeVectors = (kind: 'v' | 'f'): number[] => {
      const out: number[] = [];
      let n = 0;
      for (const [id, view] of bodies.views) {
        if (view.def.bodyType !== 'dynamic' || n >= MAX_VECTORS) continue;
        const i = indexOf(id);
        if (i === undefined) continue;
        const b = i * BODY_STRIDE;
        if (poses[b + B.state] !== 0) continue;
        let x: number, y: number, z: number, len: number;
        if (kind === 'v') {
          x = poses[b + B.vx]; y = poses[b + B.vy]; z = poses[b + B.vz];
          len = Math.hypot(x, y, z);
          if (len < 0.05) continue;
          const k = Math.min(len * 0.35, 5) / len;
          x *= k; y *= k; z *= k;
        } else {
          x = poses[b + B.fx]; y = poses[b + B.fy]; z = poses[b + B.fz];
          len = Math.hypot(x, y, z);
          const w = Math.max(1e-6, (mass[id] ?? 1) * Math.max(0.1, gravity));
          if (len / w < 0.03) continue;
          const k = Math.min((len / w) * 0.6, 5) / len;
          x *= k; y *= k; z *= k;
        }
        const p = view.position;
        const tipx = p.x + x, tipy = p.y + y, tipz = p.z + z;
        out.push(p.x, p.y, p.z, tipx, tipy, tipz);
        // arrow head in the camera-facing plane
        const dir = this.tmp.set(x, y, z);
        const l = dir.length();
        if (l > 1e-4) {
          dir.divideScalar(l);
          const side = dir.clone().cross(camDir).normalize().multiplyScalar(Math.min(0.12, l * 0.3));
          const back = dir.clone().multiplyScalar(-Math.min(0.2, l * 0.4));
          out.push(tipx, tipy, tipz, tipx + back.x + side.x, tipy + back.y + side.y, tipz + back.z + side.z);
          out.push(tipx, tipy, tipz, tipx + back.x - side.x, tipy + back.y - side.y, tipz + back.z - side.z);
        }
        n++;
      }
      return out;
    };
    const setLines = (obj: LineSegments2, on: boolean, kind: 'v' | 'f') => {
      obj.visible = on;
      if (!on) return;
      const pts = makeVectors(kind);
      if (pts.length >= 6) {
        obj.geometry.setPositions(pts);
        obj.visible = true;
      } else obj.visible = false;
    };
    setLines(this.vel, o.velocity, 'v');
    setLines(this.frc, o.force, 'f');

    // ---- contacts ---------------------------------------------------------------------------
    const cn = o.contacts ? Math.floor(contacts.length / CONTACT_STRIDE) : 0;
    this.contactPts.visible = this.contactLines.visible = cn > 0;
    if (cn > 0) {
      const pos = new Float32Array(cn * 3), col = new Float32Array(cn * 3);
      const lpos = new Float32Array(cn * 6), lcol = new Float32Array(cn * 6);
      let maxF = 1;
      for (let i = 0; i < cn; i++) maxF = Math.max(maxF, contacts[i * CONTACT_STRIDE + 6]);
      for (let i = 0; i < cn; i++) {
        const s = i * CONTACT_STRIDE;
        pos[i * 3] = contacts[s]; pos[i * 3 + 1] = contacts[s + 1]; pos[i * 3 + 2] = contacts[s + 2];
        const f = contacts[s + 6];
        heatColor(Math.log10(1 + f) / Math.log10(1 + maxF), this.tmpC);
        col[i * 3] = this.tmpC.r; col[i * 3 + 1] = this.tmpC.g; col[i * 3 + 2] = this.tmpC.b;
        const len = 0.12 + 0.25 * (Math.log10(1 + f) / Math.log10(1 + maxF));
        lpos.set([contacts[s], contacts[s + 1], contacts[s + 2], contacts[s] + contacts[s + 3] * len, contacts[s + 1] + contacts[s + 4] * len, contacts[s + 2] + contacts[s + 5] * len], i * 6);
        lcol.set([this.tmpC.r, this.tmpC.g, this.tmpC.b, this.tmpC.r, this.tmpC.g, this.tmpC.b], i * 6);
      }
      const g = this.contactPts.geometry;
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('color', new BufferAttribute(col, 3));
      const lg = this.contactLines.geometry;
      lg.setAttribute('position', new BufferAttribute(lpos, 3));
      lg.setAttribute('color', new BufferAttribute(lcol, 3));
    }

    // ---- centres of mass --------------------------------------------------------------------
    this.comPts.visible = o.com;
    if (o.com) {
      const pts: number[] = [];
      for (const [id, view] of bodies.views) {
        const c = com[id];
        if (!c || view.def.bodyType === 'static') continue;
        const w = this.tmp.set(c[0], c[1], c[2]).applyQuaternion(view.mesh.quaternion).add(view.position);
        pts.push(w.x, w.y, w.z);
      }
      this.comPts.geometry.setAttribute('position', new Float32BufferAttribute(pts, 3));
    }

    // ---- trails -----------------------------------------------------------------------------
    if (frameNo !== this.lastFrame) {
      this.lastFrame = frameNo;
      const wanted = new Set<string>();
      if (o.trails === 'all') {
        for (const [id, v] of bodies.views) if (v.def.bodyType !== 'static') wanted.add(id);
      } else if (o.trails === 'selected') {
        for (const id of selected) if (bodies.views.has(id)) wanted.add(id);
      }
      for (const id of wanted) this.recordTrail(id, bodies);
    }
    for (const [id, t] of this.trails) t.line.visible = o.trails !== 'off' && (o.trails === 'all' || selected.has(id));
  }

  private recordTrail(id: string, bodies: BodyViews): void {
    const v = bodies.views.get(id);
    if (!v) return;
    let t = this.trails.get(id);
    if (!t) {
      const geo = new BufferGeometry();
      const pos = new Float32Array(TRAIL_LEN * 3), col = new Float32Array(TRAIL_LEN * 3);
      geo.setAttribute('position', new BufferAttribute(pos, 3).setUsage(35048));
      geo.setAttribute('color', new BufferAttribute(col, 3).setUsage(35048));
      const line = new Line(geo, new LineBasicMaterial({ vertexColors: true, blending: AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      line.frustumCulled = false;
      line.renderOrder = 980;
      this.group.add(line);
      t = { line, pos, col, count: 0, last: new Vector3(1e9, 0, 0) };
      this.trails.set(id, t);
    }
    if (t.last.distanceToSquared(v.position) < 0.0004) return;
    t.last.copy(v.position);
    if (t.count < TRAIL_LEN) {
      t.pos.set([v.position.x, v.position.y, v.position.z], t.count * 3);
      t.count++;
    } else {
      t.pos.copyWithin(0, 3);
      t.pos.set([v.position.x, v.position.y, v.position.z], (TRAIL_LEN - 1) * 3);
    }
    const base = new Color(v.def.material.color).lerp(new Color('#7fd8ff'), 0.5);
    for (let i = 0; i < t.count; i++) {
      const f = Math.pow(i / Math.max(1, t.count - 1), 1.5);
      t.col[i * 3] = base.r * f; t.col[i * 3 + 1] = base.g * f; t.col[i * 3 + 2] = base.b * f;
    }
    const g = t.line.geometry;
    g.setDrawRange(0, t.count);
    (g.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }
}


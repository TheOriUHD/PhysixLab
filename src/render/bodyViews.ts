/**
 * Body meshes: one Mesh per BodyEntity, with shared unit geometries scaled to the shape's
 * size, PBR materials from the entity's material spec, and analytical colour modes
 * (speed / energy / force / sleep / type) for reading the simulation at a glance.
 */
import type { BufferGeometry, Group } from 'three';
import { Color, Mesh, MeshStandardMaterial, SRGBColorSpace, Vector3 } from 'three';
import { shapeGeometry, shapeGeometryKey, shapeVisualScale } from '../model/shapeRegistry';
import type { BodyEntity, ShapeSpec } from '../model/types';
import { B, BODY_STRIDE } from '../physics/protocol';
import { GEOMETRY_KIT } from './geometryKit';

export type ColorMode = 'material' | 'type' | 'speed' | 'energy' | 'force' | 'sleep';

export const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  material: 'Material',
  type: 'Body type',
  speed: 'Speed',
  energy: 'Kinetic energy',
  force: 'Net force',
  sleep: 'Sleep state',
};

interface CachedGeo {
  geo: BufferGeometry;
  refs: number;
}

class GeometryCache {
  private map = new Map<string, CachedGeo>();

  key(shape: ShapeSpec): string {
    return shapeGeometryKey(shape);
  }

  acquire(shape: ShapeSpec): { key: string; geo: BufferGeometry } {
    const key = this.key(shape);
    let c = this.map.get(key);
    if (!c) {
      c = { geo: this.build(shape), refs: 0 };
      this.map.set(key, c);
    }
    c.refs++;
    return { key, geo: c.geo };
  }

  release(key: string): void {
    const c = this.map.get(key);
    if (!c) return;
    if (--c.refs <= 0) {
      c.geo.dispose();
      this.map.delete(key);
    }
  }

  private build(shape: ShapeSpec): BufferGeometry {
    return shapeGeometry(GEOMETRY_KIT, shape);
  }
}

export class BodyView {
  readonly mesh: Mesh;
  readonly material: MeshStandardMaterial;
  geoKey = '';
  def: BodyEntity;
  /** Last pose written, so overlays can read it without touching the matrix. */
  readonly position = new Vector3();
  state = 0;

  constructor(def: BodyEntity, cache: GeometryCache) {
    this.def = def;
    const { key, geo } = cache.acquire(def.shape);
    this.geoKey = key;
    this.material = new MeshStandardMaterial();
    this.mesh = new Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData.entityId = def.id;
    this.mesh.matrixAutoUpdate = true;
    this.applyMaterial(def);
    this.applyShape(def);
    this.setPoseFromDef(def);
  }

  applyShape(def: BodyEntity): void {
    const s = shapeVisualScale(def.shape);
    this.mesh.scale.set(s[0], s[1], s[2]);
  }

  applyMaterial(def: BodyEntity): void {
    const m = def.material;
    this.material.color.set(m.color);
    this.material.metalness = m.metalness;
    this.material.roughness = m.roughness;
    this.material.opacity = def.ghost ? Math.min(m.opacity, 0.35) : m.opacity;
    this.material.transparent = this.material.opacity < 0.999;
    this.material.depthWrite = true;
    this.material.envMapIntensity = 1;
    this.material.needsUpdate = true;
    this.mesh.visible = !def.hidden;
  }

  setPoseFromDef(def: BodyEntity): void {
    this.mesh.position.set(def.position[0], def.position[1], def.position[2]);
    this.mesh.quaternion.set(def.rotation[0], def.rotation[1], def.rotation[2], def.rotation[3]);
    this.position.copy(this.mesh.position);
  }
}

const TYPE_COLORS = { dynamic: '#4a8dff', static: '#6b7686', kinematic: '#ffb03a' };
const HEAT: [number, number, number][] = [
  [0.1, 0.22, 0.85],
  [0.08, 0.72, 0.92],
  [0.55, 0.9, 0.35],
  [0.98, 0.85, 0.2],
  [0.95, 0.2, 0.12],
];

export function heatColor(t: number, out: Color): Color {
  const x = Math.min(0.9999, Math.max(0, t)) * (HEAT.length - 1);
  const i = Math.floor(x),
    f = x - i;
  const a = HEAT[i],
    b = HEAT[i + 1];
  return out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, SRGBColorSpace);
}

export class BodyViews {
  readonly views = new Map<string, BodyView>();
  private cache = new GeometryCache();
  private tmpColor = new Color();
  mode: ColorMode = 'material';
  hoverId: string | null = null;
  /** Auto-ranging scale for the analytic colour modes. */
  private scaleMax: Record<string, number> = { speed: 3, energy: 50, force: 100 };

  constructor(readonly group: Group) {}

  get(id: string): BodyView | undefined {
    return this.views.get(id);
  }

  add(def: BodyEntity): BodyView {
    this.remove(def.id);
    const v = new BodyView(def, this.cache);
    this.views.set(def.id, v);
    this.group.add(v.mesh);
    return v;
  }

  remove(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.mesh);
    v.material.dispose();
    this.cache.release(v.geoKey);
    this.views.delete(id);
  }

  clear(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
  }

  /** Apply an edited definition (shape / material / visibility). */
  update(def: BodyEntity): void {
    const v = this.views.get(def.id);
    if (!v) {
      this.add(def);
      return;
    }
    const old = v.def;
    v.def = def;
    if (old.shape !== def.shape) {
      const key = this.cache.key(def.shape);
      if (key !== v.geoKey) {
        const { geo } = this.cache.acquire(def.shape);
        this.cache.release(v.geoKey);
        v.geoKey = key;
        v.mesh.geometry = geo;
      }
      v.applyShape(def);
    }
    if (old.material !== def.material || old.hidden !== def.hidden || old.ghost !== def.ghost) v.applyMaterial(def);
  }

  pickables(): Mesh[] {
    const out: Mesh[] = [];
    for (const v of this.views.values()) if (v.mesh.visible && v.state !== 2) out.push(v.mesh);
    return out;
  }

  /** Write a simulated pose (from a worker frame) into a view. */
  setPoseFromFrame(id: string, poses: Float32Array, index: number): void {
    const v = this.views.get(id);
    if (!v) return;
    const o = index * BODY_STRIDE;
    v.mesh.position.set(poses[o + B.px], poses[o + B.py], poses[o + B.pz]);
    v.mesh.quaternion.set(poses[o + B.qx], poses[o + B.qy], poses[o + B.qz], poses[o + B.qw]);
    v.position.copy(v.mesh.position);
    v.state = poses[o + B.state];
    v.mesh.visible = !v.def.hidden && v.state !== 2;
  }

  resetStates(): void {
    for (const v of this.views.values()) {
      v.state = 0;
      v.mesh.visible = !v.def.hidden;
    }
  }

  /**
   * Recolour bodies for the active colour mode. `poses` is the live frame buffer (or null in
   * edit mode, where only material / type colouring is meaningful).
   */
  applyColors(poses: Float32Array | null, indexOf: (id: string) => number | undefined, selected: Set<string>): void {
    const mode = poses ? this.mode : this.mode === 'type' ? 'type' : 'material';
    let maxSpeed = 0,
      maxKe = 0,
      maxF = 0;
    if (poses && (mode === 'speed' || mode === 'energy' || mode === 'force')) {
      for (const id of this.views.keys()) {
        const i = indexOf(id);
        if (i === undefined) continue;
        const o = i * BODY_STRIDE;
        maxSpeed = Math.max(maxSpeed, Math.hypot(poses[o + B.vx], poses[o + B.vy], poses[o + B.vz]));
        maxKe = Math.max(maxKe, poses[o + B.ke]);
        maxF = Math.max(maxF, Math.hypot(poses[o + B.fx], poses[o + B.fy], poses[o + B.fz]));
      }
      // Ease the scale so colours do not flicker as the maximum changes.
      this.scaleMax.speed += (Math.max(1, maxSpeed) - this.scaleMax.speed) * 0.08;
      this.scaleMax.energy += (Math.max(1, maxKe) - this.scaleMax.energy) * 0.08;
      this.scaleMax.force += (Math.max(1, maxF) - this.scaleMax.force) * 0.08;
    }
    for (const v of this.views.values()) {
      const d = v.def;
      const sel = selected.has(d.id);
      let em = 0;
      if (mode === 'material') {
        v.material.color.set(d.material.color);
      } else if (mode === 'type') {
        v.material.color.set(TYPE_COLORS[d.bodyType]);
      } else {
        const i = indexOf(d.id);
        const o = i === undefined ? -1 : i * BODY_STRIDE;
        if (o < 0 || !poses) {
          v.material.color.set(d.material.color);
        } else if (mode === 'sleep') {
          const st = poses[o + B.state];
          v.material.color.set(d.bodyType !== 'dynamic' ? '#4a5566' : st === 0 ? '#ff9d42' : '#5f7396');
        } else if (d.bodyType !== 'dynamic') {
          v.material.color.set('#3c4554');
        } else if (mode === 'speed') {
          const s = Math.hypot(poses[o + B.vx], poses[o + B.vy], poses[o + B.vz]);
          heatColor(s / this.scaleMax.speed, this.tmpColor);
          v.material.color.copy(this.tmpColor);
        } else if (mode === 'energy') {
          heatColor(Math.sqrt(poses[o + B.ke] / this.scaleMax.energy), this.tmpColor);
          v.material.color.copy(this.tmpColor);
        } else if (mode === 'force') {
          const f = Math.hypot(poses[o + B.fx], poses[o + B.fy], poses[o + B.fz]);
          heatColor(f / this.scaleMax.force, this.tmpColor);
          v.material.color.copy(this.tmpColor);
        }
        em = 0;
      }
      v.material.emissive.setRGB(0, 0, 0);
      if (sel) v.material.emissive.setRGB(0.02, 0.05, 0.09);
      else if (d.id === this.hoverId) v.material.emissive.setRGB(0.05, 0.1, 0.14);
      void em;
    }
  }

  get scales() {
    return this.scaleMax;
  }
}

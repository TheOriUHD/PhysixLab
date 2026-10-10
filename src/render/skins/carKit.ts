/**
 * Helpers for the procedural car skins (VZ-42): reference-counted shared geometries / materials (four wheels and
 * several cars share one set), a merge batch that bakes many small parts into one mesh per material, and a few
 * allocation-free pose helpers.
 */
import { BufferAttribute, Euler, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three';
import type { Material, BufferGeometry, Mesh } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

interface Disposable {
  dispose(): void;
}

const cache = new Map<string, { value: Disposable; refs: number }>();

/** Holds references to shared resources; `release()` drops them (disposing what nobody else uses any more). */
export class Lease {
  private keys: string[] = [];

  get<T extends Disposable>(key: string, make: () => T): T {
    let e = cache.get(key);
    if (!e) cache.set(key, (e = { value: make(), refs: 0 }));
    e.refs++;
    this.keys.push(key);
    return e.value as T;
  }

  release(): void {
    for (const k of this.keys) {
      const e = cache.get(k);
      if (e && --e.refs <= 0) {
        e.value.dispose();
        cache.delete(k);
      }
    }
    this.keys.length = 0;
  }
}

/** Number of live shared resources (tests: must return to 0 once every skin is disposed). */
export function sharedResourceCount(): number {
  return cache.size;
}

const _e = new Euler();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();

/** Matrix from position, XYZ Euler rotation and scale. Build-time only. */
export function tm(
  px: number,
  py: number,
  pz: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
  out = new Matrix4(),
): Matrix4 {
  _e.set(rx, ry, rz, 'XYZ');
  _q.setFromEuler(_e);
  return out.compose(_p.set(px, py, pz), _q, _s.set(sx, sy, sz));
}

/** Matrix placing a unit-height (y in [0,1]) part from `a` to `b` with the given cross-section scale. Build-time. */
export function segment(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  tx: number,
  tz: number,
): Matrix4 {
  const d = new Vector3(bx - ax, by - ay, bz - az);
  const len = d.length();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.divideScalar(len || 1));
  return new Matrix4().compose(new Vector3(ax, ay, az), q, new Vector3(tx, len, tz));
}

/** Collects (geometry, matrix) pairs and bakes them into one geometry. `shade` may add a per-vertex colour. */
export class Batch {
  private parts: BufferGeometry[] = [];

  constructor(private shade?: (x: number, y: number, z: number) => number) {}

  add(geo: BufferGeometry, m?: Matrix4): this {
    // Clone into a plain non-indexed position/normal/uv triple so everything merges.
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') g.deleteAttribute(name);
    }
    g.clearGroups();
    if (!g.attributes.uv)
      g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (m) g.applyMatrix4(m);
    if (this.shade && !g.attributes.color) {
      const pos = g.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const s = this.shade(pos.getX(i), pos.getY(i), pos.getZ(i));
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = s;
      }
      g.setAttribute('color', new BufferAttribute(col, 3));
    }
    g = g.attributes.normal ? g : (g.computeVertexNormals(), g);
    this.parts.push(g);
    return this;
  }

  /** The merged geometry (the parts are disposed). */
  bake(): BufferGeometry {
    const out = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (!out) throw new Error('car skin: empty batch');
    return out;
  }
}

export function triangleCount(root: { traverse(cb: (o: unknown) => void): void }): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.visible) return;
    const g = m.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return n;
}

export function disposeMaterials(...ms: Material[]): void {
  for (const m of ms) m.dispose();
}

const _a = new Vector3();
const _up = new Vector3(0, 1, 0);
const _qq = new Quaternion();

/** Stretch a unit-height mesh (y in [0,1]) from point a to point b. No allocation. */
export function stretch(mesh: Mesh, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  _a.set(bx - ax, by - ay, bz - az);
  const len = _a.length();
  mesh.position.set(ax, ay, az);
  mesh.quaternion.copy(_qq.setFromUnitVectors(_up, _a.divideScalar(len || 1)));
  mesh.scale.y = len;
  return len;
}

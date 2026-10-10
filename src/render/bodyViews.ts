/**
 * Body meshes: one Mesh per BodyEntity (or, for a compound body, one Mesh per visible collider part under a
 * Group), with shared unit geometries scaled to the shape's size, PBR materials from the entity's material
 * spec, and analytical colour modes (speed / energy / force / sleep / type) for reading the simulation at a
 * glance.
 */
import type { BufferGeometry, Group, Object3D } from 'three';
import { Color, Group as ThreeGroup, Mesh, MeshPhysicalMaterial, SRGBColorSpace, Vector3 } from 'three';
import { applyMaterialSpec, disposeMaterialTextures } from './materialBuild';
import { isCompound, partMaterial } from '../model/compound';
import { shapeGeometry, shapeGeometryKey, shapeVisualScale } from '../model/shapeRegistry';
import type { BodyEntity, ColliderPart, MaterialSpec, ShapeSpec } from '../model/types';
import { B, BODY_STRIDE } from '../physics/protocol';
import { GEOMETRY_KIT } from './geometryKit';
import { DISSOLVE_BELOW, InstancePool, MIN_POOL, type PoolMember } from './instancing';

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

/** One drawn mesh of a body: the body's shape, or one collider part. */
interface Piece {
  mesh: Mesh;
  material: MeshPhysicalMaterial;
  geoKey: string;
  /** The part drawn; null for the body's own shape. */
  part: ColliderPart | null;
  /** Surface colour in the 'material' colour mode (the part's override, else the body's). */
  baseColor: string;
  /** Emissive colour of the material (the highlight tint is added on top of it). */
  baseEmissive: string;
}

export class BodyView implements PoolMember {
  /**
   * Carries the pose: the body's own Mesh, or a Group of part meshes for a compound body. Anything that
   * moves, hides or measures a body uses this; picking and tinting use `pieces`.
   */
  readonly mesh: Object3D;
  /** Every mesh drawn for the body (picking targets, tinting). */
  readonly pieces: Piece[] = [];
  readonly compound: boolean;
  def: BodyEntity;
  /** Last pose written, so overlays can read it without touching the matrix. */
  readonly position = new Vector3();
  state = 0;
  // -- VZ-B: instancing state (see render/instancing.ts) --
  /** Visual scale of the simple shape (the pool composes it into the instance matrix). */
  scale: [number, number, number] = [1, 1, 1];
  /** Pool this body is drawn through, or null when it has its own mesh. */
  pool: InstancePool | null = null;
  slot = -1;
  /** Key of bodies that may share one InstancedMesh; null = never pooled (compound, instancing off). */
  instKey: string | null = null;
  /** Highlighted (selected / hovered): drawn through its own mesh even though a pool exists. */
  promoted = false;
  poolVisible = true;
  get id(): string {
    return this.def.id;
  }

  constructor(
    def: BodyEntity,
    private cache: GeometryCache,
  ) {
    this.def = def;
    this.compound = isCompound(def);
    if (this.compound) {
      const group = new ThreeGroup();
      group.userData.entityId = def.id;
      for (const part of def.parts as ColliderPart[]) {
        if (part.visible === false) continue;
        const piece = this.makePiece(part.shape, part);
        piece.mesh.position.set(part.position[0], part.position[1], part.position[2]);
        piece.mesh.quaternion.set(part.rotation[0], part.rotation[1], part.rotation[2], part.rotation[3]);
        group.add(piece.mesh);
      }
      this.mesh = group;
    } else {
      this.mesh = this.makePiece(def.shape, null).mesh;
    }
    this.mesh.matrixAutoUpdate = true;
    this.applyMaterial(def);
    this.applyShape(def);
    this.setPoseFromDef(def);
  }

  private makePiece(shape: ShapeSpec, part: ColliderPart | null): Piece {
    const { key, geo } = this.cache.acquire(shape);
    const material = new MeshPhysicalMaterial();
    const mesh = new Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.entityId = this.def.id;
    const s = shapeVisualScale(shape);
    mesh.scale.set(s[0], s[1], s[2]);
    const piece: Piece = {
      mesh,
      material,
      geoKey: key,
      part,
      baseColor: this.def.material.color,
      baseEmissive: '#000000',
    };
    this.pieces.push(piece);
    return piece;
  }

  /** The (single) mesh of a simple body. */
  private get first(): Piece {
    return this.pieces[0];
  }

  /** Re-point a simple body at the geometry of its edited shape. */
  applyShape(def: BodyEntity): void {
    if (this.compound) return; // parts are static meshes: a change of parts rebuilds the whole view
    const piece = this.first;
    const key = this.cache.key(def.shape);
    if (key !== piece.geoKey) {
      const { geo } = this.cache.acquire(def.shape);
      this.cache.release(piece.geoKey);
      piece.geoKey = key;
      piece.mesh.geometry = geo;
    }
    const s = shapeVisualScale(def.shape);
    piece.mesh.scale.set(s[0], s[1], s[2]);
    this.scale = [s[0], s[1], s[2]];
  }

  applyMaterial(def: BodyEntity): void {
    for (const piece of this.pieces) {
      const m: MaterialSpec = piece.part ? partMaterial(def, piece.part) : def.material;
      // a procedural pattern already contains the colour: showing it tinted would darken it twice
      piece.baseColor = m.texture && m.texture.pattern !== 'image' ? '#ffffff' : m.color;
      applyMaterialSpec(piece.material, m, def.ghost || !!piece.part?.sensor); // -- VZ-A --
      piece.baseEmissive = `#${piece.material.emissive.getHexString()}`;
    }
    this.mesh.visible = !def.hidden;
  }

  setPoseFromDef(def: BodyEntity): void {
    this.mesh.position.set(def.position[0], def.position[1], def.position[2]);
    this.mesh.quaternion.set(def.rotation[0], def.rotation[1], def.rotation[2], def.rotation[3]);
    this.position.copy(this.mesh.position);
  }

  /** Free GPU resources: the materials and this view's share of the cached geometries. */
  dispose(): void {
    for (const piece of this.pieces) {
      disposeMaterialTextures(piece.material);
      piece.material.dispose();
      this.cache.release(piece.geoKey);
    }
  }
}

const SEL_TINT = new Color(0.02, 0.05, 0.09);
const HOVER_TINT = new Color(0.05, 0.1, 0.14);
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
  // -- VZ-B: instanced rendering --
  private pools = new Map<string, InstancePool>();
  private poolGeo = new Map<string, string>();
  private candidates = new Map<string, Set<BodyView>>();
  private colorCache = new Map<string, Color>();
  private instancingOn = true;
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
    this.register(v);
    return v;
  }

  remove(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    this.unregister(v);
    this.group.remove(v.mesh);
    v.dispose();
    this.views.delete(id);
  }

  // -- VZ-B: instanced rendering (VZ-30) --

  get instancing(): boolean {
    return this.instancingOn;
  }

  /** Draw identical bodies through shared InstancedMeshes (default) or one mesh each. */
  setInstancing(on: boolean): void {
    if (on === this.instancingOn) return;
    this.instancingOn = on;
    for (const v of this.views.values()) {
      this.unregister(v);
      this.register(v);
    }
  }

  /** Number of InstancedMesh draw groups currently in use, and the bodies they carry. */
  poolStats(): { pools: number; instances: number } {
    let instances = 0;
    for (const p of this.pools.values()) instances += p.size;
    return { pools: this.pools.size, instances };
  }

  private instKeyOf(v: BodyView): string | null {
    if (!this.instancingOn || v.compound) return null;
    const { color: _color, ...rest } = v.def.material;
    void _color;
    // -- VZ-A: a procedural pattern bakes the material colour into its texture --
    if (rest.texture && rest.texture.pattern !== 'image') (rest as Record<string, unknown>).color = _color;
    return `${this.cache.key(v.def.shape)}|${v.def.ghost ? 1 : 0}|${JSON.stringify(rest)}`;
  }

  private register(v: BodyView): void {
    const key = this.instKeyOf(v);
    v.instKey = key;
    if (key === null) return;
    let set = this.candidates.get(key);
    if (!set) this.candidates.set(key, (set = new Set()));
    set.add(v);
    let pool = this.pools.get(key);
    if (!pool && set.size >= MIN_POOL) {
      const leader = set.values().next().value as BodyView;
      const { key: geoKey, geo } = this.cache.acquire(leader.def.shape);
      const mat = leader.pieces[0].material.clone();
      mat.color.setRGB(1, 1, 1);
      mat.emissive.setRGB(0, 0, 0);
      pool = new InstancePool(key, geo, mat, this.group);
      this.pools.set(key, pool);
      this.poolGeo.set(key, geoKey);
      for (const m of set) this.attach(m, pool);
    } else if (pool) this.attach(v, pool);
  }

  private attach(v: BodyView, pool: InstancePool): void {
    v.pool = pool;
    pool.add(v);
  }

  private unregister(v: BodyView): void {
    const key = v.instKey;
    if (key === null) return;
    v.pool?.remove(v);
    v.pool = null;
    v.instKey = null;
    v.mesh.visible = !v.def.hidden && v.state !== 2;
    const set = this.candidates.get(key);
    if (!set) return;
    set.delete(v);
    const pool = this.pools.get(key);
    if (set.size === 0) this.candidates.delete(key);
    if (pool && set.size < DISSOLVE_BELOW) {
      for (const m of set) {
        pool.remove(m);
        m.pool = null;
        m.mesh.visible = !m.def.hidden && m.state !== 2;
      }
      pool.dispose();
      this.pools.delete(key);
      this.cache.release(this.poolGeo.get(key)!);
      this.poolGeo.delete(key);
    }
  }

  /** True when the body is drawn at all (not hidden, not fallen out of the world). */
  private shown(v: BodyView): boolean {
    return !v.def.hidden && v.state !== 2;
  }

  /**
   * Per frame, after poses and colours: push poses into the instance buffers and settle which of a pooled body's two
   * representations (instance slot / own mesh) is drawn.
   */
  flush(): void {
    for (const v of this.views.values()) {
      if (!v.pool) continue;
      const shown = this.shown(v);
      v.poolVisible = shown && !v.promoted;
      v.mesh.visible = shown && v.promoted;
    }
    for (const p of this.pools.values()) p.flush();
  }

  private colorOf(css: string): Color {
    let c = this.colorCache.get(css);
    if (!c) this.colorCache.set(css, (c = new Color(css)));
    return c;
  }

  clear(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
    for (const p of this.pools.values()) p.dispose();
    this.pools.clear();
    this.candidates.clear();
    for (const k of this.poolGeo.values()) this.cache.release(k);
    this.poolGeo.clear();
  }

  /**
   * Apply an edited definition (shape / parts / material / visibility). Returns true when the view was
   * rebuilt (its root object changed), so callers holding the old one — the selection outline — refresh it.
   */
  update(def: BodyEntity): boolean {
    const v = this.views.get(def.id);
    if (!v) {
      this.add(def);
      return true;
    }
    const old = v.def;
    if (v.compound !== isCompound(def) || (v.compound && old.parts !== def.parts)) {
      // Different set of meshes: rebuild, keeping the pose and simulation state the old view had.
      const { position, quaternion } = v.mesh;
      const state = v.state;
      const nv = this.add(def);
      nv.mesh.position.copy(position);
      nv.mesh.quaternion.copy(quaternion);
      nv.position.copy(position);
      nv.state = state;
      nv.mesh.visible = !def.hidden && state !== 2;
      return true;
    }
    v.def = def;
    const regroup = old.shape !== def.shape || old.material !== def.material || old.ghost !== def.ghost;
    if (regroup) this.unregister(v);
    if (old.shape !== def.shape) v.applyShape(def);
    if (old.material !== def.material || old.hidden !== def.hidden || old.ghost !== def.ghost) v.applyMaterial(def);
    if (regroup) this.register(v);
    return false;
  }

  /** Every mesh a click can hit (all parts of compound bodies), skipping hidden and fallen bodies. */
  pickables(): Mesh[] {
    const out: Mesh[] = [];
    for (const p of this.pools.values()) out.push(p.mesh);
    for (const v of this.views.values()) {
      if (!this.shown(v) || (v.pool && !v.promoted)) continue;
      for (const p of v.pieces) out.push(p.mesh);
    }
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
      if (v.pool) v.promoted = sel || d.id === this.hoverId;
      // Colour the whole body for the analytic modes; in 'material' mode each part keeps its own colour.
      let flat: string | null = null;
      const heat = this.tmpColor;
      let useHeat = false;
      if (mode === 'type') {
        flat = TYPE_COLORS[d.bodyType];
      } else if (mode !== 'material') {
        const i = indexOf(d.id);
        const o = i === undefined ? -1 : i * BODY_STRIDE;
        if (o < 0 || !poses) {
          flat = d.material.color;
        } else if (mode === 'sleep') {
          const st = poses[o + B.state];
          flat = d.bodyType !== 'dynamic' ? '#4a5566' : st === 0 ? '#ff9d42' : '#5f7396';
        } else if (d.bodyType !== 'dynamic') {
          flat = '#3c4554';
        } else if (mode === 'speed') {
          const s = Math.hypot(poses[o + B.vx], poses[o + B.vy], poses[o + B.vz]);
          heatColor(s / this.scaleMax.speed, heat);
          useHeat = true;
        } else if (mode === 'energy') {
          heatColor(Math.sqrt(poses[o + B.ke] / this.scaleMax.energy), heat);
          useHeat = true;
        } else if (mode === 'force') {
          const f = Math.hypot(poses[o + B.fx], poses[o + B.fy], poses[o + B.fz]);
          heatColor(f / this.scaleMax.force, heat);
          useHeat = true;
        }
      }
      if (v.pool && !v.promoted) {
        v.pool.setColor(v, useHeat ? heat : this.colorOf(flat ?? v.pieces[0].baseColor));
        continue;
      }
      for (const piece of v.pieces) {
        if (useHeat) piece.material.color.copy(heat);
        else piece.material.color.set(flat ?? piece.baseColor);
        piece.material.emissive.set(piece.baseEmissive);
        if (sel) piece.material.emissive.add(SEL_TINT);
        else if (d.id === this.hoverId) piece.material.emissive.add(HOVER_TINT);
      }
    }
  }

  get scales() {
    return this.scaleMax;
  }
}

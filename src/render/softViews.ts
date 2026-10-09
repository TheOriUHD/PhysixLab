/**
 * Soft-body views. In edit mode each soft entity is shown as a lightweight *proxy* (box,
 * sphere, plane or line) positioned by its document pose. While simulating, the proxy is
 * replaced by a *dynamic* mesh whose vertices are the engine's particles (so it deforms,
 * stretches and tears), updated every frame from the worker.
 */
import type { Object3D } from 'three';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { SoftEntity } from '../model/types';
import type { SimClient } from '../physics/client';

const unitBox = new BoxGeometry(1, 1, 1);
const unitSphere = new SphereGeometry(0.5, 40, 28);

class SoftView {
  readonly root = new Group();
  proxy: Object3D;
  dyn: Mesh | LineSegments2 | null = null;
  layoutRef: unknown = null;
  readonly material: MeshStandardMaterial | MeshPhysicalMaterial;
  readonly lineMaterial: LineMaterial | null;
  private proxyGeo: BufferGeometry | null = null;

  constructor(
    public def: SoftEntity,
    res: { w: number; h: number },
  ) {
    this.material =
      def.type === 'jelly' || def.type === 'balloon'
        ? new MeshPhysicalMaterial({ clearcoat: 0.8, clearcoatRoughness: 0.25, side: DoubleSide })
        : new MeshStandardMaterial({ side: DoubleSide });
    this.lineMaterial =
      def.type === 'cable' ? new LineMaterial({ color: 0xffffff, linewidth: 5, worldUnits: false }) : null;
    this.lineMaterial?.resolution.set(res.w, res.h);
    this.proxy = this.buildProxy();
    this.root.add(this.proxy);
    this.apply(def);
  }

  private buildProxy(): Object3D {
    const d = this.def;
    switch (d.type) {
      case 'jelly': {
        const m = new Mesh(unitBox, this.material);
        m.castShadow = m.receiveShadow = true;
        return m;
      }
      case 'balloon': {
        const m = new Mesh(unitSphere, this.material);
        m.castShadow = m.receiveShadow = true;
        return m;
      }
      case 'cloth': {
        this.proxyGeo = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
        const m = new Mesh(this.proxyGeo, this.material);
        m.castShadow = m.receiveShadow = true;
        return m;
      }
      case 'cable': {
        const g = new LineSegmentsGeometry();
        g.setPositions([-0.5, 0, 0, 0.5, 0, 0]);
        this.proxyGeo = g;
        const l = new LineSegments2(g, this.lineMaterial!);
        l.frustumCulled = false;
        return l;
      }
    }
  }

  apply(def: SoftEntity): void {
    this.def = def;
    this.root.position.set(...def.position);
    this.root.quaternion.set(...def.rotation);
    const [x, y, z] = def.size;
    switch (def.type) {
      case 'jelly':
        this.proxy.scale.set(x, y, z);
        break;
      case 'balloon':
        this.proxy.scale.setScalar(x);
        break;
      case 'cloth':
        this.proxy.scale.set(x, 1, z);
        break;
      case 'cable':
        this.proxy.scale.set(x, 1, 1);
        break;
    }
    const m = this.material;
    m.color.set(def.color);
    m.roughness = def.roughness;
    m.opacity = def.opacity;
    m.transparent = def.opacity < 0.999;
    this.lineMaterial?.color.set(def.color);
    this.root.visible = !def.hidden;
    this.proxy.userData.entityId = def.id;
    if (def.type === 'cable') this.lineMaterial!.opacity = def.opacity;
  }

  /** Update the dynamic particle mesh from live positions. */
  setDynamic(positions: Float32Array, indices: Uint32Array, mode: 'tri' | 'line', layoutChanged: boolean): void {
    if (mode === 'tri') {
      let mesh = this.dyn;
      if (
        !mesh ||
        !(mesh instanceof Mesh) ||
        layoutChanged ||
        (mesh.geometry.getAttribute('position')?.count ?? -1) !== positions.length / 3
      ) {
        this.disposeDyn();
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(new Float32Array(positions.length), 3).setUsage(35048));
        g.setIndex(new BufferAttribute(indices, 1));
        mesh = new Mesh(g, this.material);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.userData.entityId = this.def.id;
        this.dyn = mesh;
        this.root.parent?.add(mesh);
      }
      const attr = mesh.geometry.getAttribute('position') as BufferAttribute;
      (attr.array as Float32Array).set(positions);
      attr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
      mesh.visible = !this.def.hidden;
    } else {
      let seg = this.dyn as LineSegments2 | null;
      const arr = new Float32Array(indices.length * 3);
      for (let i = 0; i < indices.length; i++) {
        const p = indices[i] * 3;
        arr[i * 3] = positions[p];
        arr[i * 3 + 1] = positions[p + 1];
        arr[i * 3 + 2] = positions[p + 2];
      }
      if (!seg || !(seg instanceof LineSegments2)) {
        this.disposeDyn();
        seg = new LineSegments2(new LineSegmentsGeometry(), this.lineMaterial!);
        seg.frustumCulled = false;
        seg.userData.entityId = this.def.id;
        this.dyn = seg;
        this.root.parent?.add(seg);
      }
      if (arr.length >= 6) seg.geometry.setPositions(arr);
      seg.visible = !this.def.hidden;
    }
    this.proxy.visible = false;
  }

  clearDynamic(): void {
    this.disposeDyn();
    this.layoutRef = null;
    this.proxy.visible = true;
  }

  private disposeDyn(): void {
    if (!this.dyn) return;
    this.dyn.parent?.remove(this.dyn);
    this.dyn.geometry.dispose();
    this.dyn = null;
  }

  /** The object that is currently shown (and should be picked / outlined). */
  get active(): Object3D {
    return this.dyn ?? this.proxy;
  }

  dispose(): void {
    this.disposeDyn();
    this.proxyGeo?.dispose();
    this.material.dispose();
    this.lineMaterial?.dispose();
  }
}

export class SoftViews {
  readonly views = new Map<string, SoftView>();
  private res = { w: 1, h: 1 };
  private lastLayout = -1;

  constructor(readonly group: Group) {}

  setResolution(w: number, h: number): void {
    this.res = { w, h };
    for (const v of this.views.values()) v.lineMaterial?.resolution.set(w, h);
  }

  get(id: string): SoftView | undefined {
    return this.views.get(id);
  }

  add(def: SoftEntity): void {
    this.remove(def.id);
    const v = new SoftView(def, this.res);
    this.views.set(def.id, v);
    this.group.add(v.root);
  }

  update(def: SoftEntity): void {
    const v = this.views.get(def.id);
    const structural = !v || v.def.type !== def.type || v.def.resolution !== def.resolution;
    if (structural) {
      this.add(def);
      return;
    }
    v.apply(def);
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

  /** Visible meshes for picking / outlines. */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    for (const v of this.views.values()) if (!v.def.hidden) out.push(v.active);
    return out;
  }

  meshOf(id: string): Object3D | null {
    const v = this.views.get(id);
    return v && !v.def.hidden ? v.active : null;
  }

  /** Push the latest simulated particle positions into the dynamic meshes. */
  applyFrame(client: SimClient): void {
    if (!client.active || !client.softLayout.length) {
      if (this.lastLayout !== -2) {
        for (const v of this.views.values()) v.clearDynamic();
        this.lastLayout = -2;
      }
      return;
    }
    const changed = client.softLayoutNo !== this.lastLayout;
    this.lastLayout = client.softLayoutNo;
    for (const entry of client.softLayout) {
      const v = this.views.get(entry.id);
      const pos = client.softOf(entry.id);
      if (!v || !pos) continue;
      const first = v.layoutRef !== entry;
      v.layoutRef = entry;
      v.setDynamic(pos, entry.indices, entry.mode, changed || first);
    }
    // soft bodies that were removed from the simulation (or are not part of it yet)
    for (const [id, v] of this.views) if (!client.softIndex.has(id)) v.clearDynamic();
  }

  /** Leave simulation mode: show proxies again at their document poses. */
  endSim(): void {
    for (const v of this.views.values()) v.clearDynamic();
    this.lastLayout = -2;
  }

  tint(id: string, selected: boolean): void {
    const v = this.views.get(id);
    if (!v) return;
    v.material.emissive.copy(selected ? new Color(0.03, 0.06, 0.1) : new Color(0, 0, 0));
  }
}

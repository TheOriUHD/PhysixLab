/**
 * ED-A: two small editor-only helpers drawn into the viewport's helper layer — the mirror plane of symmetry mode and
 * the live wireframe preview of an array. Both own their three.js objects and free them in `dispose()`.
 */
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Object3D,
} from 'three';

/** A translucent plane with a border and a centre cross, standing for the mirror plane. */
export class MirrorPlaneView {
  readonly group = new Group();
  private readonly quad: Mesh;
  private readonly border: LineSegments;
  private readonly fill = new MeshBasicMaterial({
    color: 0x2dd4bf,
    transparent: true,
    opacity: 0.1,
    side: DoubleSide,
    depthWrite: false,
  });
  private readonly line = new LineBasicMaterial({
    color: 0x2dd4bf,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  private size = 0;

  constructor(parent: Object3D) {
    this.quad = new Mesh(new PlaneGeometry(1, 1), this.fill);
    this.quad.renderOrder = 5;
    this.border = new LineSegments(borderGeometry(), this.line);
    this.border.renderOrder = 6;
    this.group.add(this.quad, this.border);
    this.group.visible = false;
    this.group.name = 'mirror-plane';
    parent.add(this.group);
  }

  /** Stand the plane at `offset` along `axis` (0 = x, 1 = y, 2 = z), centred near `center`, `size` metres across. */
  update(axis: 0 | 1 | 2, offset: number, center: [number, number, number], size: number): void {
    const s = Math.max(2, size);
    this.size = s;
    const c: [number, number, number] = [center[0], center[1], center[2]];
    c[axis] = offset;
    this.group.position.set(c[0], c[1], c[2]);
    this.group.scale.set(s, s, 1);
    this.group.rotation.set(axis === 1 ? -Math.PI / 2 : 0, axis === 0 ? Math.PI / 2 : 0, 0);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  get extent(): number {
    return this.size;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.quad.geometry.dispose();
    this.border.geometry.dispose();
    this.fill.dispose();
    this.line.dispose();
  }
}

function borderGeometry(): BufferGeometry {
  const h = 0.5;
  const v = [
    -h,
    -h,
    0,
    h,
    -h,
    0,
    h,
    -h,
    0,
    h,
    h,
    0,
    h,
    h,
    0,
    -h,
    h,
    0,
    -h,
    h,
    0,
    -h,
    -h,
    0,
    // centre cross
    -h,
    0,
    0,
    h,
    0,
    0,
    0,
    -h,
    0,
    0,
    h,
    0,
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(v, 3));
  return g;
}

/** Wireframe outlines of the boxes of an array preview (one `LineSegments`, replaced on every change). */
export class ArrayGhostView {
  readonly lines: LineSegments;
  private readonly material = new LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85 });

  constructor(private readonly parent: Object3D) {
    this.lines = new LineSegments(new BufferGeometry(), this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 7;
    this.lines.visible = false;
    this.lines.name = 'array-preview';
    parent.add(this.lines);
  }

  show(positions: Float32Array): void {
    this.lines.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(positions, 3));
    this.lines.geometry = g;
    this.lines.visible = positions.length > 0;
  }

  hide(): void {
    this.lines.visible = false;
  }

  dispose(): void {
    this.parent.remove(this.lines);
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}

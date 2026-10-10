/**
 * The snap marker: a ring with a centre dot and a text label ("Vertex", "Edge", "Face", "Bounds", "Surface", "Grid")
 * drawn at the active snap point while an object is dragged or a palette tile is dragged over the viewport. One
 * shared pair of meshes (and one HTML label) is re-used for every update, so showing it allocates nothing.
 */
import { CircleGeometry, Group, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three';
import type { Vec3 } from '../../core/math';
import { SNAP_LABELS, type SnapKind } from '../../model/edit/snap';
import type { App } from '../app';
import { worldPerPixel } from './snapScene';

const COLORS: Record<SnapKind, number> = {
  vertex: 0xffd24a,
  edge: 0x5be3a1,
  face: 0x3ddcff,
  bounds: 0xc59bff,
  surface: 0xff8a5c,
  grid: 0x9fb3c8,
};
const LABEL_KEY = 'snap-indicator';
/** Radius of the marker on screen, in pixels. */
const MARKER_PX = 9;

export class SnapIndicator {
  readonly group = new Group();
  private ring = new Mesh(
    new RingGeometry(0.72, 1, 40),
    new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      side: 2,
    }),
  );
  private dot = new Mesh(
    new CircleGeometry(0.26, 20),
    new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      side: 2,
    }),
  );
  private at = new Vector3();
  /** The kind currently shown, or null. */
  kind: SnapKind | null = null;

  constructor(private app: App) {
    this.ring.renderOrder = 998;
    this.dot.renderOrder = 998;
    this.group.add(this.ring, this.dot);
    this.group.visible = false;
    app.viewport.helpers.add(this.group);
  }

  show(kind: SnapKind, point: Vec3, text = SNAP_LABELS[kind]): void {
    const { app } = this;
    this.at.set(point[0], point[1], point[2]);
    this.group.position.copy(this.at);
    this.group.quaternion.copy(app.camera.quaternion); // face the camera
    this.group.scale.setScalar(MARKER_PX * worldPerPixel(app, point));
    this.ring.material.color.setHex(COLORS[kind]);
    this.dot.material.color.setHex(COLORS[kind]);
    this.group.visible = true;
    this.kind = kind;
    app.labels.set(LABEL_KEY, this.at, text, 'snap');
  }

  hide(): void {
    if (this.kind === null) return;
    this.kind = null;
    this.group.visible = false;
    this.app.labels.remove(LABEL_KEY);
  }

  dispose(): void {
    this.hide();
    this.app.viewport.helpers.remove(this.group);
    this.ring.geometry.dispose();
    this.dot.geometry.dispose();
    this.ring.material.dispose();
    this.dot.material.dispose();
  }
}

const indicators = new WeakMap<App, SnapIndicator>();

export function snapIndicator(app: App): SnapIndicator {
  let i = indicators.get(app);
  if (!i) {
    i = new SnapIndicator(app);
    indicators.set(app, i);
  }
  return i;
}

export function showSnap(app: App, kind: SnapKind, point: Vec3, text?: string): void {
  snapIndicator(app).show(kind, point, text);
}

export function hideSnap(app: App): void {
  indicators.get(app)?.hide();
}

/**
 * Drag-and-drop of library tiles (shape tiles and prefab cards) onto the viewport (ED-15): a live ghost follows the
 * pointer and sits on the surface under it (`surfaceDropPose`), the snap marker names what it snapped to, and the drop
 * inserts the thing exactly there. `shell.ts` forwards the viewport's drag events here.
 *
 * Browsers hide the dragged data until the drop, so the payload is read once, at `dragstart`, from the data the tile
 * itself stored (`text/x-physicslab-shape` / `text/x-physicslab-prefab`).
 */
import type { BufferGeometry } from 'three';
import { BoxGeometry, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial } from 'three';
import type { Vec3 } from '../../core/math';
import { entitiesBounds } from '../../model/edit/shapeSupport';
import { getPrefab } from '../../model/content';
import { hasShape, makeShapeSpec, shapeGeometry, shapeVisualScale } from '../../model/shapeRegistry';
import { defaultSize } from '../../model/shapes';
import { GEOMETRY_KIT } from '../../render/geometryKit';
import type { App } from '../app';
import { hideSnap, showSnap } from './snapIndicator';
import { invertKey } from './snapScene';
import { dropPoseForShape, surfaceDropPose, type DropPose } from './surfaceDrop';

export const SHAPE_MIME = 'text/x-physicslab-shape';
export const PREFAB_MIME = 'text/x-physicslab-prefab';

type Payload = { kind: 'shape'; type: string } | { kind: 'prefab'; id: string };

const GHOST_COLOR = 0x3ddcff;

export class DropController {
  private payload: Payload | null = null;
  private ghost: Group | null = null;
  private ghostGeos: BufferGeometry[] = [];
  private ghostMats: (MeshBasicMaterial | LineBasicMaterial)[] = [];
  private prefabBounds: { min: Vec3; max: Vec3 } | null = null;

  constructor(private app: App) {
    document.addEventListener('dragstart', (e) => this.onDragStart(e));
    document.addEventListener('dragend', () => this.end());
  }

  /** Is this a library tile drag? */
  accepts(e: DragEvent): boolean {
    const t = e.dataTransfer?.types;
    return !!t && (t.includes(SHAPE_MIME) || t.includes(PREFAB_MIME));
  }

  private onDragStart(e: DragEvent): void {
    this.end();
    const dt = e.dataTransfer;
    if (!dt) return;
    // other listeners (the tiles') have stored their data by now; the data store is still readable in dragstart
    const shape = dt.getData(SHAPE_MIME);
    const prefab = dt.getData(PREFAB_MIME);
    if (shape && hasShape(shape)) this.payload = { kind: 'shape', type: shape };
    else if (prefab) this.payload = { kind: 'prefab', id: prefab };
  }

  private poseFor(e: DragEvent, payload: Payload): DropPose | null {
    const { app } = this;
    if (payload.kind === 'shape') return dropPoseForShape(app, e, payload.type, defaultSize(payload.type));
    const b = this.prefabBounds;
    if (!b) return null;
    return surfaceDropPose(app, e.clientX, e.clientY, { min: b.min, max: b.max }, { invert: invertKey(e) });
  }

  private payloadOf(e: DragEvent): Payload | null {
    if (this.payload) return this.payload;
    const dt = e.dataTransfer;
    const shape = dt?.getData(SHAPE_MIME);
    if (shape && hasShape(shape)) return { kind: 'shape', type: shape };
    const prefab = dt?.getData(PREFAB_MIME);
    return prefab ? { kind: 'prefab', id: prefab } : null;
  }

  /** `dragover` on the viewport: move the ghost. */
  over(e: DragEvent): void {
    const payload = this.payload;
    if (!payload) return;
    if (!this.ghost) this.buildGhost(payload);
    const pose = this.poseFor(e, payload);
    if (!pose || !this.ghost) return;
    this.ghost.visible = true;
    this.ghost.position.set(pose.position[0], pose.position[1], pose.position[2]);
    this.ghost.quaternion.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
    if (pose.snap && pose.snapPoint) showSnap(this.app, pose.snap, pose.snapPoint);
    else hideSnap(this.app);
  }

  /** The pointer left the viewport (or the drag ended): remove the ghost and the marker. */
  leave(): void {
    if (this.ghost) this.ghost.visible = false;
    hideSnap(this.app);
  }

  end(): void {
    this.leave();
    if (this.ghost) {
      this.app.viewport.helpers.remove(this.ghost);
      this.ghost = null;
    }
    for (const g of this.ghostGeos) g.dispose();
    for (const m of this.ghostMats) m.dispose();
    this.ghostGeos = [];
    this.ghostMats = [];
    this.payload = null;
    this.prefabBounds = null;
  }

  private buildGhost(payload: Payload): void {
    let bounds: { min: Vec3; max: Vec3 } | null = null;
    if (payload.kind === 'prefab') {
      const pf = getPrefab(payload.id);
      bounds = pf ? entitiesBounds(pf.build()) : null;
      if (!bounds) {
        this.payload = null; // nothing to preview (a prefab without bodies): the drop still inserts it
        return;
      }
      this.prefabBounds = bounds;
    }
    const group = new Group();
    const fill = new MeshBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.28, depthWrite: false });
    const line = new LineBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.95, depthTest: false });
    this.ghostMats.push(fill, line);
    if (payload.kind === 'shape') {
      const spec = makeShapeSpec(payload.type);
      const geo = shapeGeometry(GEOMETRY_KIT, spec);
      const edges = new EdgesGeometry(geo, 25);
      this.ghostGeos.push(geo, edges);
      const mesh = new Mesh(geo, fill);
      mesh.scale.set(...shapeVisualScale(spec));
      const outline = new LineSegments(edges, line);
      outline.scale.copy(mesh.scale);
      group.add(mesh, outline);
    } else {
      const b = bounds!;
      const size: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      const box = new BoxGeometry(size[0], size[1], size[2]);
      const edges = new EdgesGeometry(box);
      this.ghostGeos.push(box, edges);
      const centre: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      const mesh = new Mesh(box, fill);
      const outline = new LineSegments(edges, line);
      mesh.position.set(...centre);
      outline.position.set(...centre);
      group.add(mesh, outline);
    }
    group.traverse((o) => (o.renderOrder = 990));
    group.visible = false;
    this.ghost = group;
    this.app.viewport.helpers.add(group);
  }

  /**
   * `drop` on the viewport. Returns true when the drop was a library tile and has been inserted.
   */
  drop(e: DragEvent): boolean {
    const payload = this.payloadOf(e);
    this.end();
    if (!payload) return false;
    const { app } = this;
    if (payload.kind === 'shape') {
      if (!hasShape(payload.type)) return false;
      const pose = dropPoseForShape(app, e, payload.type, defaultSize(payload.type));
      app.addShape(payload.type, pose.position, pose.rotation);
      return true;
    }
    const pf = getPrefab(payload.id);
    const b = pf ? entitiesBounds(pf.build()) : null;
    if (!pf) return false;
    const pose = b
      ? surfaceDropPose(app, e.clientX, e.clientY, { min: b.min, max: b.max }, { invert: invertKey(e) })
      : surfaceDropPose(app, e.clientX, e.clientY, { halfHeight: 0.5 }, { invert: invertKey(e) });
    app.insertPrefab(payload.id, { position: pose.position, rotation: pose.rotation });
    return true;
  }
}

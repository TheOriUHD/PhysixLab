/**
 * Ghost bodies (TM-5): translucent copies of a stored run's moving bodies, posed from its trajectory track at the
 * live run's simulation time. Built on a private `BodyViews` (own geometry cache, instancing off), so nothing is
 * shared with — or can leak into — the live views, and `dispose` frees everything it made.
 */
import { Group, type Object3D } from 'three';
import { samplePose } from '../app/trackMath';
import type { BodyEntity } from '../model/types';
import type { TrackData } from '../physics/timelineTypes';
import { BodyViews } from './bodyViews';

export class GhostSet {
  readonly group = new Group();
  private views: BodyViews;
  private track: TrackData | null = null;
  private order: { index: number; mesh: Object3D }[] = [];
  private readonly pose = new Float64Array(7);

  constructor(
    private parent: Object3D,
    private tint: string,
  ) {
    this.group.name = 'ghosts';
    this.group.visible = false;
    this.views = new BodyViews(this.group);
    this.views.setInstancing(false);
    parent.add(this.group);
  }

  get loaded(): TrackData | null {
    return this.track;
  }

  /** Show `track`; `defOf` finds the body definition for an id (bodies it cannot find are left out). */
  setTrack(track: TrackData | null, defOf: (id: string) => BodyEntity | undefined): void {
    this.clear();
    if (!track) return;
    this.track = track;
    track.ids.forEach((id, index) => {
      const def = defOf(id);
      if (!def) return;
      const view = this.views.add({ ...def, skin: undefined, hidden: false, ghost: false });
      for (const piece of view.pieces) {
        const m = piece.material;
        m.color.set(this.tint);
        m.emissive.set(this.tint);
        m.emissiveIntensity = 0.35;
        m.transparent = true;
        m.opacity = 0.34;
        m.depthWrite = false;
        m.metalness = 0;
        piece.mesh.castShadow = false;
        piece.mesh.receiveShadow = false;
        piece.mesh.raycast = () => undefined; // ghosts are not pickable
      }
      this.order.push({ index, mesh: view.mesh });
    });
  }

  /** Pose the ghosts at `t` seconds after the track's first sample. */
  update(t: number, visible: boolean): void {
    this.group.visible = visible && this.order.length > 0;
    if (!this.group.visible || !this.track) return;
    const p = this.pose;
    for (const { index, mesh } of this.order) {
      samplePose(this.track, index, t, p);
      mesh.position.set(p[0], p[1], p[2]);
      mesh.quaternion.set(p[3], p[4], p[5], p[6]);
    }
  }

  clear(): void {
    for (const id of [...this.views.views.keys()]) this.views.remove(id);
    this.order = [];
    this.track = null;
  }

  dispose(): void {
    this.clear();
    this.parent.remove(this.group);
  }
}

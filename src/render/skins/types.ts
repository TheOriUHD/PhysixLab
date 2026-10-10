/**
 * VZ-42: visual skins. A skin is a render-only model (several meshes) drawn in place of a body's own shape, so a
 * physics box can *look* like a detailed object. The physics is untouched: the skin follows the body's pose, and
 * may read other bodies' poses (wheels, for suspension travel) and the held keys (brake lights).
 */
import type { Object3D, Quaternion, Vector3 } from 'three';
import type { BodyEntity, SkinSpec } from '../../model/types';

/** Read-only view of another body's current world pose. */
export interface SkinBodyPose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly def: BodyEntity;
}

/** What a skin gets every frame. All objects are reused between frames: copy what you keep. */
export interface SkinFrame {
  dt: number;
  /** World pose of the skinned body. */
  position: Vector3;
  quaternion: Quaternion;
  /** `KeyboardEvent.code` of every held key (the same set that drives motors). */
  keys: ReadonlySet<string>;
  /** True while a simulation is running (otherwise bodies are at their authored pose). */
  simulating: boolean;
  /** Bodies carrying `tag` (BodyEntity.tags), in document order. Cached; do not mutate. */
  bodiesWithTag(tag: string): readonly SkinBodyPose[];
}

export interface SkinInstance {
  /**
   * Content in the body's *local* frame, in metres, with the shape's own size already applied: a box body of size
   * [2.3, 0.35, 1.2] hands the skin a root whose local x spans ±1.15.
   */
  root: Object3D;
  update(frame: SkinFrame): void;
  dispose(): void;
}

export interface SkinDef {
  /** Registry id, e.g. `car.body`. Stored in documents: never rename. */
  id: string;
  label: string;
  /** Shape types the skin fits (`ShapeSpec.type`); omit for any. */
  shapes?: string[];
  /** `size` is the body's visual size (shapeVisualScale). `params` are the document's `skin.params`. */
  build(size: readonly [number, number, number], spec: SkinSpec, def: BodyEntity): SkinInstance;
}

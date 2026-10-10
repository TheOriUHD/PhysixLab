/**
 * DT-1 exporters: the shared vocabulary. The writers (glTF, OBJ, STL) are pure — they take an `ExportScene`, which
 * `buildExportScene` derives from a `SceneDocument` and a `GeometryProvider`, and they return bytes or text. Nothing
 * here imports three.js or the DOM, so all of it runs in Vitest/Node; `threeGeometry.ts` is the one adapter that
 * supplies real triangle data from the shape registry.
 */
import type { Quat, Vec3 } from '../../core/math';
import type { ShapeSpec } from '../../model/types';

/** An indexed triangle mesh. Positions and normals are xyz triples; `indices` has three entries per triangle. */
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Where triangle data comes from. `shape` returns the mesh of a shape *already scaled to its size* in the shape's own
 * local frame (the frame of the body or collider part that owns it). Equal specs should return the same object so
 * the writers can share it.
 */
export interface GeometryProvider {
  shape(spec: ShapeSpec): MeshData;
}

/** Surface of one exported primitive; colours are sRGB 0..1 (the writers convert for formats that want linear). */
export interface ExportMaterial {
  name: string;
  color: Vec3;
  metalness: number;
  roughness: number;
  opacity: number;
}

export interface ExportPrimitive {
  mesh: MeshData;
  /** Index into `ExportScene.materials`. */
  material: number;
}

export interface ExportLight {
  type: 'point' | 'spot' | 'directional';
  color: Vec3;
  /** cd (point, spot) or lux (directional). */
  intensity: number;
  /** Cut-off distance in metres (0 = infinite). */
  range: number;
  /** Spot half-angle, radians. */
  angle: number;
  /** Spot softness 0..1 (three.js convention). */
  penumbra: number;
}

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

/** One node of the exported hierarchy. `translation` / `rotation` are relative to the parent; `world` is absolute. */
export interface ExportNode {
  /** Entity id this node was made from; absent for nodes that belong to a body (its parts) or the ground. */
  entityId?: string;
  name: string;
  translation: Vec3;
  rotation: Quat;
  world: Pose;
  primitives: ExportPrimitive[];
  light?: ExportLight;
  children: ExportNode[];
}

export interface SkippedEntity {
  id: string;
  name: string;
  reason: string;
}

export interface ExportScene {
  name: string;
  roots: ExportNode[];
  materials: ExportMaterial[];
  /** Entities that could not be exported, with the reason (soft bodies, area lights …). */
  skipped: SkippedEntity[];
}

export interface SceneExportOptions {
  /** Export only these entities (and the descendants of selected groups). Default: everything. */
  ids?: readonly string[];
  /** Include the ground slab (when the scene has one). Default true. */
  ground?: boolean;
  /** Include entities hidden in the editor. Default false. */
  includeHidden?: boolean;
  /** Include lights (glTF only uses them). Default true. */
  lights?: boolean;
}

/** World poses of entities over time, for baked animation. `times` are seconds from the first sample. */
export interface AnimationFrames {
  times: number[];
  /** Entity id -> one pose per time sample. */
  poses: Map<string, Pose[]>;
}

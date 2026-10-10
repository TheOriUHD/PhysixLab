/**
 * Surface placement for things that are dropped into the scene (ED-15): palette shape tiles, prefab cards and — through
 * `surfaceDropPose` — user prefabs (ED-22) or anything else with bounds.
 *
 * The pointer ray is cast at the scene's bodies and at the ground; the nearest hit is the surface. The thing is put on
 * it so that its support function touches the hit point exactly (no gap, no penetration), optionally with its up axis
 * turned onto the surface normal (preference `snapAlignNormal`, "Align to surface normal"). On top of that the same
 * snap switches as for dragging apply: grid (horizontal surfaces only, so a slope is never left), vertex / edge /
 * face / bounds of nearby objects. Holding Ctrl while dropping suspends them (see `effectiveModes`).
 */
import type { Quat, Vec3 } from '../../core/math';
import { qrot } from '../../core/math';
import { boxCorners, featuresOfShape, supportOfShape } from '../../model/edit/shapeSupport';
import {
  shapeFeatures,
  snapToGrid,
  surfacePlacement,
  type ShapeFeatures,
  type SnapKind,
  type SupportShape,
} from '../../model/edit/snap';
import { halfHeight } from '../../model/shapes';
import type { ShapeSpec, ShapeType } from '../../model/types';
import { makeShapeSpec } from '../../model/shapeRegistry';
import type { App } from '../app';
import { effectiveModes, featureSnapFor, invertKey, type SnapModes } from './snapScene';

/** What is being dropped. Give the most precise one you have: `support`, else `min`/`max`, else `halfHeight`. */
export interface DropBounds {
  /** Exact convex solid, centred on the pose origin. */
  support?: SupportShape;
  /** Axis-aligned bounds relative to the pose origin (a prefab or a user prefab). */
  min?: Vec3;
  max?: Vec3;
  /** Half the height only (everything is treated as a cube of that half size). */
  halfHeight?: number;
  /** Snap features for vertex / edge / face / bounds snapping (derived from the support when absent). */
  features?: ShapeFeatures;
}

export interface SurfaceDropOptions {
  /** Turn the up axis onto the surface normal. Default: the preference `snapAlignNormal`. */
  alignNormal?: boolean;
  /** Invert all snap switches (the Ctrl key). */
  invert?: boolean;
  /** Pose the thing starts with; its rotation is kept unless `alignNormal`. Default identity. */
  rotation?: Quat;
  /** Body ids that must not count as surfaces or snap targets. */
  exclude?: ReadonlySet<string>;
  /** -- ghost placement: suspend the grid and the vertex / edge / face / bounds snaps (the Alt key); the thing still rests flush. */
  noSnap?: boolean;
}

export interface DropPose {
  /** Where the origin of the dropped thing goes. */
  position: Vec3;
  rotation: Quat;
  /** What the pointer ray found. `view` = nothing under the pointer, so the view target is used. */
  where: 'surface' | 'ground' | 'view';
  normal: Vec3;
  /** Which snap decided the result (null = the plain surface / ground point). */
  snap: SnapKind | null;
  /** Where the snap indicator belongs. */
  snapPoint: Vec3 | null;
  /** -- ghost placement: the surface point the thing touches (after the grid, moved with any feature snap). */
  point: Vec3;
}

const IDENT: Quat = [0, 0, 0, 1];
const UP: Vec3 = [0, 1, 0];
/** Surfaces this horizontal count as flat ground for grid snapping (cos of 1.1°). */
const FLAT = 0.9998;

interface Frame {
  support: SupportShape;
  /** Offset from the origin of the dropped thing to the centre of its support shape. */
  centre: Vec3;
  features: ShapeFeatures;
}

function frameOf(b: DropBounds): Frame {
  if (b.support) return { support: b.support, centre: [0, 0, 0], features: b.features ?? shapeFeatures(b.support) };
  if (b.min && b.max) {
    const centre: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const half: Vec3 = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
    const support: SupportShape = { k: 'points', pts: boxCorners(half) };
    return { support, centre, features: b.features ?? shapeFeatures(support) };
  }
  const hh = Math.max(0.001, b.halfHeight ?? 0.5);
  const support: SupportShape = { k: 'points', pts: boxCorners([hh, hh, hh]) };
  return { support, centre: [0, 0, 0], features: b.features ?? shapeFeatures(support) };
}

/**
 * The pose at which something with `bounds` should be dropped when the pointer is at (`clientX`, `clientY`).
 * Never throws; with nothing under the pointer it falls back to the view target on the ground (the old behaviour).
 */
export function surfaceDropPose(
  app: App,
  clientX: number,
  clientY: number,
  bounds: DropBounds,
  opts: SurfaceDropOptions = {},
): DropPose {
  const ev = { clientX, clientY };
  const modes: SnapModes = opts.noSnap ? withoutSnaps(effectiveModes(app, false)) : effectiveModes(app, !!opts.invert);
  const frame = frameOf(bounds);
  const startRot = opts.rotation ?? IDENT;

  // 1. what is under the pointer
  const exclude = opts.exclude;
  const targets = app.bodies.pickables().filter((m) => !exclude?.has(m.userData.entityId as string));
  const hit = app.picker.pick(ev, targets);
  const g = app.picker.groundPoint(ev, 0);
  const groundDist = g ? app.camera.position.distanceTo(g) : Infinity;
  let where: DropPose['where'];
  let point: Vec3;
  let normal: Vec3 = UP;
  if (hit && hit.normal && hit.distance < groundDist) {
    where = 'surface';
    point = [hit.point.x, hit.point.y, hit.point.z];
    normal = [hit.normal.x, hit.normal.y, hit.normal.z];
  } else if (g && groundDist < 150) {
    where = 'ground';
    point = [g.x, 0, g.z];
  } else {
    where = 'view';
    const t = app.viewport.controls.target;
    point = [t.x, 0, t.z];
  }

  // 2. grid: only on horizontal surfaces, so that a slope keeps the thing flush
  if (modes.grid && normal[1] > FLAT) {
    const s = app.prefs.value.snapGrid;
    point = [snapToGrid(point[0], s), point[1], snapToGrid(point[2], s)];
  }

  // 3. put the support shape on the surface
  const align = (opts.alignNormal ?? modes.alignNormal) && where === 'surface';
  let rotation: Quat = startRot;
  let centrePos: Vec3;
  if (modes.surface) {
    const p = surfacePlacement(frame.support, startRot, point, normal, align, where === 'surface' ? 0.002 : 0.001);
    centrePos = p.position;
    rotation = p.rotation;
  } else {
    // legacy placement: straight up on flat tops, otherwise out along the normal by the half height
    const hh = bounds.halfHeight ?? hhOf(frame);
    const up = normal[1] > 0.7;
    centrePos = up
      ? [point[0], point[1] + hh + 0.01, point[2]]
      : [point[0] + normal[0] * (hh + 0.01), point[1] + normal[1] * (hh + 0.01), point[2] + normal[2] * (hh + 0.01)];
    if (where !== 'surface') centrePos = [point[0], hh + 0.001, point[2]];
  }

  // 4. snap to the features of nearby objects (vertex / edge / face / bounds)
  let snap: SnapKind | null = null;
  let snapPoint: Vec3 | null = null;
  if (modes.vertex || modes.edge || modes.face || modes.bounds) {
    const moving = { id: '__drop__', position: centrePos, rotation, shape: frame.features };
    const hitF = featureSnapFor(app, [moving], modes, exclude ?? new Set());
    if (hitF) {
      centrePos = [centrePos[0] + hitF.delta[0], centrePos[1] + hitF.delta[1], centrePos[2] + hitF.delta[2]];
      point = [point[0] + hitF.delta[0], point[1] + hitF.delta[1], point[2] + hitF.delta[2]];
      snap = hitF.kind;
      snapPoint = hitF.point;
    }
  }
  if (!snap && modes.surface && where !== 'view') {
    snap = where === 'surface' ? 'surface' : null;
    snapPoint = where === 'surface' ? point : null;
  }

  // the pose origin is the support centre moved back by the (rotated) offset
  const off = qrot(rotation, frame.centre);
  const position: Vec3 = [centrePos[0] - off[0], centrePos[1] - off[1], centrePos[2] - off[2]];
  return { position, rotation, where, normal, snap, snapPoint, point };
}

/** -- ghost placement: every snap off except resting flush on the surface. */
function withoutSnaps(m: SnapModes): SnapModes {
  return { ...m, grid: false, vertex: false, edge: false, face: false, bounds: false, surface: true };
}

/** Half height of a frame's support along Y (legacy placement only). */
function hhOf(frame: Frame): number {
  const s = frame.support;
  if (s.k === 'points') return Math.max(...s.pts.map((p) => Math.abs(p[1])));
  if (s.k === 'ellipsoid') return s.r[1];
  if (s.k === 'cylinder' || s.k === 'cone') return s.h;
  return s.h + s.r;
}

/** `DropBounds` of a registered shape at its default (or given) size. */
export function boundsOfShape(spec: ShapeSpec): DropBounds {
  return { support: supportOfShape(spec), features: featuresOfShape(spec), halfHeight: halfHeight(spec) };
}

/** The pose for dropping a new primitive of `type` at the pointer. */
export function dropPoseForShape(
  app: App,
  ev: { clientX: number; clientY: number; ctrlKey?: boolean; metaKey?: boolean },
  type: ShapeType,
  size?: Vec3,
): DropPose {
  const spec: ShapeSpec = makeShapeSpec(type);
  if (size) spec.size = size;
  return surfaceDropPose(app, ev.clientX, ev.clientY, boundsOfShape(spec), { invert: invertKey(ev) });
}

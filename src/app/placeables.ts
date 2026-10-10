/**
 * Placeables: the things a library tile can put into the scene, described once for ghost placement
 * (`placementGhost.ts`). A `Placeable` knows how big it is (so it can rest flush on a surface), what its ghost looks
 * like (the entities around its pose origin), whether it can be placed right now, and how to create the real thing
 * as one undoable command. One factory per kind of tile: shapes, soft bodies, prefabs (built-in and the user's own),
 * zones, lights and paths.
 *
 * To make a new kind of tile placeable, add a factory here and call `bindPlaceable(app, el, placeable)`
 * (`src/ui/placementTiles.ts`) on its element.
 */
import { qmul, type Quat, type Vec3 } from '../core/math';
import { getPrefab } from '../model/content';
import { entitiesBounds, supportOfShape } from '../model/edit/shapeSupport';
import { instantiatePrefab } from '../model/edit/userPrefab';
import { createBody, createLight, createPath, createSoft, LIGHT_LABELS, SOFT_LABELS } from '../model/factory';
import { LIMITS } from '../model/limits';
import { getShape, makeShapeSpec, shapeLabel } from '../model/shapeRegistry';
import { torusSurface, tyreGeometry, TYRE_ACROSS } from '../model/softMesh';
import type { Entity, LightType, ShapeType, SoftEntity, SoftType } from '../model/types';
import { buildZone, ZONE_PRESETS } from '../model/zonePresets';
import { zoneActionInfo, type ZoneAction } from '../model/zones';
import { LIGHT_ITEMS, SOFT_ITEMS } from './addCatalog';
import type { App } from './app';
import { boundsOfShape, type DropBounds } from './edit/surfaceDrop';
import { insertUserPrefab, prefabLibrary } from './edit/prefabActions';
import { addZone } from './zoneCommands';

export interface PlacePose {
  position: Vec3;
  rotation: Quat;
}

export interface Placeable {
  readonly kind: 'shape' | 'soft' | 'prefab' | 'userPrefab' | 'zone' | 'light' | 'path';
  /** Unique key of the tile, e.g. `shape:box`; the tile carries it as `data-placeable`. */
  readonly id: string;
  readonly label: string;
  /** Key of `src/ui/icons.ts`. */
  readonly icon: string;
  /** Metres it hovers above the surface under the pointer (a cloth, a light), on top of the user's raise / lower. */
  readonly hover: number;
  /** False when turning it makes no sense (a zone's helper bodies are placed in world coordinates). */
  readonly rotatable: boolean;
  /** The solid it occupies, relative to its pose origin, for resting it flush on a surface. */
  bounds(): DropBounds;
  /** Extent for the label (width, height, depth), or null when a size means nothing (a light). */
  extent(): Vec3 | null;
  /** The ghost: entities around the pose origin. Built on first use. */
  entities(): Entity[];
  /** Why it cannot be placed right now, or null. */
  blocked?(app: App): string | null;
  /** Create the real thing at `pose` as ONE undo step and select it. Returns the new ids. */
  commit(app: App, pose: PlacePose): string[];
  /** Add it at the centre of the view without a ghost (double-click on the tile). */
  addAtViewCentre(app: App): void;
}

const selected = (app: App): string[] => [...app.store.selection];

/** Axis-aligned extents of a list of entities, or null. */
function extentOf(list: readonly Entity[]): Vec3 | null {
  const b = entitiesBounds(list);
  return b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : null;
}

/** Cache the (possibly expensive) entity list of a placeable: it is built when the first ghost needs it. */
function lazy<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}

// ── shapes ──────────────────────────────────────────────────────────────────────────────────────────

export function shapePlaceable(type: ShapeType): Placeable {
  const spec = makeShapeSpec(type);
  const entities = lazy((): Entity[] => [createBody({ name: shapeLabel(type), shape: spec, position: [0, 0, 0] })]);
  return {
    kind: 'shape',
    id: `shape:${type}`,
    label: shapeLabel(type),
    icon: getShape(type)?.icon ?? 'box',
    hover: 0,
    rotatable: true,
    bounds: () => boundsOfShape(spec),
    extent: () => extentOf(entities()),
    entities,
    commit(app, pose) {
      app.editor.addShape(type, pose.position, pose.rotation[3] < 0.9999999 ? { rotation: pose.rotation } : {});
      return selected(app);
    },
    addAtViewCentre: (app) => void app.addShape(type),
  };
}

// ── soft bodies ─────────────────────────────────────────────────────────────────────────────────────

/** Bounding box of a triangle mesh given as a flat vertex array. */
function meshBounds(vertices: Float32Array | number[]): DropBounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < vertices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], vertices[i + k]);
      max[k] = Math.max(max[k], vertices[i + k]);
    }
  return Number.isFinite(min[0]) ? { min, max } : { halfHeight: 0.5 };
}

function softBounds(s: SoftEntity): DropBounds {
  const [x, y, z] = s.size;
  switch (s.type) {
    case 'jelly':
      return { min: [-x / 2, -y / 2, -z / 2], max: [x / 2, y / 2, z / 2] };
    case 'balloon':
      return { support: { k: 'ellipsoid', r: [x / 2, x / 2, x / 2] }, halfHeight: x / 2 };
    case 'cloth':
      return { min: [-x / 2, -0.02, -z / 2], max: [x / 2, 0.02, z / 2] };
    case 'cable':
      return { min: [-x / 2, -0.05, -0.05], max: [x / 2, 0.05, 0.05] };
    case 'mesh':
      return { support: supportOfShape({ ...s.shape, size: s.size }), halfHeight: y / 2 };
    case 'tyre': {
      const t = tyreGeometry(s.size);
      return meshBounds(torusSurface(t.major, t.radial, t.axial, 12, TYRE_ACROSS).vertices);
    }
  }
}

/** Cloth and cable hover above the surface (they are pinned or draped from there); a jelly or balloon rests on it. */
const SOFT_HOVER: Partial<Record<SoftType, number>> = { cloth: 1.5, cable: 1.5 };

export function softPlaceable(type: SoftType): Placeable {
  const proto = createSoft(type, { position: [0, 0, 0] });
  return {
    kind: 'soft',
    id: `soft:${type}`,
    label: SOFT_LABELS[type],
    icon: SOFT_ITEMS.find((i) => i.type === type)?.icon ?? 'jelly',
    hover: SOFT_HOVER[type] ?? 0,
    rotatable: true,
    bounds: () => softBounds(proto),
    extent: () => {
      const b = softBounds(proto);
      if (b.min && b.max) return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      return proto.size;
    },
    entities: () => [proto],
    commit(app, pose) {
      app.editor.addSoft(type, undefined, { position: pose.position, rotation: pose.rotation });
      return selected(app);
    },
    addAtViewCentre: (app) => app.addSoft(type),
  };
}

// ── lights and paths ────────────────────────────────────────────────────────────────────────────────

const LIGHT_HOVER: Record<LightType, number> = { point: 3, spot: 3, directional: 6, area: 3 };

export function lightPlaceable(type: LightType): Placeable {
  const entities = lazy((): Entity[] => [createLight(type, { position: [0, 0, 0] })]);
  return {
    kind: 'light',
    id: `light:${type}`,
    label: LIGHT_LABELS[type],
    icon: LIGHT_ITEMS.find((i) => i.type === type)?.icon ?? 'light',
    hover: LIGHT_HOVER[type],
    rotatable: true,
    bounds: () => ({ halfHeight: 0.15 }),
    extent: () => null,
    entities,
    blocked: (app) =>
      app.store.lights().length >= LIMITS.maxLights ? `Only ${LIMITS.maxLights} lights fit in a scene` : null,
    commit(app, pose) {
      // the light's own aim (down for spot / sun / area) is turned by the ghost's rotation
      app.editor.addLight(type, pose.position, { rotation: qmul(pose.rotation, createLight(type).rotation) });
      return selected(app);
    },
    addAtViewCentre: (app) => app.addLight(type),
  };
}

export function pathPlaceable(): Placeable {
  const entities = lazy((): Entity[] => [createPath({ position: [0, 0, 0] })]);
  return {
    kind: 'path',
    id: 'path',
    label: 'Path',
    icon: 'path',
    hover: 0.05,
    rotatable: true,
    bounds: () => ({ halfHeight: 0.05 }),
    extent: () => [6, 0, 2.4],
    entities,
    commit(app, pose) {
      app.editor.addPath(pose.position, { rotation: pose.rotation });
      return selected(app);
    },
    addAtViewCentre: (app) => app.addPath(),
  };
}

// ── assemblies ──────────────────────────────────────────────────────────────────────────────────────

function boundsOfEntities(list: readonly Entity[]): DropBounds {
  const b = entitiesBounds(list);
  return b ? { min: b.min, max: b.max } : { halfHeight: 0.5 };
}

/** A built-in prefab (the Prefabs tab). */
export function prefabPlaceable(id: string): Placeable | null {
  const pf = getPrefab(id);
  if (!pf) return null;
  const entities = lazy(() => pf.build());
  return {
    kind: 'prefab',
    id: `prefab:${id}`,
    label: pf.name,
    icon: pf.icon,
    hover: 0,
    rotatable: true,
    bounds: () => boundsOfEntities(entities()),
    extent: () => extentOf(entities()),
    entities,
    commit(app, pose) {
      app.insertPrefab(id, pose);
      return selected(app);
    },
    addAtViewCentre: (app) => app.insertPrefab(id),
  };
}

/** A prefab the user saved (My prefabs). */
export function userPrefabPlaceable(app: App, id: string): Placeable | null {
  const prefab = prefabLibrary(app).get(id);
  if (!prefab) return null;
  const entities = lazy((): Entity[] => {
    try {
      return instantiatePrefab(prefab, prefabLibrary(app).get, { takenNames: [], maxEntities: 4000 }).entities;
    } catch {
      return [];
    }
  });
  return {
    kind: 'userPrefab',
    id: `userprefab:${id}`,
    label: prefab.name,
    icon: 'layers',
    hover: 0,
    rotatable: true,
    bounds: () => boundsOfEntities(entities()),
    extent: () => extentOf(entities()),
    entities,
    blocked: (a) => (a.sim.active ? 'Stop the simulation (Space) to insert prefabs' : null),
    commit(a, pose) {
      return insertUserPrefab(a, id, { at: pose.position, rotation: pose.rotation }).map((e) => e.id);
    },
    addAtViewCentre: (a) => void insertUserPrefab(a, id),
  };
}

/** A zone tile (trigger volumes, race lines, launch pads …) with whatever helper bodies it comes with. */
export function zonePlaceable(action: ZoneAction): Placeable {
  const info = zoneActionInfo(action);
  const entities = lazy((): Entity[] => buildZone(action, { at: [0, 0, 0] }));
  return {
    kind: 'zone',
    id: `zone:${action}`,
    label: ZONE_PRESETS[action].name,
    icon: info.icon,
    hover: 0,
    rotatable: false,
    bounds: () => boundsOfEntities(entities()),
    extent: () => extentOf(entities()),
    entities,
    commit(app, pose) {
      addZone(app, action, pose.position);
      return selected(app);
    },
    addAtViewCentre: (app) => void addZone(app, action),
  };
}

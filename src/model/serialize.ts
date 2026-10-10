import { sanitizeParams } from './jointParams';
import { clamp, type Vec3 } from '../core/math';
import { SceneFormatError, warn, type LoadReport } from './errors';
import {
  createBody,
  createJoint,
  createSoft,
  defaultBounds,
  defaultEnvironment,
  defaultSettings,
  defaultUnits,
  softDefaults,
} from './factory';
import { LIMITS, formatBytes, formatCount } from './limits';
import { pruneAssets, remapAssetRefs } from './assets';
import { sanitizeAssetMap } from './sanitize/assets';
import { isDefaultCameras, sanitizeCameras } from './sanitize/cameras'; // -- CM-A --
import { sanitizeWeatherField } from './sanitize/weather'; // -- VZ-B: weather --
import { repairParents, sanitizeBodyFields } from './sanitize/bodyFields';
import { dedupeComponentIds, repairComponentRefs, sanitizeComponents } from './componentRegistry';
import { outlinerMetaFields, sanitizeSelectionSets } from './sanitize/outlinerMeta'; // -- UI-A --
import { parentField, sanitizeGroup, sanitizeLight, sanitizePath } from './sanitize/kinds';
import { sanitizeParts } from './sanitize/parts';
import { sanitizeVisual } from './sanitize/visual';
import { breakageField } from './breakage';
import { layersField } from './collisionLayers';
import { SCENE_FORMAT, SCENE_VERSION, migrateDocument } from './migrations';
import {
  bool,
  bool3,
  hexColor,
  idStr,
  int,
  nameStr,
  num,
  oneOf,
  position3,
  quat,
  str,
  vec3,
} from './sanitize/primitives';
import { sanitizeShapeSpec } from './shapeRegistry';
import { softParticleCount } from './softBudget';
import type {
  BodyEntity,
  BoundsSettings,
  EnvironmentSettings,
  Entity,
  JointEntity,
  JointType,
  SceneDocument,
  SceneSettings,
  SkyPreset,
  SoftAttachment,
  SoftEntity,
  SoftPin,
  SoftType,
  UnitsSettings,
} from './types';
import { isGroup, isLight, isPosed } from './types';

const SOFTS: SoftType[] = ['jelly', 'balloon', 'cloth', 'cable', 'mesh', 'tyre'];
const PINS: SoftPin[] = ['none', 'edge', 'corners', 'corners4', 'one-end', 'ends'];
const JOINTS: JointType[] = [
  'fixed',
  'hinge',
  'slider',
  'ball',
  'spring',
  'rope',
  // -- JT-A --
  'conetwist',
  'sixdof',
  'pulley',
  'rack',
  'gear',
  'belt',
  'universal',
  'screw',
  'winch',
  'softweld',
];
const SKIES: SkyPreset[] = [
  'studio',
  'day',
  'sunset',
  'night',
  'overcast',
  'blueprint',
  'space',
  'lab',
  'desert',
  'snow',
  'physical',
  'hdri',
];

function sanitizeBody(raw: any, report?: LoadReport): BodyEntity {
  const name = nameStr(raw?.name, '');
  const shape = sanitizeShapeSpec(raw?.shape, report, name ? `"${name}"` : 'an object');
  const base = createBody({ shape });
  const mat = raw?.material ?? {};
  const bodyType = ['dynamic', 'static', 'kinematic'].includes(raw?.bodyType) ? raw.bodyType : 'dynamic';
  const thrust =
    raw?.thrust && typeof raw.thrust === 'object'
      ? {
          force: vec3(raw.thrust.force, [0, 0, 0]),
          torque: vec3(raw.thrust.torque, [0, 0, 0]),
          mode: raw.thrust.mode === 'key' ? ('key' as const) : ('always' as const),
          key: str(raw.thrust.key, ''),
        }
      : null;
  return {
    ...base,
    id: idStr(raw?.id, base.id),
    name: nameStr(raw?.name, base.name),
    shape,
    position: position3(raw?.position, [0, 0, 0]),
    rotation: quat(raw?.rotation),
    bodyType,
    material: {
      preset: str(mat.preset, 'custom'),
      density: Math.max(1, num(mat.density, base.material.density)),
      friction: Math.max(0, num(mat.friction, base.material.friction)),
      restitution: clamp(num(mat.restitution, base.material.restitution), 0, 1.5),
      color: str(mat.color, base.material.color),
      metalness: clamp(num(mat.metalness, base.material.metalness), 0, 1),
      roughness: clamp(num(mat.roughness, base.material.roughness), 0, 1),
      opacity: clamp(num(mat.opacity, 1), 0.05, 1),
      ...sanitizeVisual(mat), // -- VZ-A: PBR extras + texture --
    },
    linearDamping: Math.max(0, num(raw?.linearDamping, base.linearDamping)),
    angularDamping: Math.max(0, num(raw?.angularDamping, base.angularDamping)),
    gravityScale: num(raw?.gravityScale, 1),
    ccd: bool(raw?.ccd, false),
    canSleep: bool(raw?.canSleep, true),
    velocity: vec3(raw?.velocity, [0, 0, 0]),
    angularVelocity: vec3(raw?.angularVelocity, [0, 0, 0]),
    lockPosition: bool3(raw?.lockPosition),
    lockRotation: bool3(raw?.lockRotation),
    thrust,
    ghost: bool(raw?.ghost, false),
    locked: bool(raw?.locked, false),
    hidden: bool(raw?.hidden, false),
    ...sanitizeBodyFields(raw ?? {}),
    ...outlinerMetaFields(raw ?? {}, false), // -- UI-A --
    ...sanitizeCompound(raw ?? {}, report, name ? `"${name}"` : 'an object'),
    components: sanitizeComponents(raw?.components, 'body', report, name ? `"${name}"` : 'an object'),
  };
}

/** `parts` and `meshId` — only present on the entity when set. */
function sanitizeCompound(
  raw: any,
  report: LoadReport | undefined,
  owner: string,
): Pick<BodyEntity, 'parts' | 'meshId'> {
  const out: Pick<BodyEntity, 'parts' | 'meshId'> = {};
  const parts = sanitizeParts(raw.parts, report, owner);
  if (parts) out.parts = parts;
  if (typeof raw.meshId === 'string' && raw.meshId) out.meshId = idStr(raw.meshId, '');
  return out;
}

function sanitizeJoint(raw: any, report?: LoadReport): JointEntity {
  const type: JointType = JOINTS.includes(raw?.type) ? raw.type : 'ball';
  const anchorA = vec3(raw?.anchorA, [0, 0, 0]);
  const base = createJoint({ type, bodyA: null, bodyB: null, anchorA });
  const m = raw?.motor ?? {};
  const l = raw?.limit ?? {};
  const s = raw?.spring ?? {};
  return {
    ...base,
    id: idStr(raw?.id, base.id),
    name: nameStr(raw?.name, base.name),
    bodyA: typeof raw?.bodyA === 'string' ? raw.bodyA : null,
    bodyB: typeof raw?.bodyB === 'string' ? raw.bodyB : null,
    anchorA,
    anchorB: vec3(raw?.anchorB, anchorA),
    axis: vec3(raw?.axis, [0, 0, 1]),
    limit: {
      enabled: bool(l.enabled, false),
      min: num(l.min, base.limit.min),
      max: num(l.max, base.limit.max),
    },
    motor: {
      ...base.motor,
      mode: ['off', 'velocity', 'position'].includes(m.mode) ? m.mode : 'off',
      targetVelocity: num(m.targetVelocity, base.motor.targetVelocity),
      targetPosition: num(m.targetPosition, base.motor.targetPosition),
      // -- steering: kept only when the file has one, so scenes without it save back unchanged --
      ...(m.targetPositionNeg !== undefined && Number.isFinite(Number(m.targetPositionNeg))
        ? { targetPositionNeg: num(m.targetPositionNeg, base.motor.targetPosition) }
        : {}),
      stiffness: Math.max(0, num(m.stiffness, base.motor.stiffness)),
      damping: Math.max(0, num(m.damping, base.motor.damping)),
      maxForce: Math.max(0, num(m.maxForce, base.motor.maxForce)),
      keyPos: str(m.keyPos, ''),
      keyNeg: str(m.keyNeg, ''),
      slewRate: Math.max(0, num(m.slewRate, base.motor.slewRate)),
      brake: bool(m.brake, true),
      // -- CM-A: kept only when the file has one, so scenes without an axis save back unchanged --
      ...(typeof m.axis === 'string'
        ? {
            axis:
              /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(m.axis) &&
              !/^(constructor|prototype|toString|valueOf|hasOwnProperty)$/.test(m.axis)
                ? m.axis
                : '',
          }
        : {}),
    },
    spring: {
      restLength: Math.max(0, num(s.restLength, base.spring.restLength)),
      stiffness: Math.max(0, num(s.stiffness, base.spring.stiffness)),
      damping: Math.max(0, num(s.damping, base.spring.damping)),
      breakForce: Math.max(0, num(s.breakForce, 0)),
    },
    ropeLength: Math.max(0.01, num(raw?.ropeLength, base.ropeLength)),
    collideConnected: bool(raw?.collideConnected, false),
    params: sanitizeParams(raw?.params), // -- JT-A --
    hidden: bool(raw?.hidden, false),
    ...outlinerMetaFields(raw ?? {}, true), // -- UI-A --
    components: sanitizeComponents(raw?.components, 'joint', report, 'a joint'),
    // -- JT-B: breakage thresholds --
    ...breakageField(raw?.breakage),
  };
}

// -- SF: attachments are untrusted JSON; cap their number and clamp every number --
function sanitizeAttachments(raw: any): SoftAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: SoftAttachment[] = [];
  for (const a of raw.slice(0, 64)) {
    if (!a || typeof a !== 'object' || typeof a.body !== 'string' || !a.body) continue;
    let id = idStr(a.id, `a${out.length + 1}`);
    while (out.some((x) => x.id === id)) id += '_';
    const att: SoftAttachment = {
      id,
      body: idStr(a.body, ''),
      kind: a.kind === 'rim' ? 'rim' : 'region',
      center: vec3(a.center, [0, 0, 0]),
      radius: clamp(num(a.radius, 0.1), 0.005, 5),
      offset: vec3(a.offset, [0, 0, 0]),
    };
    if (typeof a.joint === 'string' && a.joint) att.joint = idStr(a.joint, '');
    out.push(att);
  }
  return out;
}

function sanitizeSoft(raw: any, report?: LoadReport): SoftEntity {
  const type: SoftType = SOFTS.includes(raw?.type) ? raw.type : 'jelly';
  const base = createSoft(type);
  const d = softDefaults(type);
  const size = vec3(raw?.size, d.size).map((v, i) => (v <= 0 && d.size[i] === 0 ? 0 : clamp(v, 0.05, 100))) as Vec3;
  // -- SF: a document must not be able to ask the worker for billions of lattice cells --
  if (type === 'tyre') {
    size[0] = Math.min(size[0], 4);
    size[1] = clamp(size[1], 0.08, 2);
    size[2] = clamp(size[2], 0.06, 1);
  }
  if (type === 'mesh') for (let i = 0; i < 3; i++) size[i] = Math.min(size[i], 20);
  let cell = clamp(num(raw?.cell, d.cell), Math.min(1, Math.max(0.04, Math.max(...size) / 40)), 1);
  if (type === 'mesh') {
    // hard cap on the voxel lattice a document may ask for
    while (cell < 1 && softParticleCount({ type, size, resolution: 5, cell, pneumatic: true }) > 20000)
      cell = Math.min(1, cell * 1.15);
  }
  const maxRes =
    type === 'jelly'
      ? 10
      : type === 'balloon'
        ? 3
        : type === 'cloth'
          ? 40
          : type === 'tyre'
            ? 48
            : type === 'mesh'
              ? 10
              : 100;
  const minRes = type === 'balloon' ? 1 : type === 'cable' ? 4 : type === 'cloth' ? 4 : type === 'tyre' ? 8 : 3;
  return {
    ...base,
    id: idStr(raw?.id, base.id),
    name: nameStr(raw?.name, base.name),
    position: position3(raw?.position, [0, 1, 0]),
    rotation: quat(raw?.rotation),
    size,
    resolution: clamp(Math.round(num(raw?.resolution, d.resolution)), minRes, maxRes),
    mass: Math.max(0.01, num(raw?.mass, d.mass)),
    stiffness: clamp(num(raw?.stiffness, d.stiffness), 1, 400),
    damping: clamp(num(raw?.damping, d.damping), 0, 2),
    pin: PINS.includes(raw?.pin) ? raw.pin : 'none',
    tearStrain: Math.max(0, num(raw?.tearStrain, 0)),
    selfCollide: bool(raw?.selfCollide, false),
    gravityScale: num(raw?.gravityScale, 1),
    linearDamping: Math.max(0, num(raw?.linearDamping, d.linearDamping)),
    color: str(raw?.color, d.color),
    roughness: clamp(num(raw?.roughness, d.roughness), 0, 1),
    opacity: clamp(num(raw?.opacity, d.opacity), 0.05, 1),
    locked: bool(raw?.locked, false),
    hidden: bool(raw?.hidden, false),
    ...parentField(raw ?? {}),
    // -- SF --
    attachments: sanitizeAttachments(raw?.attachments),
    volumeFactor: clamp(num(raw?.volumeFactor, d.volumeFactor), 0.2, 3),
    volumePreserve: bool(raw?.volumePreserve, d.volumePreserve),
    leakRate: clamp(num(raw?.leakRate, 0), 0, 10),
    poisson: clamp(num(raw?.poisson, d.poisson), 0, 0.49),
    plasticYield: clamp(num(raw?.plasticYield, 0), 0, 5),
    friction: clamp(num(raw?.friction, d.friction), 0, 5),
    particleRadius: raw?.particleRadius === 0 ? 0 : clamp(num(raw?.particleRadius, 0), 0, 0.2),
    shape: sanitizeShapeSpec(raw?.shape ?? d.shape, report, 'a soft mesh'),
    cell,
    pneumatic: bool(raw?.pneumatic, d.pneumatic),
    ...outlinerMetaFields(raw ?? {}, true), // -- UI-A --
  };
}

/** One raw entity of any kind (null for an unknown kind, which is dropped). */
function sanitizeEntity(r: any, report: LoadReport | undefined): Entity | null {
  switch (r.kind) {
    case 'body':
      return sanitizeBody(r, report);
    case 'joint':
      return sanitizeJoint(r, report);
    case 'soft':
      return sanitizeSoft(r, report);
    case 'group':
      return sanitizeGroup(r);
    case 'light':
      return sanitizeLight(r);
    case 'path':
      return sanitizePath(r);
    default:
      return null;
  }
}

function sanitizeEnvironment(raw: any): EnvironmentSettings {
  const d = defaultEnvironment();
  const f = raw?.fog ?? {};
  const sun = raw?.sun ?? {};
  const cycle = raw?.cycle ?? {};
  const hdri = raw?.hdri ?? {};
  return {
    sky: oneOf(raw?.sky, SKIES, d.sky),
    timeOfDay: clamp(num(raw?.timeOfDay, d.timeOfDay), 0, 24),
    fog: {
      enabled: bool(f.enabled, d.fog.enabled),
      color: hexColor(f.color, d.fog.color),
      density: clamp(num(f.density, d.fog.density), 0, 1),
      type: oneOf(f.type, ['linear', 'exp', 'height'] as const, d.fog.type),
      near: clamp(num(f.near, d.fog.near), 0, 5000),
      far: clamp(num(f.far, d.fog.far), 1, 10000),
      height: clamp(num(f.height, d.fog.height), -1000, 1000),
      falloff: clamp(num(f.falloff, d.fog.falloff), 0.001, 10),
    },
    exposure: clamp(num(raw?.exposure, d.exposure), 0.1, 8),
    toneMapping: oneOf(raw?.toneMapping, ['aces', 'agx', 'neutral', 'linear'] as const, d.toneMapping),
    sun: {
      azimuth: clamp(num(sun.azimuth, d.sun.azimuth), 0, 360),
      elevation: clamp(num(sun.elevation, d.sun.elevation), -90, 90),
      intensity: clamp(num(sun.intensity, d.sun.intensity), 0, 10),
      turbidity: clamp(num(sun.turbidity, d.sun.turbidity), 1, 20),
      rayleigh: clamp(num(sun.rayleigh, d.sun.rayleigh), 0, 4),
    },
    cycle: {
      enabled: bool(cycle.enabled, d.cycle.enabled),
      hoursPerSecond: clamp(num(cycle.hoursPerSecond, d.cycle.hoursPerSecond), 0.01, 24),
    },
    hdri: {
      assetId: typeof hdri.assetId === 'string' && hdri.assetId ? idStr(hdri.assetId, '') : null,
      showBackground: bool(hdri.showBackground, d.hdri.showBackground),
      backgroundBlur: clamp(num(hdri.backgroundBlur, d.hdri.backgroundBlur), 0, 1),
      rotation: clamp(num(hdri.rotation, d.hdri.rotation), -360, 360),
      intensity: clamp(num(hdri.intensity, d.hdri.intensity), 0, 10),
    },
  };
}

function sanitizeBounds(raw: any): BoundsSettings {
  const d = defaultBounds();
  const lo = position3(raw?.min, d.min);
  const hi = position3(raw?.max, d.max);
  // Opposite corners may arrive in any order; a degenerate (zero-thickness) axis is opened up by a metre.
  const min = lo.map((v, i) => Math.min(v, hi[i])) as BoundsSettings['min'];
  const max = lo.map((v, i) => Math.max(v, hi[i])) as BoundsSettings['max'];
  for (let i = 0; i < 3; i++) if (max[i] - min[i] < 1e-3) max[i] = min[i] + 1;
  // -- ZN-34: per-face edges, the soft wall and the respawn policy (files without them get the plain kill box)
  const edgeKinds = ['open', 'kill', 'soft', 'water'] as const;
  const edges = raw?.edges ?? {};
  const soft = raw?.soft ?? {};
  const respawn = raw?.respawn ?? {};
  return {
    enabled: bool(raw?.enabled, d.enabled),
    min,
    max,
    policy: oneOf(raw?.policy, ['kill', 'respawn'], d.policy),
    edges: {
      nx: oneOf(edges.nx, edgeKinds, d.edges.nx),
      px: oneOf(edges.px, edgeKinds, d.edges.px),
      ny: oneOf(edges.ny, edgeKinds, d.edges.ny),
      py: oneOf(edges.py, edgeKinds, d.edges.py),
      nz: oneOf(edges.nz, edgeKinds, d.edges.nz),
      pz: oneOf(edges.pz, edgeKinds, d.edges.pz),
    },
    soft: {
      margin: clamp(num(soft.margin, d.soft.margin), 0.1, 1000),
      stiffness: clamp(num(soft.stiffness, d.soft.stiffness), 0, 10000),
      damping: clamp(num(soft.damping, d.soft.damping), 0, 1000),
    },
    respawn: {
      to: oneOf(respawn.to, ['start', 'checkpoint'], d.respawn.to),
      delay: clamp(num(respawn.delay, d.respawn.delay), 0, 600),
      penaltySeconds: clamp(num(respawn.penaltySeconds, d.respawn.penaltySeconds), 0, 3600),
      penaltyPoints: clamp(num(respawn.penaltyPoints, d.respawn.penaltyPoints), 0, 1_000_000),
      max: int(respawn.max, d.respawn.max, 0, 9999),
      wholeGroups: bool(respawn.wholeGroups, d.respawn.wholeGroups),
    },
  };
}

function sanitizeUnits(raw: any): UnitsSettings {
  const d = defaultUnits();
  return {
    length: oneOf(raw?.length, ['m', 'cm', 'ft', 'in'], d.length),
    mass: oneOf(raw?.mass, ['kg', 'g', 'lb'], d.mass),
    angle: oneOf(raw?.angle, ['deg', 'rad'], d.angle),
  };
}

function sanitizeSettings(raw: any): SceneSettings {
  const d = defaultSettings();
  const g = raw?.ground ?? {};
  return {
    gravity: vec3(raw?.gravity, d.gravity),
    ground: {
      enabled: bool(g.enabled, d.ground.enabled),
      friction: Math.max(0, num(g.friction, d.ground.friction)),
      restitution: clamp(num(g.restitution, d.ground.restitution), 0, 1.5),
      halfSize: clamp(num(g.halfSize, d.ground.halfSize), 5, 2000),
      color: str(g.color, d.ground.color),
      type: oneOf(g.type, ['grid', 'checker', 'plain', 'none', 'water'] as const, 'grid'),
      horizonBlend: clamp(num(g.horizonBlend, 0.5), 0, 1),
    },
    physicsHz: [60, 120, 240, 480].includes(raw?.physicsHz) ? raw.physicsHz : d.physicsHz,
    solverIterations: clamp(Math.round(num(raw?.solverIterations, d.solverIterations)), 1, 32),
    airDrag: Math.max(0, num(raw?.airDrag, 0)),
    seed: Math.floor(clamp(num(raw?.seed, d.seed), 0, 0xffffffff)),
    substeps: int(raw?.substeps, d.substeps, 1, 16),
    environment: sanitizeEnvironment(raw?.environment),
    bounds: sanitizeBounds(raw?.bounds),
    units: sanitizeUnits(raw?.units),
    selectionSets: sanitizeSelectionSets(raw?.selectionSets), // -- UI-A --
    ...sanitizeWeatherField(raw?.weather), // -- VZ-B: weather --
    // -- JT-B: collision layers --
    ...layersField(raw?.layers),
  };
}

/**
 * Validate + upgrade arbitrary parsed JSON into a well-formed SceneDocument. This is the single entry for
 * every way a scene reaches the app (file, autosave, library, share link, templates in tests).
 *
 * It runs the migration chain, enforces the size limits in `limits.ts` (throwing a `SceneFormatError` with
 * a user-facing message) and repairs everything else: unknown fields dropped, missing fields defaulted,
 * bad numbers clamped, joints referring to missing bodies removed. Pass a `report` to learn what was repaired.
 */
export function sanitizeDocument(input: any, report?: LoadReport): SceneDocument {
  const raw = migrateDocument(input) as any;
  if (raw.entities.length > LIMITS.maxEntities) {
    throw new SceneFormatError(
      'limit',
      `This scene has ${formatCount(raw.entities.length)} objects; PhysixLab opens scenes of up to ${formatCount(LIMITS.maxEntities)}. Split it into several scenes.`,
    );
  }
  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const r of raw.entities) {
    if (!r || typeof r !== 'object') continue;
    const e = sanitizeEntity(r, report);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    entities.push(e);
  }
  // More lights than the scene limit are dropped (every light costs the renderer a pass over every surface).
  let lights = 0;
  for (let i = 0; i < entities.length; i++) {
    if (!isLight(entities[i]) || ++lights <= LIMITS.maxLights) continue;
    entities.splice(i--, 1);
    warn(report, `Only ${LIMITS.maxLights} lights are kept per scene; the extra ones were removed.`);
  }
  // Drop group links that point nowhere (or loop).
  const parentsFixed = repairParents(entities.filter(isPosed));
  // -- ED-A array: a linked array whose source objects no longer exist cannot be re-generated; it becomes a plain group --
  for (let i = 0; i < entities.length; i++) {
    const g = entities[i];
    if (!isGroup(g) || !g.array) continue;
    if (g.array.sourceIds.every((id) => seen.has(id) && id !== g.id)) continue;
    const { array: _gone, ...rest } = g;
    entities[i] = rest;
    warn(report, `The linked array "${g.name}" lost its source object(s) and became an ordinary group.`);
  }
  // Component ids are unique across the scene, and references between entities must point at something.
  dedupeComponentIds(entities);
  if (parentsFixed) warn(report, `${parentsFixed} grouping link(s) pointed at missing objects and were removed.`);
  // Drop joints that reference bodies that do not exist.
  const bodyIds = new Set(entities.filter((e) => e.kind === 'body').map((e) => e.id));
  const clean = entities.filter(
    (e) =>
      e.kind !== 'joint' || ((e.bodyA === null || bodyIds.has(e.bodyA)) && (e.bodyB === null || bodyIds.has(e.bodyB))),
  );
  const refsCleared = repairComponentRefs(clean);
  if (refsCleared) warn(report, `${refsCleared} component reference(s) pointed at missing objects and were cleared.`);
  // Assets: validated, de-duplicated, and every entity reference repaired to match (merged twins follow the
  // kept asset; references to missing or wrong-kind assets are dropped).
  const { assets, remap } = sanitizeAssetMap(raw.assets, report);
  let droppedRefs = 0;
  const linked = remapAssetRefs(clean, (id, kind) => {
    const target = remap.get(id) ?? id;
    if (assets[target]?.kind === kind) return target;
    droppedRefs++;
    return undefined;
  });
  if (droppedRefs) warn(report, `${droppedRefs} reference(s) to missing or unusable assets were removed.`);
  const settings = sanitizeSettings(raw.settings);
  // -- VZ-A: the scene's HDRI is an asset reference held by the settings --
  const hid = settings.environment.hdri.assetId;
  if (hid) {
    const target = remap.get(hid) ?? hid;
    settings.environment.hdri.assetId = assets[target]?.kind === 'blob' ? target : null;
    if (settings.environment.hdri.assetId === null && settings.environment.sky === 'hdri')
      settings.environment.sky = 'studio';
  }
  return pruneAssets({
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    name: nameStr(raw.name, 'Untitled scene'),
    settings,
    entities: linked,
    assets,
    // -- CM-A: only when something is saved --
    ...(raw.cameras && !isDefaultCameras(sanitizeCameras(raw.cameras))
      ? { cameras: sanitizeCameras(raw.cameras) }
      : {}),
  });
}

/**
 * The scene as JSON text — what files, the autosave, the library and share links hold. Assets that nothing
 * references are left out (garbage collection on save). `indent` pretty-prints for human-readable exports.
 */
export function serializeDocument(doc: SceneDocument, indent?: number): string {
  return JSON.stringify(pruneAssets(doc), null, indent);
}

export function parseDocument(text: string, report?: LoadReport): SceneDocument {
  if (text.length > LIMITS.maxDocumentChars) {
    throw new SceneFormatError(
      'limit',
      `This file is ${formatBytes(text.length)}; PhysixLab opens scene files of up to ${formatBytes(LIMITS.maxDocumentChars)}.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SceneFormatError('invalid-json', 'File is not valid JSON.');
  }
  return sanitizeDocument(raw, report);
}

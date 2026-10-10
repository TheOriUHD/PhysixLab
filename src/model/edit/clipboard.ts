/**
 * The clipboard envelope (pure, no DOM, no store): a selection serialised to versioned JSON that can live in
 * localStorage and on the system clipboard, travel to another scene, tab or browser, and be pasted back through the
 * same sanitiser every scene goes through — so a hostile, damaged or old clipboard can never inject garbage.
 *
 *   { format: 'physicslab-clipboard', version: 1, sceneVersion, sceneName, origin, entities, assets, connections }
 *
 * `entities` are the copied objects with everything below a copied group and the joints between copied bodies.
 * `connections` lists the ids of joints (inside `entities`) that were attached to a body that was *not* copied: they
 * are stored re-attached to the world at that far end's original place ("rule: the far end becomes a world anchor at
 * the point where it was") and are only pasted by "Paste with connections".
 */
import { qrot, vadd, type Vec3, type Quat } from '../../core/math';
import type { LoadReport } from '../errors';
import { SceneFormatError, newReport, warn } from '../errors';
import { entityAssetRefs, remapAssetRefs } from '../assets';
import { LIMITS } from '../limits';
import { SCENE_FORMAT, SCENE_VERSION } from '../migrations';
import { sanitizeDocument } from '../serialize';
import { cloneEntities } from '../store';
import type { Asset, BodyEntity, Entity, JointEntity, PosedEntity } from '../types';
import { isBody, isJoint, isPosed } from '../types';

export const CLIPBOARD_FORMAT = 'physicslab-clipboard';
export const CLIPBOARD_VERSION = 1;
/** Largest clipboard text accepted / written (characters). localStorage allows ~5 MB in total. */
export const MAX_CLIPBOARD_CHARS = 3_000_000;

export interface ClipboardEnvelope {
  format: typeof CLIPBOARD_FORMAT;
  version: number;
  sceneVersion: number;
  sceneName: string;
  /** Centre of the copied bodies (or of the other posed objects when no body was copied). */
  origin: Vec3;
  entities: Entity[];
  assets: Record<string, Asset>;
  /** Ids of joints in `entities` whose far end was re-attached to the world (see the file comment). */
  connections: string[];
}

export interface PasteOptions {
  /** Put the centre of the clipboard here (x, z; the height stays). */
  at?: Vec3;
  /** Paste at the original coordinates (offset 0). Wins over `at`. */
  inPlace?: boolean;
  /** Also paste the joints that connected the copy to objects that were not copied (world anchors). */
  withConnections?: boolean;
}

/** Offset of a plain paste with no pointer position: just next to the original. */
export const DEFAULT_PASTE_OFFSET: Vec3 = [0.8, 0, 0.8];

export function clipboardCentre(entities: readonly Entity[]): Vec3 {
  const bodies = entities.filter(isBody);
  const anchors: PosedEntity[] = bodies.length ? bodies : entities.filter(isPosed);
  if (!anchors.length) return [0, 0, 0];
  const n = anchors.length;
  return [
    anchors.reduce((s, b) => s + b.position[0], 0) / n,
    anchors.reduce((s, b) => s + b.position[1], 0) / n,
    anchors.reduce((s, b) => s + b.position[2], 0) / n,
  ];
}

/**
 * Build the envelope for `ids`. `poseOf` returns the current (possibly simulated) pose of a body, used to put the far
 * end of a connection joint into world space. Null when the selection holds nothing copyable.
 */
export function buildClipboard(
  all: readonly Entity[],
  assets: Readonly<Record<string, Asset>>,
  ids: readonly string[],
  sceneName: string,
  poseOf?: (bodyId: string) => { position: Vec3; rotation: Quat } | null | undefined,
): ClipboardEnvelope | null {
  const src = new Set(collectSourceBodies(all, ids));
  // Joints that leave the clipboard get their far end re-attached to the world where it was. They are appended to the
  // source list so `cloneEntities` re-ids them with everything else; being last in the list they are the last joints
  // of its output, which is how they are told apart afterwards.
  const standIns: JointEntity[] = [];
  for (const j of all) {
    if (!isJoint(j)) continue;
    const aIn = j.bodyA !== null && src.has(j.bodyA);
    const bIn = j.bodyB !== null && src.has(j.bodyB);
    if (aIn === bIn) continue; // both inside (cloned anyway) or none inside
    const far = aIn ? j.bodyB : j.bodyA;
    if (far === null) continue; // already world-anchored on the far side: cloned anyway
    const farBody = all.find((e): e is BodyEntity => e.id === far && isBody(e));
    if (!farBody) continue;
    const pose = poseOf?.(far) ?? { position: farBody.position, rotation: farBody.rotation };
    const world = vadd(pose.position, qrot(pose.rotation, aIn ? j.anchorB : j.anchorA));
    // A hinge / slider axis lives in A's frame: when A is the far end it becomes a world axis.
    standIns.push(
      aIn
        ? { ...j, bodyB: null, anchorB: world }
        : { ...j, bodyA: null, anchorA: world, axis: qrot(pose.rotation, j.axis) },
    );
  }
  const entities = cloneEntities([...all, ...standIns], [...ids], [0, 0, 0]);
  if (!entities.some(isPosed)) return null;
  const connections = standIns.length ? entities.slice(-standIns.length).map((e) => e.id) : [];
  // Only the assets the copied objects reference.
  const used: Record<string, Asset> = {};
  for (const e of entities) for (const r of entityAssetRefs(e)) if (assets[r.id]) used[r.id] = assets[r.id];
  return {
    format: CLIPBOARD_FORMAT,
    version: CLIPBOARD_VERSION,
    sceneVersion: SCENE_VERSION,
    sceneName,
    origin: clipboardCentre(entities),
    entities,
    assets: used,
    connections,
  };
}

/** Ids of the bodies that `ids` brings along (a group brings everything below it). */
function collectSourceBodies(all: readonly Entity[], ids: readonly string[]): string[] {
  const parentOf = new Map<string, string | undefined>();
  for (const e of all) if (isPosed(e)) parentOf.set(e.id, e.parent);
  const selected = new Set(ids);
  const under = (id: string): boolean => {
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur !== undefined && !seen.has(cur)) {
      if (selected.has(cur)) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  };
  return all.filter((e) => isBody(e) && under(e.id)).map((e) => e.id);
}

export function serializeClipboard(env: ClipboardEnvelope): string {
  return JSON.stringify(env);
}

export interface ParsedClipboard {
  envelope: ClipboardEnvelope;
  /** Repairs the sanitiser made (empty for a clean clipboard). */
  report: LoadReport;
}

/** Is the text plausibly one of ours (cheap check before parsing)? */
export const looksLikeClipboard = (text: string): boolean =>
  text.length < MAX_CLIPBOARD_CHARS && text.includes(`"${CLIPBOARD_FORMAT}"`);

/**
 * Parse and sanitise clipboard text. Returns null when the text is not a PhysicsLab clipboard (any other text);
 * throws `SceneFormatError` with a user-facing message when it is one but cannot be used (too big, newer version).
 */
export function parseClipboard(text: string): ParsedClipboard | null {
  if (typeof text !== 'string' || !text.includes(CLIPBOARD_FORMAT)) return null;
  if (text.length > MAX_CLIPBOARD_CHARS) {
    throw new SceneFormatError('limit', 'The clipboard is too large to paste.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.format !== CLIPBOARD_FORMAT) return null;
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) {
    throw new SceneFormatError('invalid-version', 'The clipboard has an invalid format version.');
  }
  if (r.version > CLIPBOARD_VERSION) {
    throw new SceneFormatError(
      'too-new',
      `The clipboard was copied by a newer version of PhysicsLab (clipboard format v${r.version}). Reload the page to update.`,
    );
  }
  if (!Array.isArray(r.entities)) return null;
  if (r.entities.length > LIMITS.maxEntities) {
    throw new SceneFormatError('limit', 'The clipboard holds too many objects to paste.');
  }
  const report = newReport();
  const sceneVersion =
    typeof r.sceneVersion === 'number' && Number.isInteger(r.sceneVersion) && r.sceneVersion >= 1
      ? Math.min(r.sceneVersion, SCENE_VERSION)
      : 1;
  // The same sanitiser as every scene: wrap the payload in a document.
  const doc = sanitizeDocument(
    {
      format: SCENE_FORMAT,
      version: sceneVersion,
      name: typeof r.sceneName === 'string' ? r.sceneName : 'Clipboard',
      entities: r.entities,
      assets: r.assets && typeof r.assets === 'object' ? r.assets : {},
    },
    report,
  );
  const ids = new Set(doc.entities.map((e) => e.id));
  const connections = (Array.isArray(r.connections) ? r.connections : []).filter(
    (c): c is string => typeof c === 'string' && ids.has(c),
  );
  if (!doc.entities.some(isPosed)) return null;
  const dropped = r.entities.length - doc.entities.length;
  if (dropped > 0) warn(report, `${dropped} clipboard item(s) were not valid and were skipped.`);
  return {
    envelope: {
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      sceneVersion: SCENE_VERSION,
      sceneName: doc.name,
      origin: clipboardCentre(doc.entities),
      entities: doc.entities,
      assets: doc.assets,
      connections,
    },
    report,
  };
}

export interface PastePlan {
  entities: Entity[];
  /** Offset applied to the copies. */
  offset: Vec3;
  /** Asset ids (in the envelope) the pasted entities reference. */
  assetIds: string[];
}

/**
 * Fresh copies of the envelope's objects ready to add to a scene: new ids (components follow), names unique against
 * `takenNames`, shifted per `opts`. Asset ids are still the envelope's — the app layer adds the assets to the scene
 * and passes the id mapping to `remapPlanAssets`.
 */
export function planPaste(env: ClipboardEnvelope, takenNames: Iterable<string>, opts: PasteOptions = {}): PastePlan {
  const conn = new Set(env.connections);
  const list = opts.withConnections ? env.entities : env.entities.filter((e) => !conn.has(e.id));
  const posedIds = list.filter(isPosed).map((e) => e.id);
  const centre = clipboardCentre(list);
  const offset: Vec3 = opts.inPlace
    ? [0, 0, 0]
    : opts.at
      ? [opts.at[0] - centre[0], 0, opts.at[2] - centre[2]]
      : [...DEFAULT_PASTE_OFFSET];
  const taken = new Set(takenNames);
  const entities = cloneEntities(list, posedIds, offset).map((c) => {
    const base = c.name.replace(/ \d+$/, '');
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
    taken.add(name);
    return { ...c, name };
  });
  const assetIds = [...new Set(entities.flatMap((e) => entityAssetRefs(e).map((r) => r.id)))];
  return { entities, offset, assetIds };
}

/** The plan's entities with asset references passed through `map` (envelope asset id → id in the scene). */
export function remapPlanAssets(plan: PastePlan, map: ReadonlyMap<string, string>): Entity[] {
  return remapAssetRefs(plan.entities, (id) => map.get(id));
}

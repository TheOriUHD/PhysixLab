/**
 * Content registries — the three kinds of ready-made content the app ships and packages add to:
 *
 *   templates   whole example scenes ("Scenes" tab, File menu, command palette)
 *   prefabs     assemblies dropped into the current scene ("Prefabs" tab)
 *   maps        playable / explorable levels with richer metadata: category, difficulty, tags, objective,
 *               spawn point, opening camera and a thumbnail hook ("Maps" tab)
 *
 * All of them are built from the same public primitives the user has (bodies, joints, … via the `Builder` DSL
 * in `../builder.ts`); nothing here is special-cased anywhere.
 *
 * **Adding content = dropping a file** into `src/model/content/` that calls `registerTemplate` /
 * `registerPrefab` / `registerMap`. `./index.ts` imports every file of the folder (`import.meta.glob`, eager), so
 * no list has to be edited. Always import the registry API from `model/content` (the index), never from this
 * file: the index is what guarantees the folder has been collected.
 */
import type { Vec3 } from '../../core/math';
import { Registry, type RegistryChange } from '../../core/registry';
import type { Entity, SceneDocument } from '../types';

// ── templates ───────────────────────────────────────────────────────────────────────────────────────

/** Categories the Scenes tab knows how to order; a template may name any other string. */
export const TEMPLATE_CATEGORY_ORDER = [
  'Vehicles',
  'Mechanisms',
  'Soft bodies',
  'Physics labs',
  'Structures',
  'Playground',
] as const;

export interface TemplateInfo {
  id: string;
  name: string;
  /** Group heading in the Scenes tab: one of `TEMPLATE_CATEGORY_ORDER` or a new one (listed after those). */
  category: string;
  blurb: string;
  /** Short hint shown after loading. */
  hint: string;
  /** Optional opening camera. */
  view?: { position: [number, number, number]; target: [number, number, number] };
  /** Name of a body to select and follow with the camera while simulating. */
  follow?: string;
  build(): SceneDocument;
}

// ── prefabs ─────────────────────────────────────────────────────────────────────────────────────────

export interface PrefabInfo {
  id: string;
  name: string;
  /** Key of `src/ui/icons.ts`. */
  icon: string;
  blurb: string;
  /** Group heading in the Prefabs tab (default: "Insert an assembly"). */
  category?: string;
  /** Entities around the origin, standing on the ground. They are re-identified when inserted. */
  build(): Entity[];
}

// ── maps ────────────────────────────────────────────────────────────────────────────────────────────

/** `sandbox` = free play without a goal. */
export type MapDifficulty = 'sandbox' | 'easy' | 'medium' | 'hard' | 'expert';

export const MAP_DIFFICULTIES: readonly MapDifficulty[] = ['sandbox', 'easy', 'medium', 'hard', 'expert'];

export const MAP_DIFFICULTY_LABELS: Record<MapDifficulty, string> = {
  sandbox: 'Free play',
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  expert: 'Expert',
};

export interface MapInfo {
  id: string;
  name: string;
  /** One or two sentences for the card. */
  description: string;
  /** Group / filter in the Maps tab: "Arenas", "Racing", "Puzzles" … */
  category: string;
  difficulty: MapDifficulty;
  tags: readonly string[];
  /** What the player is supposed to do (or that there is nothing to win); shown when the map loads. */
  objective: string;
  /** Key of `src/ui/icons.ts` for the card when no thumbnail is available. */
  icon?: string;
  /**
   * Preview image: a URL / data URL, or a function producing one lazily (the offscreen thumbnail renderer of the
   * Maps package plugs in here). A function may be async and is called at most once per tab render.
   */
  thumbnail?: string | (() => string | Promise<string>);
  /** Where players, vehicles and spawned objects start; `yaw` is the heading in radians about +Y. */
  spawn: { position: Vec3; yaw?: number };
  /** Opening camera. */
  camera: { position: Vec3; target: Vec3 };
  build(): SceneDocument;
}

// ── registries ──────────────────────────────────────────────────────────────────────────────────────

function needText(kind: string, id: string, field: string, v: unknown): void {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${kind} "${id}": ${field} must not be empty`);
}

function needVec3(kind: string, id: string, field: string, v: readonly number[] | undefined): void {
  if (!v || v.length !== 3 || !v.every(Number.isFinite)) throw new Error(`${kind} "${id}": ${field} must be 3 numbers`);
}

const templates = new Registry<TemplateInfo>({
  kind: 'template',
  validate(t) {
    needText('template', t.id, 'name', t.name);
    needText('template', t.id, 'category', t.category);
    needText('template', t.id, 'hint', t.hint);
    if (typeof t.build !== 'function') throw new Error(`template "${t.id}" needs a build() function`);
    if (t.view) {
      needVec3('template', t.id, 'view.position', t.view.position);
      needVec3('template', t.id, 'view.target', t.view.target);
    }
  },
});

const prefabs = new Registry<PrefabInfo>({
  kind: 'prefab',
  validate(p) {
    needText('prefab', p.id, 'name', p.name);
    needText('prefab', p.id, 'icon', p.icon);
    if (typeof p.build !== 'function') throw new Error(`prefab "${p.id}" needs a build() function`);
  },
});

const maps = new Registry<MapInfo>({
  kind: 'map',
  validate(m) {
    needText('map', m.id, 'name', m.name);
    needText('map', m.id, 'description', m.description);
    needText('map', m.id, 'category', m.category);
    needText('map', m.id, 'objective', m.objective);
    if (!MAP_DIFFICULTIES.includes(m.difficulty))
      throw new Error(`map "${m.id}": difficulty must be one of ${MAP_DIFFICULTIES.join(', ')}`);
    if (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string' || !t.trim()))
      throw new Error(`map "${m.id}": tags must be a list of non-empty strings`);
    needVec3('map', m.id, 'spawn.position', m.spawn?.position);
    if (m.spawn.yaw !== undefined && !Number.isFinite(m.spawn.yaw))
      throw new Error(`map "${m.id}": spawn.yaw must be a number`);
    needVec3('map', m.id, 'camera.position', m.camera?.position);
    needVec3('map', m.id, 'camera.target', m.camera?.target);
    if (typeof m.build !== 'function') throw new Error(`map "${m.id}" needs a build() function`);
  },
});

/** Add an example scene. Returns the function that removes it again. */
export const registerTemplate = (t: TemplateInfo): (() => void) => templates.register(t);
export const registerPrefab = (p: PrefabInfo): (() => void) => prefabs.register(p);
export const registerMap = (m: MapInfo): (() => void) => maps.register(m);

export const unregisterTemplate = (id: string): boolean => templates.unregister(id);
export const unregisterPrefab = (id: string): boolean => prefabs.unregister(id);
export const unregisterMap = (id: string): boolean => maps.unregister(id);

export const getTemplate = (id: string): TemplateInfo | undefined => templates.get(id);
export const getPrefab = (id: string): PrefabInfo | undefined => prefabs.get(id);
export const getMap = (id: string): MapInfo | undefined => maps.get(id);

/** Registration order (for the built-ins: the order of the files, then of the entries). */
export const listTemplates = (): readonly TemplateInfo[] => templates.list();
export const listPrefabs = (): readonly PrefabInfo[] => prefabs.list();
export const listMaps = (): readonly MapInfo[] => maps.list();

export interface ContentChange extends RegistryChange {
  kind: 'template' | 'prefab' | 'map';
}

/** Listen for content being registered or removed (the library tabs re-render on it). */
export function onContentChange(fn: (c: ContentChange) => void): () => void {
  const subs = [
    templates.onChange((c) => fn({ ...c, kind: 'template' })),
    prefabs.onChange((c) => fn({ ...c, kind: 'prefab' })),
    maps.onChange((c) => fn({ ...c, kind: 'map' })),
  ];
  return () => subs.forEach((off) => off());
}

/** Template categories in display order: the well-known ones first, then any others alphabetically. */
export function templateCategories(): string[] {
  const known: readonly string[] = TEMPLATE_CATEGORY_ORDER;
  const present = new Set(templates.list().map((t) => t.category));
  const first = known.filter((c) => present.has(c));
  const rest = [...present].filter((c) => !known.includes(c)).sort((a, b) => a.localeCompare(b));
  return [...first, ...rest];
}

/** Map categories alphabetically. */
export function mapCategories(): string[] {
  return [...new Set(maps.list().map((m) => m.category))].sort((a, b) => a.localeCompare(b));
}

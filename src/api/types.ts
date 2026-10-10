/**
 * DT-30: the public, versioned `window.physicslab` API.
 *
 * Semver: `apiVersion` is `MAJOR.MINOR.PATCH`. Additions bump MINOR, behaviour fixes PATCH, any removal or change of
 * meaning of a documented member bumps MAJOR. Everything here exchanges plain JSON-compatible data (documents,
 * entities, vectors) — never live objects — so callers cannot corrupt editor state. Anything on `window.physicslab`
 * that is not declared in this file (`store`, `editor`, `viewport`, …) is internal and may change at any time.
 *
 * Documented with runnable examples in docs/API.md (a test keeps the two in sync).
 */
import type { Vec3, Quat } from '../core/math';
import type { Asset, AssetInput, Entity, SceneDocument, SceneSettings } from '../model/types';

export const API_VERSION = '1.0.0';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type SimMode = 'edit' | 'paused' | 'running';
export type Unsubscribe = () => void;

/** Fields you may pass when creating a body; everything else gets the usual defaults. */
export type EntityPatch = Record<string, unknown>;

export interface ApiEvents {
  /** The document changed (any edit, undo, redo, load). */
  'scene:change': { type: 'add' | 'remove' | 'update' | 'settings' | 'assets' | 'reset'; ids: string[] };
  /** The selection changed. */
  'selection:change': { ids: string[] };
  /** Simulation mode changed. */
  'sim:mode': { mode: SimMode };
  /** A joint broke during a simulation. */
  'sim:broken': { id: string; force: number };
  /** A command or API call asked for a toast (info, success, warn, error). */
  toast: { text: string; kind: string };
}

export interface SceneApi {
  /** A deep copy of the whole document (entities, settings, assets). */
  get(): SceneDocument;
  /** The document as JSON text. */
  toJSON(indent?: number): string;
  /** Replace the scene with a document or its JSON text (validated and migrated like a file open). Undoable. */
  load(docOrJson: SceneDocument | string): { name: string; entities: number };
  /** Remove everything and start a new empty scene. */
  clear(): void;
  name(): string;
  setName(name: string): void;
  /** Copies of entities, optionally filtered by kind, name (exact) or tag. */
  entities(filter?: { kind?: Entity['kind']; name?: string; tag?: string }): Entity[];
  entity(id: string): Entity | null;
  /** Add entities (validated; joints may refer to ids already in the scene or added in the same call). Returns their ids. */
  add(entities: EntityPatch[]): string[];
  /** Add a body from a shape id, e.g. `addBody('box', [0, 2, 0], { name: 'Crate' })`. Returns its id. */
  addBody(shape: string, position?: Vec3, fields?: EntityPatch): string;
  /** Merge `fields` into an entity (validated). Returns false if the id is unknown. */
  update(id: string, fields: EntityPatch): boolean;
  remove(ids: string[]): void;
  select(ids: string[]): void;
  selection(): string[];
  /** Patch scene settings (gravity, physicsHz, …). */
  settings(patch?: Partial<SceneSettings>): SceneSettings;
  undo(): string | null;
  redo(): string | null;
  /** Run `fn` so that all its edits form ONE undo step. */
  batch<T>(label: string, fn: () => T): T;
}

export interface SimulationApi {
  readonly mode: SimMode;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Advance `count` fixed steps (default 1); starts a paused simulation if none exists. */
  step(count?: number): void;
  /** Stop and return to the authored layout. */
  reset(): void;
  timeScale(value?: number): number;
  /** Latest worker statistics (null before the first frame / in edit mode). */
  stats(): { simTime: number; stepCount: number; bodies: number; awake: number; contacts: number } | null;
}

export interface QueryApi {
  /** Pose of a body: live while simulating, authored otherwise. */
  pose(id: string): { position: Vec3; rotation: Quat } | null;
  /** Linear / angular velocity of a body (only while simulating). */
  velocity(id: string): { linear: Vec3; angular: Vec3 } | null;
  /** Nearest hit along a ray in the running simulation (resolves null when nothing is hit or not simulating). */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance?: number,
  ): Promise<{ id: string; distance: number; point: Vec3 } | null>;
}

export interface ViewApi {
  get(): { position: Vec3; target: Vec3 };
  set(view: { position: Vec3; target: Vec3 }): void;
  frameAll(): void;
  frameSelection(): void;
}

export interface ToolsApi {
  list(): { id: string; label: string }[];
  /** Current pointer tool id. */
  current(): string;
  set(id: string): void;
}

export interface ActionsApi {
  list(): { id: string; label: string; category: string }[];
  /** Run a registered command by id; false if unknown or disabled. */
  run(id: string): boolean;
}

export interface ExportApi {
  /** The scene as JSON text (same as `scene.toJSON`). */
  json(indent?: number): string;
  /** A PNG of the current viewport. */
  png(): Promise<Blob>;
}

export interface AssetsApi {
  /** Metadata of every asset (no payloads). */
  list(): { id: string; kind: Asset['kind']; name: string; bytes: number; refs: number }[];
  add(input: AssetInput): string;
  remove(id: string): boolean;
}

export interface PhysicsLabApi {
  readonly apiVersion: string;
  readonly scene: SceneApi;
  readonly simulation: SimulationApi;
  readonly query: QueryApi;
  readonly view: ViewApi;
  readonly tools: ToolsApi;
  /** Registered commands (everything in the command palette). */
  readonly actions: ActionsApi;
  readonly export: ExportApi;
  readonly assets: AssetsApi;
  /** Subscribe to an event; returns the function that unsubscribes. */
  on<K extends keyof ApiEvents>(event: K, handler: (payload: ApiEvents[K]) => void): Unsubscribe;
}

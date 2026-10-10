/**
 * Shared helpers for the Vitest suites (`tests/*.test.ts`).
 *
 * The suites run the real Rapier engine in Node (see `vitest.config.ts`): there is no mocking of physics,
 * so every test builds an actual `PhysicsWorld` from a scene document and steps it deterministically.
 *
 *  - `docOf(entities, settingsPatch?)`  builds a `SceneDocument` named "test" from entities, optionally
 *    overriding scene settings (gravity, physicsHz, ground, ...).
 *  - `worldOf(entities, settingsPatch?)` = `PhysicsWorld.create(docOf(...))`; awaits the WASM init.
 *  - `run(world, seconds)`               steps the world `seconds * settings.physicsHz` fixed steps.
 *    It calls `stepOnce()` directly, so no accumulator or interpolation is involved: results are
 *    reproducible and independent of wall-clock time.
 *  - `createBody` / `createJoint`        re-exported from the model factory so a test file needs one import.
 *
 * Conventions for new tests: assert against analytic expectations (free fall, T = 2*pi*sqrt(m/k), momentum
 * conservation ...) with an explicit tolerance rather than "it did not throw"; keep scenes small; use
 * `process.stderr.write` (not `console.log`, which Vitest swallows) for debugging output.
 */
import { newDocument, createBody, createJoint } from '../src/model/factory';
import { PhysicsWorld } from '../src/physics/world';
import type { Entity, SceneDocument } from '../src/model/types';

export function docOf(
  entities: Entity[],
  patch: Partial<SceneDocument['settings']> = {},
): SceneDocument {
  const d = newDocument('test');
  d.settings = { ...d.settings, ...patch };
  d.entities = entities;
  return d;
}

export async function worldOf(
  entities: Entity[],
  patch: Partial<SceneDocument['settings']> = {},
): Promise<PhysicsWorld> {
  return PhysicsWorld.create(docOf(entities, patch));
}

export function run(w: PhysicsWorld, seconds: number): void {
  const n = Math.round(seconds * w.settings.physicsHz);
  for (let i = 0; i < n; i++) w.stepOnce();
}

export { createBody, createJoint };

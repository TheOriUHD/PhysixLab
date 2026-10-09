import { newDocument, createBody, createJoint } from '../src/model/factory';
import { PhysicsWorld } from '../src/physics/world';
import type { BodyEntity, JointEntity, SceneDocument, SoftEntity } from '../src/model/types';

export function docOf(entities: (BodyEntity | JointEntity | SoftEntity)[], patch: Partial<SceneDocument['settings']> = {}): SceneDocument {
  const d = newDocument('test');
  d.settings = { ...d.settings, ...patch };
  d.entities = entities;
  return d;
}

export async function worldOf(entities: (BodyEntity | JointEntity | SoftEntity)[], patch: Partial<SceneDocument['settings']> = {}): Promise<PhysicsWorld> {
  return PhysicsWorld.create(docOf(entities, patch));
}

export function run(w: PhysicsWorld, seconds: number): void {
  const n = Math.round(seconds * w.settings.physicsHz);
  for (let i = 0; i < n; i++) w.stepOnce();
}

export { createBody, createJoint };

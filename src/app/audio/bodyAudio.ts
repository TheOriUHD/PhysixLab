/**
 * What the sound needs to know about a body, derived from its document entry: the material it sounds like, how big it
 * is (big bodies ring lower), whether it can roll, and the shape's ground-contact geometry. Pure functions over the
 * document model, unit-tested without an app.
 */
import { shapeDef } from '../../model/shapeRegistry';
import type { BodyEntity } from '../../model/types';
import { soundProfileFor, type SoundClass } from '../../audio/materials';
import { contactSpecOf, type ContactSpec } from '../../render/fx/slip';

export interface AudioBodyInfo {
  id: string;
  /** Material preset id (what `soundProfileFor` looks up). */
  preset: string;
  cls: SoundClass;
  /** Characteristic size, metres: the longest side of the shape (a ball's diameter), within 0.02 … 30. */
  size: number;
  /** Round (sphere, cylinder, capsule, cone): rolls rather than slides. */
  rounded: boolean;
  /** Takes part in rolling / sliding sound: a dynamic, visible, solid body. */
  rolls: boolean;
  spec: ContactSpec;
  /** A springy surface: tagged as a trampoline, or a restitution of 1 or more. */
  trampoline: boolean;
  /** Fired by the projectile tool. */
  projectile: boolean;
  /** A physical debris fragment spawned by the effects (never a source of sound of its own). */
  fragment: boolean;
}

export const TRAMPOLINE_TAGS: readonly string[] = ['trampoline', 'bouncy', 'bouncer'];

const ROUND = new Set(['sphere', 'cylinder', 'capsule', 'cone']);

export const isTrampoline = (def: BodyEntity): boolean =>
  def.tags.some((t) => TRAMPOLINE_TAGS.includes(t.toLowerCase())) || def.material.restitution >= 1;

export function characteristicSize(def: BodyEntity): number {
  const [x, y, z] = def.shape.size;
  return Math.min(30, Math.max(0.02, Math.max(x, y, z)));
}

export function audioBodyInfo(def: BodyEntity): AudioBodyInfo {
  const preset = def.material.preset;
  return {
    id: def.id,
    preset,
    cls: soundProfileFor(preset).cls,
    size: characteristicSize(def),
    rounded: ROUND.has(shapeDef(def.shape.type).id),
    rolls: def.bodyType === 'dynamic' && !def.hidden && !def.ghost,
    spec: contactSpecOf(def.shape),
    trampoline: isTrampoline(def),
    projectile: def.tags.includes('projectile'),
    fragment: def.tags.includes('fx-debris'),
  };
}

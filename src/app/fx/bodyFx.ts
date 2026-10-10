/**
 * What the effects need to know about a body, derived from its document entry: the shape's ground-contact geometry,
 * its surface (material), whether it is wheel-like, how wide a mark it leaves. Pure functions over the document
 * model, so the wheel detection and the sizes are unit-tested without an app.
 */
import { shapeDef } from '../../model/shapeRegistry';
import type { BodyEntity, JointEntity } from '../../model/types';
import { contactSpecOf, type ContactSpec } from '../../render/fx/slip';
import { surfaceFor, type FxSurface } from '../../render/fx/surfaces';

export interface BodyFxInfo {
  id: string;
  spec: ContactSpec;
  surface: FxSurface;
  /** Round, free to spin about an axle: tyre smoke and a narrower slip threshold apply. */
  wheel: boolean;
  /** Width of the contact patch, metres. */
  width: number;
  /** Characteristic size, metres (a wheel's diameter, a box's longest side, capped). */
  size: number;
  /** Takes part in trails: a dynamic, visible, solid body. */
  trails: boolean;
  /** Fired by the projectile tool. */
  projectile: boolean;
  /** A physical debris fragment spawned by the effects (never a source of further effects). */
  fragment: boolean;
  /** Number the skid-mark strips of this body are keyed by. */
  skidKey: number;
}

export const FRAGMENT_TAG = 'fx-debris';
export const PROJECTILE_TAG = 'projectile';

const WHEEL_NAME = /wheel|tyre|tire/i;

/** Ids of the bodies on either end of a hinge: the candidates for being a wheel (an axle turns about a hinge). */
export function hingedBodies(joints: readonly JointEntity[]): Set<string> {
  const out = new Set<string>();
  for (const j of joints) {
    if (j.type !== 'hinge') continue;
    if (j.bodyA) out.add(j.bodyA);
    if (j.bodyB) out.add(j.bodyB);
  }
  return out;
}

/** Wheel-like: a cylinder or ball that is tagged / named as a wheel, or a cylinder that turns about a hinge. */
export function isWheelLike(def: BodyEntity, hinged: ReadonlySet<string>): boolean {
  const id = shapeDef(def.shape.type).id;
  if (id !== 'cylinder' && id !== 'sphere') return false;
  if (def.tags.some((t) => t === 'wheel' || t === 'tyre' || t === 'tire') || WHEEL_NAME.test(def.name)) return true;
  return id === 'cylinder' && hinged.has(def.id);
}

/** Width of the patch a body leaves on the ground. */
export function trackWidth(def: BodyEntity, wheel: boolean): number {
  const [x, y, z] = def.shape.size;
  const id = shapeDef(def.shape.type).id;
  if (wheel && id === 'cylinder') return y; // the tread: the axle length
  if (id === 'sphere') return Math.min(0.3, Math.max(0.06, x * 0.25));
  return Math.min(0.9, Math.max(0.06, Math.min(x, y, z) * 0.7));
}

export function bodyFxInfo(def: BodyEntity, hinged: ReadonlySet<string>, skidKey: number): BodyFxInfo {
  const wheel = isWheelLike(def, hinged);
  const [x, y, z] = def.shape.size;
  const color = def.material.color;
  return {
    id: def.id,
    spec: contactSpecOf(def.shape),
    surface: surfaceFor(def.material.preset, color),
    wheel,
    width: trackWidth(def, wheel),
    size: Math.min(3, wheel ? Math.max(x, z) : Math.max(x, y, z)),
    trails: def.bodyType === 'dynamic' && !def.hidden && !def.ghost,
    projectile: def.tags.includes(PROJECTILE_TAG),
    fragment: def.tags.includes(FRAGMENT_TAG),
    skidKey,
  };
}

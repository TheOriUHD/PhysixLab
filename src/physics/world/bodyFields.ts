/**
 * Engine-side meaning of the per-body fields added in format v2: collision filtering (→ Rapier interaction
 * groups) and the mass-property overrides (`massOverride`, `comOverride`, `inertiaScale`). Quadratic drag and
 * the sleep threshold run every step and live in `dynamics.ts`.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { ALL_GROUPS } from '../../model/factory';
import { effectiveMask, type CollisionLayers } from '../../model/collisionLayers';
import type { BodyEntity, CollisionSpec } from '../../model/types';
import { rv } from './util';

/**
 * Rapier interaction groups: membership bit in the high 16 bits, filter in the low 16. Two colliders interact
 * when each one's membership intersects the other's filter.
 */
export function interactionGroups(c: CollisionSpec, layers?: CollisionLayers): number {
  // -- JT-B: the scene's layer matrix limits the filter --
  return (((1 << c.group) << 16) | effectiveMask(c, layers)) >>> 0;
}

/** The ground slab is a member of group 0 and accepts every group (the scene matrix still applies to layer 0). */
export function groundGroups(layers?: CollisionLayers): number {
  return interactionGroups({ group: 0, mask: ALL_GROUPS }, layers);
}
export const GROUND_GROUPS = groundGroups();

/** True when the body overrides what the shape's density would give. */
export function hasMassOverride(def: BodyEntity): boolean {
  return (
    def.bodyType === 'dynamic' &&
    ((def.massOverride !== undefined && def.massOverride > 0) ||
      def.comOverride !== undefined ||
      def.inertiaScale !== 1)
  );
}

/**
 * Apply `massOverride` / `comOverride` / `inertiaScale` to a freshly built dynamic body whose colliders carry
 * their natural densities.
 *
 *  - mass only: the colliders' densities are scaled, so the engine still integrates the true mass distribution
 *    (centre of mass and inertia tensor keep the shape's proportions);
 *  - centre of mass and / or inertia scale: the colliders stop contributing and the engine is given explicit
 *    mass properties — the natural mass (or the override), the requested centre of mass, and the natural
 *    principal inertia (about the centre of mass, as in most engines it is *not* re-derived for the new point)
 *    scaled by `inertiaScale` and by the mass ratio.
 *
 * Call it after the colliders are attached; it leaves `rb.mass()` equal to the effective mass.
 */
export function applyMassOverrides(rb: RAPIER.RigidBody, cols: RAPIER.Collider[], def: BodyEntity): void {
  if (!hasMassOverride(def)) return;
  const natural = rb.mass();
  if (!(natural > 0)) return; // massless colliders (zero density): nothing to scale
  const mass = def.massOverride !== undefined && def.massOverride > 0 ? def.massOverride : natural;
  const k = mass / natural;
  if (def.comOverride === undefined && def.inertiaScale === 1) {
    for (const c of cols) c.setDensity(c.density() * k);
    rb.recomputeMassPropertiesFromColliders();
    return;
  }
  const inertia = rb.principalInertia();
  const frame = rb.principalInertiaLocalFrame();
  const com = def.comOverride !== undefined ? rv(def.comOverride) : rb.localCom();
  const f = k * def.inertiaScale;
  for (const c of cols) c.setDensity(0);
  rb.setAdditionalMassProperties(mass, com, { x: inertia.x * f, y: inertia.y * f, z: inertia.z * f }, frame, false);
  rb.recomputeMassPropertiesFromColliders();
}

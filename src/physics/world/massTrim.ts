/**
 * Changing a body's mass while the simulation runs (a rocket burning fuel, a hopper emptying, a payload dropped).
 *
 * The engine takes a body's mass properties from its colliders' densities plus an optional "additional" part. To set
 * an exact total without remembering how the body got there, the colliders stop contributing and the *whole* mass
 * property set is given explicitly — the new total, the current centre of mass and the current principal inertia
 * scaled by the same factor (mass distribution unchanged, only its amount). The engine's snapshot contains these
 * properties, so a restored world has the right mass without any help from the component that changed it.
 */
import type { BodyRec } from './state';

export function setTotalMass(rec: BodyRec, total: number): void {
  const rb = rec.rb;
  if (rec.def.bodyType !== 'dynamic' || rec.disabled || !(total > 0) || !Number.isFinite(total)) return;
  const mass = rb.mass();
  if (!(mass > 0) || Math.abs(total - mass) <= 1e-12 * mass) return;
  const k = total / mass;
  const inertia = rb.principalInertia();
  const frame = rb.principalInertiaLocalFrame();
  const com = rb.localCom();
  for (const c of rec.cols) c.setDensity(0);
  rb.setAdditionalMassProperties(total, com, { x: inertia.x * k, y: inertia.y * k, z: inertia.z * k }, frame, false);
  rb.recomputeMassPropertiesFromColliders();
  rec.mass = rb.mass();
}

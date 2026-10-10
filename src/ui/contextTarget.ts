// -- ED-B: where the user right-clicked (side-effect free, so main.ts may import it before the extensions load) --
import type { Vec3 } from '../core/math';

let contextTarget: Vec3 | null = null;

/** World point under the pointer when the context menu was opened (null: unknown). */
export const setContextTarget = (p: Vec3 | null): void => {
  contextTarget = p;
};
export const getContextTarget = (): Vec3 | null => contextTarget;

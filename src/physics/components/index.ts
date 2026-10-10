/**
 * The built-in component runtimes. To add one: create `<type>.ts` next to this file exporting a `ComponentRuntime`
 * and add it to the list below (its `ComponentDef` goes in `src/model/components/`).
 */
import { constantForce } from './constantForce';
import { registerRuntime, runtimeOf } from './registry';
import { sineMover } from './sineMover';
import { zone } from './zone'; // -- ZN

for (const rt of [constantForce, sineMover]) if (!runtimeOf(rt.type)) registerRuntime(rt);
if (!runtimeOf(zone.type)) registerRuntime(zone); // -- ZN

export { registerRuntime, runtimeOf, type ComponentRuntime } from './registry';
export type { BodyHandle, ComponentContext, ContactPoint, JointHandle } from './context';

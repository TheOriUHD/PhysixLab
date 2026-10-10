/**
 * The built-in component runtimes. To add one: create `<type>.ts` next to this file exporting a `ComponentRuntime`
 * and add it to the list below (its `ComponentDef` goes in `src/model/components/`).
 */
import { constantForce } from './constantForce';
import { registerRuntime, runtimeOf } from './registry';
import { sineMover } from './sineMover';
import { POWERED_RUNTIMES } from './poweredIndex'; // -- CP

for (const rt of [constantForce, sineMover, ...POWERED_RUNTIMES]) if (!runtimeOf(rt.type)) registerRuntime(rt);

export { registerRuntime, runtimeOf, type ComponentRuntime } from './registry';
export type { BodyHandle, ComponentContext, ContactPoint, JointHandle } from './context';

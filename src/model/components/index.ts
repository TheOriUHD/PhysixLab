/**
 * The built-in component definitions, in menu order. To add one: create `<type>.ts` next to these files exporting a
 * `ComponentDef` (and a runtime under `src/physics/components/`), then add it to the array below.
 */
import type { ComponentDef } from '../componentRegistry';
import { constantForce } from './constantForce';
import { sineMover } from './sineMover';

export const BUILTIN_COMPONENTS: readonly ComponentDef[] = [constantForce, sineMover];

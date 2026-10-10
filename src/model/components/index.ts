/**
 * The built-in component definitions, in menu order. To add one: create `<type>.ts` next to these files exporting a
 * `ComponentDef` (and a runtime under `src/physics/components/`), then add it to the array below.
 */
import type { ComponentDef } from '../componentRegistry';
import { constantForce } from './constantForce';
import { sineMover } from './sineMover';
import { zone } from './zone'; // -- ZN
import { POWERED_COMPONENTS } from './poweredIndex'; // -- CP

export const BUILTIN_COMPONENTS: readonly ComponentDef[] = [constantForce, sineMover, zone, ...POWERED_COMPONENTS]; // -- ZN, CP

/** Registers the built-in skins (imported once by the renderer). */
import { skinRegistry } from './registry';
import type { SkinDef } from './types';
import { CAR_SKINS } from './car';

const ALL: SkinDef[] = [...CAR_SKINS];

for (const s of ALL) if (!skinRegistry.get(s.id)) skinRegistry.register(s);

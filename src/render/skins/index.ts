/** Registers the built-in skins (imported once by the renderer). */
import { skinRegistry } from './registry';
import type { SkinDef } from './types';

const ALL: SkinDef[] = [];

for (const s of ALL) if (!skinRegistry.get(s.id)) skinRegistry.register(s);
